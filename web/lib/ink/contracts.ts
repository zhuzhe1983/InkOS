import { z } from "zod";

import {
  clientAppUrlSchema,
  clientCollectionUrlSchema,
  clientDeviceUrlSchema,
  contentDocumentSchema,
  displayMetaSchema,
  type ContentDocument,
} from "../rendering/contracts";
import {
  inkClockFormatSchema,
  inkClockFullRefreshEverySchema,
  inkClockRefreshMsSchema,
  inkClockTimezoneSchema,
  inkLocalWidgetSchema,
} from "./local-widgets";

export const inkUuidSchema = z.uuid().refine(
  (value) => value === value.toLowerCase(),
  "Expected a lowercase RFC 9562 UUID string",
);

export const inkPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => {
    if (value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
    const segments = value.split("/");
    return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
  }, "Expected a normalized relative archive path");

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const isoDateTimeSchema = z.iso.datetime({ offset: true });
const semanticVersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);

export const inkCapabilitySchema = z.enum([
  "navigation.parent-v1",
  "navigation.hitbox-v1",
  "display.font-level-v1",
  "device.settings-v1",
  // Read-only compatibility token for normal-polarity packages created before
  // inversion was retired. New packages never declare this capability.
  "display.invert-v1",
  "content-ota.atomic-v1",
  "frame.source-image-jpeg-v1",
]);

export const packagedDocumentSchema = z
  .object({
    schemaVersion: z.literal("inkos.document/v1"),
    uuid: inkUuidSchema,
    parentUuid: inkUuidSchema.optional(),
    source: z
      .object({
        url: z.url().optional(),
        title: z.string().trim().min(1).max(500),
        retrievedAt: isoDateTimeSchema.optional(),
        license: z.string().trim().min(1).max(160).optional(),
      })
      .strict(),
    localWidgets: z.array(inkLocalWidgetSchema).max(8).optional(),
    content: contentDocumentSchema,
  })
  .strict()
  .superRefine((document, context) => {
    if (document.content.id !== document.uuid) {
      context.addIssue({
        code: "custom",
        path: ["content", "id"],
        message: "Packaged content.id must equal the document UUID",
      });
    }
    const localWidgetIds = new Set<string>();
    for (const [index, widget] of (document.localWidgets ?? []).entries()) {
      if (localWidgetIds.has(widget.id)) {
        context.addIssue({
          code: "custom",
          path: ["localWidgets", index, "id"],
          message: "Local-widget IDs must be unique within a document",
        });
      }
      localWidgetIds.add(widget.id);
    }
  });

export const inkDisplayVariantSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u),
    profileId: z.string().trim().min(1).max(128),
    screenProfileVersion: z.number().int().positive(),
    displayMeta: displayMetaSchema,
    logicalSize: z
      .object({ width: z.number().int().positive(), height: z.number().int().positive() })
      .strict(),
    displayRotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
    pixelFormat: z.enum(["mono1", "gray4", "spectra6"]),
    codec: z.literal("png"),
  })
  .strict();

