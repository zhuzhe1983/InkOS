import {
  displayMetaSchema,
  type DisplayMeta,
} from "../rendering/contracts";
import { renderEngine, type RenderEngine } from "../rendering/engine";
import { getScreenProfile, orientScreenProfile } from "../rendering/profiles";
import { buildInkArchive, encodeInkJson, sha256Hex } from "./archive";
import {
  inkDisplayVariantSchema,
  inkPackageManifestSchema,
  inkUuidSchema,
  packagedDocumentSchema,
  type InkCapability,
  type InkDisplayVariant,
  type InkPackageManifest,
  type PackagedDocument,
} from "./contracts";
import { expandImagePreviewDocuments } from "./image-previews";
import { feedDetailFallbackUrlsForDocuments, frameSidecar } from "./sidecar";
import { inkVariantId } from "./variants";

const DEFAULT_CAPABILITIES: InkCapability[] = [
  "navigation.parent-v1",
  "navigation.hitbox-v1",
  "display.font-level-v1",
  "device.settings-v1",
  "content-ota.atomic-v1",
];

export interface InkPackageBuildInput {
  packageId: string;
  slug: string;
  revision: number;
  title: string;
  entryUuid: string;
  createdAt: string;
  generator: InkPackageManifest["generator"];
  provenance: InkPackageManifest["provenance"];
  variants: InkDisplayVariant[];
  documents: PackagedDocument[];
  /**
   * A realtime draft can cap preview children so the entry frame is published
   * promptly. Archive builds leave this undefined and materialize every image.
   */
  maxImagePreviewDocuments?: number;
  compatibility?: InkPackageManifest["compatibility"];
}

export interface BuiltInkPackage {
  manifest: InkPackageManifest;
  files: ReadonlyMap<string, Uint8Array>;
  archive: Uint8Array;
  sha256: string;
}

export interface InkPackageBuildHooks {
  onVariantRendered?: (progress: {
    completed: number;
    total: number;
    documentUuid: string;
    variantId: string;
  }) => void | Promise<void>;
  onPackaging?: () => void | Promise<void>;
}

export function createInkDisplayVariant(
  profileId: string,
  rawDisplayMeta: DisplayMeta,
): InkDisplayVariant {
  const displayMeta = displayMetaSchema.parse(rawDisplayMeta);
  const profile = orientScreenProfile(getScreenProfile(profileId), displayMeta.orientation);
  return inkDisplayVariantSchema.parse({
    id: inkVariantId(profileId, displayMeta),
    profileId,
    screenProfileVersion: profile.version,
    displayMeta,
    logicalSize: profile.logicalSize,
    displayRotation: profile.displayRotation,
    pixelFormat: profile.pixelFormat,
    codec: "png",
  });
}

function pagePath(pageIndex: number): string {
  return pageIndex.toString().padStart(4, "0");
}

