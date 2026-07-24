import {
  renderRequestSchema,
  type FrameManifest,
  type RenderedFrame,
  type RenderRegion,
  type RenderRequestInput,
  type ScreenProfile,
} from "./contracts";
import { crc32Hex, sha256Hex } from "./checksum";
import {
  defaultAssetResolver,
  resolveDocumentImages,
  type AssetResolver,
} from "./asset-resolver";
import { collectContentImageOccurrences } from "./content-images";
import { layoutSemanticDocument } from "./semantic-layout";
import { getScreenProfile, orientScreenProfile } from "./profiles";
import { paperS3RefreshHint } from "./refresh-hint";
import { defaultStrategyRegistry, type RenderStrategyRegistry } from "./strategies";

export const RENDERER_VERSION = "inkos-renderer/0.8.0";

export interface RenderEngineOptions {
  strategies?: RenderStrategyRegistry;
  assetResolver?: AssetResolver;
}

function fullRegion(profile: ScreenProfile): RenderRegion {
  return {
    x: 0,
    y: 0,
    width: profile.logicalSize.width,
    height: profile.logicalSize.height,
  };
}

function validateRegion(region: RenderRegion, profile: ScreenProfile): void {
  const { width, height } = profile.logicalSize;
  if (region.x + region.width > width || region.y + region.height > height) {
    throw new Error(`Render region is outside ${width}x${height} logical screen bounds`);
  }
  const isFull = region.x === 0 && region.y === 0 && region.width === width && region.height === height;
  if (isFull) return;
  if (!profile.refresh.supportsPartial) {
    throw new Error(`${profile.id} does not support partial refresh`);
  }
  if (
    region.x % profile.refresh.xAlignment !== 0 ||
    region.width % profile.refresh.xAlignment !== 0 ||
    region.y % profile.refresh.yAlignment !== 0 ||
    region.height % profile.refresh.yAlignment !== 0
  ) {
    throw new Error(
      `Render region must align to ${profile.refresh.xAlignment}x${profile.refresh.yAlignment} pixels`,
    );
  }
}

export class RenderEngine {
  private readonly strategies: RenderStrategyRegistry;
  private readonly assetResolver: AssetResolver;

  constructor(options: RenderEngineOptions = {}) {
    this.strategies = options.strategies ?? defaultStrategyRegistry;
    this.assetResolver = options.assetResolver ?? defaultAssetResolver;
  }

  async render(input: RenderRequestInput): Promise<RenderedFrame> {
    const request = renderRequestSchema.parse(input);
    const profile = orientScreenProfile(
      getScreenProfile(request.profileId),
      request.displayMeta.orientation,
    );
    if (
      request.displayMeta.outputTuning
      && profile.rasterStrategy !== "eink-gray4-png-v1"
    ) {
      throw new Error(`${profile.id} does not support PaperS3 gray4 output tuning`);
    }
    const region = request.region ?? fullRegion(profile);
    validateRegion(region, profile);

    const resolvedImages = await resolveDocumentImages(request.document, this.assetResolver);
    const imagePaths = new Set(
      collectContentImageOccurrences(request.document).map(({ contentPath }) => contentPath),
    );
    for (const target of request.navigationContext.imageTargets) {
      if (!imagePaths.has(target.contentPath)) {
        throw new Error(
          `Image navigation target '${target.contentPath}' does not exist in document '${request.document.id}'`,
        );
      }
    }
    const layout = layoutSemanticDocument(request.document, profile, {
      resolvedImages,
      displayMeta: request.displayMeta,
      localWidgets: request.localWidgets,
      imageTargets: new Map(
        request.navigationContext.imageTargets.map((target) => [
          target.contentPath,
          target.targetDocumentId,
        ]),
      ),
    });
    if (request.pageIndex >= layout.pages.length) {
      throw new Error(
        `Page index ${request.pageIndex} is outside rendered page count ${layout.pages.length}`,
      );
    }
    const strategy = this.strategies.resolve(profile);
    const payload = await strategy.render({
      svg: layout.pages[request.pageIndex].svg,
      profile,
      region,
      displayMeta: request.displayMeta,
    });
    const sha256 = sha256Hex(payload);
    const refreshHint = paperS3RefreshHint({
      document: request.document,
      profile,
      payload,
    });
    const isFull =
      region.x === 0 &&
      region.y === 0 &&
      region.width === profile.logicalSize.width &&
      region.height === profile.logicalSize.height;

    const manifest: FrameManifest = {
      schemaVersion: "inkos.frame/v2",
      rendererVersion: RENDERER_VERSION,
      frameId: sha256.slice(0, 24),
      documentId: request.document.id,
      documentRevision: request.document.revision,
      contentType: request.document.page.kind,
      screenProfileId: profile.id,
      screenProfileVersion: profile.version,
      nativeSize: profile.nativeSize,
      logicalSize: profile.logicalSize,
      displayRotation: profile.displayRotation,
      pixelFormat: profile.pixelFormat,
      layoutStrategy: profile.layoutStrategy,
      rasterStrategy: profile.rasterStrategy,
      displayMeta: request.displayMeta,
      codec: "png",
      pagination: {
        pageIndex: request.pageIndex,
        pageCount: layout.pages.length,
        hasPrevious: request.pageIndex > 0,
        hasNext: request.pageIndex + 1 < layout.pages.length,
      },
      update: { kind: isFull ? "full" : "partial", region },
      ...(refreshHint ? { refreshHint } : {}),
      payloadBytes: payload.byteLength,
      sha256,
      crc32: crc32Hex(payload),
      interactions: layout.pages[request.pageIndex].interactions,
      warnings: layout.warnings,
    };

    return {
      payload,
      contentType: "image/png",
      manifest,
      textRegions: layout.pages[request.pageIndex].textRegions,
      warnings: layout.warnings,
    };
  }
}

export const renderEngine = new RenderEngine();
