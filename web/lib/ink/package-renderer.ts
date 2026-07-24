import {
  ControlledRemoteAssetResolver,
  type AssetResolver,
} from "../rendering/asset-resolver";
import { collectContentImageOccurrences } from "../rendering/content-images";
import type { RenderedFrame } from "../rendering/contracts";
import { RENDERER_VERSION, RenderEngine } from "../rendering/engine";
import { remoteImageHosts } from "./generator/runner";
import { imagePreviewDocumentUuid } from "./image-previews";
import { createInkDisplayVariant } from "./package-builder";
import type {
  InkDisplayVariant,
  InkFrameSidecar,
  PackagedDocument,
} from "./contracts";
import type { LoadedInkCatalogPackage } from "./catalog-store";
import type { PackageRenderRequest } from "./service-contracts";
import { feedDetailFallbackUrlsForDocuments, frameSidecar } from "./sidecar";
import { PaperS3HomeAssetResolver } from "./builtin/papers3-calibration-asset";
import { PAPERS3_HOME_PACKAGE_ID } from "./builtin/papers3-home-identity";

const DEFAULT_ENGINE_CACHE_ENTRIES = 4;
const DEFAULT_FRAME_CACHE_ENTRIES = 96;
const DEFAULT_FRAME_CACHE_BYTES = 32 * 1024 * 1024;
const MAXIMUM_PENDING_FRAMES = 32;
const PAPER_S3_PROFILE_ID = "m5stack-paper-s3-portrait";

interface CachedEngine {
  allowedHostSignature: string;
  engine: RenderEngine;
}

interface CachedFrame {
  frame: RenderedFrame;
  sidecar: InkFrameSidecar;
  variant: InkDisplayVariant;
  bytes: number;
}

export interface RenderedPackagePage extends CachedFrame {
  requestedPageIndex: number;
  actualPageIndex: number;
}

export interface InkPackageRenderRuntimeOptions {
  maximumEngineEntries?: number;
  maximumFrameEntries?: number;
  maximumFrameBytes?: number;
}