export async function buildRenderedInkPackage(
  rawInput: InkPackageBuildInput,
  engine: RenderEngine = renderEngine,
  hooks: InkPackageBuildHooks = {},
): Promise<BuiltInkPackage> {
  const packageId = inkUuidSchema.parse(rawInput.packageId);
  const sourceDocuments = packagedDocumentSchema.array().min(1).max(256).parse(rawInput.documents);
  const { documents, imageTargetsByDocument } = expandImagePreviewDocuments(
    sourceDocuments,
    undefined,
    rawInput.maxImagePreviewDocuments,
  );
  const variants = inkDisplayVariantSchema.array().min(1).max(64).parse(rawInput.variants);
  const packagedUuids = new Set(documents.map((document) => document.uuid));
  if (packagedUuids.size !== documents.length) throw new Error("Document UUIDs must be unique");
  if (!packagedUuids.has(rawInput.entryUuid)) throw new Error("entryUuid is not packaged");
  const feedDetailFallbackUrls = feedDetailFallbackUrlsForDocuments(documents);

  const files = new Map<string, Uint8Array>();
  const documentIndices: InkPackageManifest["documents"] = [];
  const variantTotal = documents.length * variants.length;
  let renderedVariantCount = 0;

  for (const document of documents) {
    const documentPath = `documents/${document.uuid}.json`;
    const documentBytes = encodeInkJson(document);
    files.set(documentPath, documentBytes);
    const renderedVariants: InkPackageManifest["documents"][number]["variants"] = [];

    for (const variant of variants) {
      const first = await engine.render({
        profileId: variant.profileId,
        document: document.content,
        localWidgets: document.localWidgets,
        displayMeta: variant.displayMeta,
        navigationContext: {
          imageTargets: imageTargetsByDocument.get(document.uuid) ?? [],
        },
        pageIndex: 0,
      });
      const pageCount = first.manifest.pagination.pageCount;
      const pages: InkPackageManifest["documents"][number]["variants"][number]["pages"] = [];

      for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
        const frame = pageIndex === 0
          ? first
          : await engine.render({
              profileId: variant.profileId,
              document: document.content,
              localWidgets: document.localWidgets,
              displayMeta: variant.displayMeta,
              navigationContext: {
                imageTargets: imageTargetsByDocument.get(document.uuid) ?? [],
              },
              pageIndex,
            });
        if (frame.manifest.pagination.pageCount !== pageCount) {
          throw new Error(`Renderer pagination changed while building document '${document.uuid}'`);
        }
        const prefix = `frames/${variant.id}/${document.uuid}/${pagePath(pageIndex)}`;
        const imagePath = `${prefix}.png`;
        const image = new Uint8Array(frame.payload);
        files.set(imagePath, image);
        const sidecarPath = `${prefix}.json`;
        const sidecar = frameSidecar({
          packageId,
          document,
          variant,
          frame,
          imagePath,
          packagedUuids,
          feedDetailFallbackUrls,
        });
        const sidecarBytes = encodeInkJson(sidecar);
        files.set(sidecarPath, sidecarBytes);
        pages.push({
          pageIndex,
          imagePath,
          imageBytes: image.byteLength,
          imageSha256: frame.manifest.sha256,
          sidecarPath,
          sidecarBytes: sidecarBytes.byteLength,
          sidecarSha256: await sha256Hex(sidecarBytes),
        });
      }

      renderedVariants.push({ variantId: variant.id, pageCount, pages });
      renderedVariantCount += 1;
      await hooks.onVariantRendered?.({
        completed: renderedVariantCount,
        total: variantTotal,
        documentUuid: document.uuid,
        variantId: variant.id,
      });
    }

    documentIndices.push({
      uuid: document.uuid,
      ...(document.parentUuid ? { parentUuid: document.parentUuid } : {}),
      title: document.source.title,
      kind: document.content.page.kind,
      ...(document.source.url ? { sourceUrl: document.source.url } : {}),
      documentPath,
      documentBytes: documentBytes.byteLength,
      documentSha256: await sha256Hex(documentBytes),
      variants: renderedVariants,
    });
  }

  await hooks.onPackaging?.();
  const manifest = inkPackageManifestSchema.parse({
    schemaVersion: "inkos.package/v1",
    packageId,
    slug: rawInput.slug,
    revision: rawInput.revision,
    title: rawInput.title,
    entryUuid: rawInput.entryUuid,
    createdAt: rawInput.createdAt,
    generator: rawInput.generator,
    compatibility: rawInput.compatibility ?? {
      formatMajor: 1,
      minimumClientVersions: { web: "1.0.0", paperS3: "1.0.0" },
      requiredCapabilities: DEFAULT_CAPABILITIES,
    },
    provenance: rawInput.provenance,
    variants,
    documents: documentIndices,
  });
  const archive = await buildInkArchive(manifest, files);
  return { manifest, files, archive, sha256: await sha256Hex(archive) };
}