export const inkHitboxSchema = z
  .object({
    id: z.string().trim().min(1).max(160),
    contentPath: z.string().trim().min(1).max(512),
    label: z.string().trim().min(1).max(500).optional(),
    bounds: z
      .object({
        x: z.number().int().nonnegative(),
        y: z.number().int().nonnegative(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict(),
    targetUuid: inkUuidSchema,
    /**
     * Optional HTTPS source destination or exact client-owned collection
     * action. targetUuid remains a packaged, safe fallback so older/offline
     * clients can keep validating the v1 sidecar.
     */
    targetUrl: z
      .union([
        z
          .url()
          .max(2048)
          .refine((value) => {
            const url = new URL(value);
            return (url.protocol === "https:" || url.protocol === "http:")
              && !url.username
              && !url.password;
          }, "Expected a credential-free HTTP(S) URL"),
        clientCollectionUrlSchema,
        clientAppUrlSchema,
        clientDeviceUrlSchema,
      ])
      .optional(),
    /**
     * HTTPS-only recovery destination for a packaged RSS/Atom detail target.
     * Clients must try targetUuid first and use this only after the verified
     * package has changed and no longer contains that UUID.
     */
    fallbackUrl: z
      .url()
      .max(2048)
      .refine((value) => {
        try {
          const url = new URL(value);
          return url.protocol === "https:"
            && !url.username
            && !url.password
            && (!url.port || url.port === "443");
        } catch {
          return false;
        }
      }, "Expected a credential-free canonical HTTPS URL")
      .optional(),
  })
  .strict()
  .refine((interaction) => !(interaction.targetUrl && interaction.fallbackUrl), {
    message: "targetUrl actions and fallbackUrl recovery are mutually exclusive",
    path: ["fallbackUrl"],
  });

export const inkDynamicRegionStyleSchema = z
  .object({
    fontFamily: z.literal("monospace"),
    fontSize: z.number().int().min(8).max(256),
    fontWeight: z.union([z.literal(400), z.literal(700)]),
    textAlign: z.enum(["left", "center", "right"]),
    verticalAlign: z.enum(["top", "middle", "bottom"]),
    foreground: z.enum(["black", "white"]),
    background: z.enum(["black", "white"]),
  })
  .strict()
  .refine((style) => style.foreground !== style.background, {
    message: "Dynamic-region foreground and background must differ",
    path: ["foreground"],
  });

export const inkDynamicRegionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/u),
    kind: z.literal("clock"),
    bounds: z
      .object({
        x: z.number().int().nonnegative(),
        y: z.number().int().nonnegative(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict(),
    format: inkClockFormatSchema,
    timezone: inkClockTimezoneSchema,
    refreshMs: inkClockRefreshMsSchema,
    fullRefreshEvery: inkClockFullRefreshEverySchema,
    style: inkDynamicRegionStyleSchema,
  })
  .strict();

export const inkSourceImageSchema = z
  .object({
    path: inkPathSchema,
    bytes: z.number().int().positive(),
    sha256: sha256Schema,
    mediaType: z.literal("image/jpeg"),
    pixelSize: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict(),
    fit: z.literal("contain"),
  })
  .strict()
  .refine((source) => source.path.endsWith(".jpg"), {
    message: "Source-image artifact paths must use the canonical .jpg extension",
    path: ["path"],
  });

export const inkFrameSidecarSchema = z
  .object({
    schemaVersion: z.literal("inkos.frame-sidecar/v1"),
    packageId: inkUuidSchema,
    documentUuid: inkUuidSchema,
    parentUuid: inkUuidSchema.optional(),
    variantId: z.string().min(1).max(128),
    pageIndex: z.number().int().nonnegative(),
    pageCount: z.number().int().positive(),
    imagePath: inkPathSchema,
    imageSha256: sha256Schema,
    sourceImage: inkSourceImageSchema.optional(),
    logicalSize: z
      .object({ width: z.number().int().positive(), height: z.number().int().positive() })
      .strict(),
    interactions: z.array(inkHitboxSchema).max(256),
    dynamicRegions: z.array(inkDynamicRegionSchema).max(8).optional(),
  })
  .strict()
  .superRefine((sidecar, context) => {
    if (sidecar.pageIndex >= sidecar.pageCount) {
      context.addIssue({
        code: "custom",
        path: ["pageIndex"],
        message: "pageIndex must be smaller than pageCount",
      });
    }
    for (const [index, interaction] of sidecar.interactions.entries()) {
      if (
        interaction.bounds.x + interaction.bounds.width > sidecar.logicalSize.width ||
        interaction.bounds.y + interaction.bounds.height > sidecar.logicalSize.height
      ) {
        context.addIssue({
          code: "custom",
          path: ["interactions", index, "bounds"],
          message: "Interaction bounds must fit within logicalSize",
        });
      }
    }
    const dynamicRegionIds = new Set<string>();
    for (const [index, region] of (sidecar.dynamicRegions ?? []).entries()) {
      if (dynamicRegionIds.has(region.id)) {
        context.addIssue({
          code: "custom",
          path: ["dynamicRegions", index, "id"],
          message: "Dynamic-region IDs must be unique within a frame",
        });
      }
      dynamicRegionIds.add(region.id);
      if (
        region.bounds.x + region.bounds.width > sidecar.logicalSize.width
        || region.bounds.y + region.bounds.height > sidecar.logicalSize.height
      ) {
        context.addIssue({
          code: "custom",
          path: ["dynamicRegions", index, "bounds"],
          message: "Dynamic-region bounds must fit within logicalSize",
        });
      }
      for (const [interactionIndex, interaction] of sidecar.interactions.entries()) {
        const separated = region.bounds.x + region.bounds.width <= interaction.bounds.x
          || interaction.bounds.x + interaction.bounds.width <= region.bounds.x
          || region.bounds.y + region.bounds.height <= interaction.bounds.y
          || interaction.bounds.y + interaction.bounds.height <= region.bounds.y;
        if (!separated) {
          context.addIssue({
            code: "custom",
            path: ["dynamicRegions", index, "bounds"],
            message: `Dynamic region overlaps interaction ${interactionIndex}`,
          });
        }
      }
    }
  });

const packagedPageSchema = z
  .object({
    pageIndex: z.number().int().nonnegative(),
    imagePath: inkPathSchema,
    imageBytes: z.number().int().positive(),
    imageSha256: sha256Schema,
    /**
     * Optional original-pixel JPEG. imagePath remains the complete renderer-
     * owned PNG fallback, while clients declaring source-image support prefer
     * this independently hashed artifact and apply the fixed contain policy.
     */
    sourceImage: inkSourceImageSchema.optional(),
    sidecarPath: inkPathSchema,
    sidecarBytes: z.number().int().positive(),
    sidecarSha256: sha256Schema,
  })
  .strict();

const packagedVariantFramesSchema = z
  .object({
    variantId: z.string().min(1).max(128),
    pageCount: z.number().int().positive(),
    pages: z.array(packagedPageSchema).min(1).max(4096),
  })
  .strict()
  .superRefine((frames, context) => {
    if (frames.pages.length !== frames.pageCount) {
      context.addIssue({
        code: "custom",
        path: ["pages"],
        message: "pages length must equal pageCount",
      });
    }
    const indices = frames.pages.map((page) => page.pageIndex).sort((a, b) => a - b);
    if (indices.some((pageIndex, index) => pageIndex !== index)) {
      context.addIssue({
        code: "custom",
        path: ["pages"],
        message: "Page indices must be contiguous and start at zero",
      });
    }
  });

const packagedDocumentIndexSchema = z
  .object({
    uuid: inkUuidSchema,
    parentUuid: inkUuidSchema.optional(),
    title: z.string().trim().min(1).max(500),
    kind: z.enum(["detail", "list", "reader", "image"]),
    sourceUrl: z.url().optional(),
    documentPath: inkPathSchema,
    documentBytes: z.number().int().positive(),
    documentSha256: sha256Schema,
    variants: z.array(packagedVariantFramesSchema).min(1).max(64),
  })
  .strict();

export const inkPackageManifestSchema = z
  .object({
    schemaVersion: z.literal("inkos.package/v1"),
    packageId: inkUuidSchema,
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,95}$/u),
    revision: z.number().int().positive(),
    title: z.string().trim().min(1).max(500),
    entryUuid: inkUuidSchema,
    createdAt: isoDateTimeSchema,
    generator: z
      .object({ name: z.string().min(1).max(128), version: semanticVersionSchema })
      .strict(),
    compatibility: z
      .object({
        formatMajor: z.literal(1),
        minimumClientVersions: z
          .object({ web: semanticVersionSchema, paperS3: semanticVersionSchema })
          .strict(),
        requiredCapabilities: z.array(inkCapabilitySchema).min(1),
      })
      .strict(),
    provenance: z
      .object({
        seeds: z
          .array(
            z
              .object({
                url: z.url(),
                title: z.string().trim().min(1).max(500),
                retrievedAt: isoDateTimeSchema,
                license: z.string().trim().min(1).max(160).optional(),
              })
              .strict(),
          )
          .min(1)
          .max(64),
        crawl: z
          .object({ maxDepth: z.number().int().min(0).max(4), maxDocuments: z.number().int().min(1).max(256) })
          .strict(),
      })
      .strict(),
    variants: z.array(inkDisplayVariantSchema).min(1).max(64),
    documents: z.array(packagedDocumentIndexSchema).min(1).max(2048),
  })
  .strict()
  .superRefine((manifest, context) => {
    const documents = new Map(manifest.documents.map((document) => [document.uuid, document]));
    if (!documents.has(manifest.entryUuid)) {
      context.addIssue({ code: "custom", path: ["entryUuid"], message: "entryUuid is not packaged" });
    }

    const entry = documents.get(manifest.entryUuid);
    if (entry?.parentUuid !== undefined) {
      context.addIssue({ code: "custom", path: ["entryUuid"], message: "The entry document cannot have a parent" });
    }

    if (documents.size !== manifest.documents.length) {
      context.addIssue({ code: "custom", path: ["documents"], message: "Document UUIDs must be unique" });
    }

    const variantIds = new Set(manifest.variants.map((variant) => variant.id));
    if (variantIds.size !== manifest.variants.length) {
      context.addIssue({ code: "custom", path: ["variants"], message: "Variant IDs must be unique" });
    }
    const supportsSourceImage = manifest.compatibility.requiredCapabilities.includes(
      "frame.source-image-jpeg-v1",
    );

    const allPaths = new Set<string>();
    const claimPath = (path: string, issuePath: Array<string | number>) => {
      if (path === "ink-manifest.json" || allPaths.has(path)) {
        context.addIssue({ code: "custom", path: issuePath, message: "Archive paths must be unique and cannot replace ink-manifest.json" });
      }
      allPaths.add(path);
    };

    manifest.documents.forEach((document, documentIndex) => {
      claimPath(document.documentPath, ["documents", documentIndex, "documentPath"]);
      if (document.uuid !== manifest.entryUuid && !document.parentUuid) {
        context.addIssue({ code: "custom", path: ["documents", documentIndex, "parentUuid"], message: "Every non-entry document requires a parentUuid" });
      }
      if (document.parentUuid && !documents.has(document.parentUuid)) {
        context.addIssue({ code: "custom", path: ["documents", documentIndex, "parentUuid"], message: "parentUuid is not packaged" });
      }

      const documentVariantIds = new Set(document.variants.map((variant) => variant.variantId));
      if (documentVariantIds.size !== document.variants.length) {
        context.addIssue({ code: "custom", path: ["documents", documentIndex, "variants"], message: "Document variant IDs must be unique" });
      }
      for (const variantId of variantIds) {
        if (!documentVariantIds.has(variantId)) {
          context.addIssue({ code: "custom", path: ["documents", documentIndex, "variants"], message: `Missing frames for variant '${variantId}'` });
        }
      }
      for (const [variantIndex, frames] of document.variants.entries()) {
        if (!variantIds.has(frames.variantId)) {
          context.addIssue({ code: "custom", path: ["documents", documentIndex, "variants", variantIndex, "variantId"], message: "Unknown variantId" });
        }
        frames.pages.forEach((page, pageIndex) => {
          claimPath(page.imagePath, ["documents", documentIndex, "variants", variantIndex, "pages", pageIndex, "imagePath"]);
          claimPath(page.sidecarPath, ["documents", documentIndex, "variants", variantIndex, "pages", pageIndex, "sidecarPath"]);
          if (!page.sourceImage) return;
          const sourceImagePath = ["documents", documentIndex, "variants", variantIndex, "pages", pageIndex, "sourceImage"];
          claimPath(page.sourceImage.path, [...sourceImagePath, "path"]);
          if (!supportsSourceImage) {
            context.addIssue({
              code: "custom",
              path: sourceImagePath,
              message: "Source-image pages require capability 'frame.source-image-jpeg-v1'",
            });
          }
          if (document.kind !== "image") {
            context.addIssue({
              code: "custom",
              path: sourceImagePath,
              message: "Source-image artifacts are allowed only for image documents",
            });
          }
          if (!page.sourceImage.path.endsWith(".jpg")) {
            context.addIssue({
              code: "custom",
              path: [...sourceImagePath, "path"],
              message: "Source-image artifact paths must use the canonical .jpg extension",
            });
          }
        });
      }
    });

    for (const document of manifest.documents) {
      const visited = new Set<string>();
      let current: typeof document | undefined = document;
      while (current?.parentUuid) {
        if (visited.has(current.uuid)) {
          context.addIssue({ code: "custom", path: ["documents"], message: `Parent cycle contains '${current.uuid}'` });
          break;
        }
        visited.add(current.uuid);
        current = documents.get(current.parentUuid);
      }
      if (current && current.uuid !== manifest.entryUuid) {
        context.addIssue({ code: "custom", path: ["documents"], message: `Document '${document.uuid}' does not descend from entryUuid` });
      }
    }
  });

export type PackagedDocument = z.infer<typeof packagedDocumentSchema>;
export type InkDisplayVariant = z.infer<typeof inkDisplayVariantSchema>;
export type InkHitbox = z.infer<typeof inkHitboxSchema>;
export type InkDynamicRegionStyle = z.infer<typeof inkDynamicRegionStyleSchema>;
export type InkDynamicRegion = z.infer<typeof inkDynamicRegionSchema>;
export type InkFrameSidecar = z.infer<typeof inkFrameSidecarSchema>;
export type InkSourceImage = z.infer<typeof inkSourceImageSchema>;
export type InkPackageManifest = z.infer<typeof inkPackageManifestSchema>;
export type InkCapability = z.infer<typeof inkCapabilitySchema>;

export interface PackagedContentInput {
  uuid: string;
  parentUuid?: string;
  source: PackagedDocument["source"];
  localWidgets?: PackagedDocument["localWidgets"];
  content: ContentDocument;
}

export function packagedDocument(input: PackagedContentInput): PackagedDocument {
  return packagedDocumentSchema.parse({ schemaVersion: "inkos.document/v1", ...input });
}