function touch<K, V>(cache: Map<K, V>, key: K, value: V): V {
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function packageDocuments(loaded: LoadedInkCatalogPackage): PackagedDocument[] {
  return [...loaded.contents.documents.values()];
}

function imageTargets(
  document: PackagedDocument,
  packagedUuids: ReadonlySet<string>,
) {
  if (document.content.page.kind === "image") return [];
  return collectContentImageOccurrences(document.content).flatMap(({ contentPath }) => {
    const targetDocumentId = imagePreviewDocumentUuid(document.uuid, contentPath);
    // Realtime drafts intentionally cap preview child documents. Images that
    // exceed that cap remain ordinary inline content; they simply do not get
    // a fullscreen interaction until a child is materialized.
    return packagedUuids.has(targetDocumentId)
      ? [{ contentPath, targetDocumentId }]
      : [];
  });
}

function frameCacheBytes(frame: RenderedFrame, sidecar: InkFrameSidecar): number {
  return frame.payload.byteLength
    + Buffer.byteLength(JSON.stringify(frame.manifest))
    + Buffer.byteLength(JSON.stringify(sidecar));
}

/**
 * Process-local, bounded high-priority renderer/cache for interactive frames.
 * Engines are scoped to an exact verified archive hash, so their remote-image
 * cache can never cross package policy boundaries.
 */
export class InkPackageRenderRuntime {
  private readonly engines = new Map<string, CachedEngine>();
  private readonly frames = new Map<string, CachedFrame>();
  private readonly pendingFrames = new Map<string, Promise<CachedFrame>>();
  private frameBytes = 0;
  private readonly maximumEngineEntries: number;
  private readonly maximumFrameEntries: number;
  private readonly maximumFrameBytes: number;

  constructor(options: InkPackageRenderRuntimeOptions = {}) {
    this.maximumEngineEntries = options.maximumEngineEntries ?? DEFAULT_ENGINE_CACHE_ENTRIES;
    this.maximumFrameEntries = options.maximumFrameEntries ?? DEFAULT_FRAME_CACHE_ENTRIES;
    this.maximumFrameBytes = options.maximumFrameBytes ?? DEFAULT_FRAME_CACHE_BYTES;
  }

  private engineFor(
    loaded: LoadedInkCatalogPackage,
    documents: PackagedDocument[],
  ): RenderEngine {
    // Re-evaluate the allowlist from the currently verified semantic package on
    // every request, including frame-cache hits. ControlledRemoteAssetResolver
    // still enforces HTTPS, credentials, ports, DNS and redirect policy.
    const allowedHosts = remoteImageHosts(documents);
    const allowedHostSignature = allowedHosts.join("\0");
    const key = `${loaded.manifest.packageId}:${loaded.archiveSha256}`;
    const cached = this.engines.get(key);
    if (cached && cached.allowedHostSignature === allowedHostSignature) {
      return touch(this.engines, key, cached).engine;
    }

    const controlledRemoteResolver = new ControlledRemoteAssetResolver({
      allowedSourceHosts: allowedHosts,
      allowPublicRedirectHosts: true,
    });
    const assetResolver: AssetResolver = loaded.manifest.packageId === PAPERS3_HOME_PACKAGE_ID
      ? new PaperS3HomeAssetResolver(controlledRemoteResolver)
      : controlledRemoteResolver;
    const entry: CachedEngine = {
      allowedHostSignature,
      engine: new RenderEngine({ assetResolver }),
    };
    touch(this.engines, key, entry);
    while (this.engines.size > this.maximumEngineEntries) {
      const oldest = this.engines.keys().next().value;
      if (oldest === undefined) break;
      this.engines.delete(oldest);
    }
    return entry.engine;
  }

  private getFrame(key: string): CachedFrame | undefined {
    const cached = this.frames.get(key);
    return cached ? touch(this.frames, key, cached) : undefined;
  }

  private setFrame(key: string, value: Omit<CachedFrame, "bytes">): CachedFrame {
    const bytes = frameCacheBytes(value.frame, value.sidecar);
    const cached = { ...value, bytes };
    const previous = this.frames.get(key);
    if (previous) this.frameBytes -= previous.bytes;
    this.frames.delete(key);

    if (bytes <= this.maximumFrameBytes && this.maximumFrameEntries > 0) {
      this.frames.set(key, cached);
      this.frameBytes += bytes;
      while (
        this.frames.size > this.maximumFrameEntries
        || this.frameBytes > this.maximumFrameBytes
      ) {
        const oldest = this.frames.entries().next().value as [string, CachedFrame] | undefined;
        if (!oldest) break;
        this.frames.delete(oldest[0]);
        this.frameBytes -= oldest[1].bytes;
      }
    }
    return cached;
  }

  async render(
    loaded: LoadedInkCatalogPackage,
    request: PackageRenderRequest,
    engineOverride?: RenderEngine,
  ): Promise<RenderedPackagePage> {
    const documents = packageDocuments(loaded);
    const document = loaded.contents.documents.get(request.documentUuid);
    if (!document) throw new Error(`Package does not contain document '${request.documentUuid}'`);
    // This endpoint is the PaperS3 online client surface. Explicit offline
    // generator jobs may contain other profiles, but the request intentionally
    // has no caller-controlled profileId.
    const profileId = PAPER_S3_PROFILE_ID;
    const variant = createInkDisplayVariant(profileId, request.displayMeta);
    const packagedUuids = new Set(loaded.manifest.documents.map(({ uuid }) => uuid));
    const feedDetailFallbackUrls = feedDetailFallbackUrlsForDocuments(documents);
    const navigationContext = {
      imageTargets: imageTargets(document, packagedUuids),
    };
    const engine = engineOverride ?? this.engineFor(loaded, documents);
    // Even injected-engine tests take the same policy discovery path.
    if (engineOverride) remoteImageHosts(documents);
    const baseKey = [
      loaded.manifest.packageId,
      loaded.manifest.revision,
      loaded.archiveSha256,
      RENDERER_VERSION,
      document.uuid,
      variant.id,
    ].join(":");

    const renderPage = async (pageIndex: number): Promise<CachedFrame> => {
      const key = `${baseKey}:${pageIndex}`;
      const cached = this.getFrame(key);
      if (cached) return cached;
      const pending = this.pendingFrames.get(key);
      if (pending) return pending;
      const render = (async () => {
        const frame = await engine.render({
          profileId,
          document: document.content,
          localWidgets: document.localWidgets,
          displayMeta: request.displayMeta,
          navigationContext,
          pageIndex,
        });
        const sidecar = frameSidecar({
          packageId: loaded.manifest.packageId,
          document,
          variant,
          frame,
          imagePath: `online/${variant.id}/${document.uuid}/${pageIndex
            .toString()
            .padStart(4, "0")}.png`,
          packagedUuids,
          feedDetailFallbackUrls,
        });
        return this.setFrame(key, { frame, sidecar, variant });
      })();
      if (this.pendingFrames.size < MAXIMUM_PENDING_FRAMES) {
        this.pendingFrames.set(key, render);
        void render.finally(() => {
          if (this.pendingFrames.get(key) === render) this.pendingFrames.delete(key);
        }).catch(() => undefined);
      }
      return render;
    };

    const first = await renderPage(0);
    const actualPageIndex = Math.min(
      request.pageIndex,
      first.frame.manifest.pagination.pageCount - 1,
    );
    const rendered = actualPageIndex === 0 ? first : await renderPage(actualPageIndex);
    return {
      ...rendered,
      requestedPageIndex: request.pageIndex,
      actualPageIndex,
    };
  }
}

export const inkPackageRenderRuntime = new InkPackageRenderRuntime();
