import { createHash } from "node:crypto";

import {
  ControlledRemoteAssetResolver,
  type AssetResolver,
} from "../../rendering/asset-resolver";
import type {
  DisplayMeta,
  RenderedFrame,
} from "../../rendering/contracts";
import { getScreenProfile, orientScreenProfile } from "../../rendering/profiles";
import {
  inkFrameSidecarSchema,
  packagedDocumentSchema,
  type InkDisplayVariant,
  type InkFrameSidecar,
  type PackagedDocument,
} from "../contracts";
import { createInkDisplayVariant } from "../package-builder";
import {
  ONLINE_PACKAGE_ID,
  DEFAULT_RANDOM_IMAGE_COLLECTION_URL,
  LEGACY_GRAYSCALE_RANDOM_IMAGE_COLLECTION_URL,
  appExecuteRequestSchema,
  type AppImageEntry,
  type AppImageProcessing,
  type AppExecuteRequest,
  type InkMapStyle,
} from "../service-contracts";
import { frameSidecar } from "../sidecar";
import {
  INKOS_APP_DOCUMENT_UUIDS,
} from "../app-actions";
import {
  DIAGNOSTIC_RAW_COLOUR_MODE,
  diagnosticAppImageModeForRenderIntent,
  renderDiagnosticRawColourFrame,
  type DiagnosticAppImageMode,
} from "./diagnostic-raw-colour";

export const PAPER_S3_PROFILE_ID = "m5stack-paper-s3-portrait";
export const RANDOM_IMAGE_ACTION = "inkos://app/random-image" as const;
export const BAIDU_MAP_ACTION = "inkos://app/baidu-map" as const;

export const APP_DOCUMENT_UUIDS = INKOS_APP_DOCUMENT_UUIDS;

const APP_TITLES = Object.freeze({
  [RANDOM_IMAGE_ACTION]: "随机图片",
  [BAIDU_MAP_ACTION]: "附近地图",
});

const PICSUM_ORIGIN = "https://picsum.photos";
const BAIDU_IP_LOCATION_ENDPOINT = "https://api.map.baidu.com/location/ip";
const BAIDU_STATIC_MAP_ENDPOINT = "https://api.map.baidu.com/staticimage/v2";
const BAIDU_RESPONSE_LIMIT = 16 * 1024;
const BAIDU_TIMEOUT_MS = 8_000;

export class InkAppServiceError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

interface AppRenderInput {
  document: PackagedDocument;
  displayMeta: DisplayMeta;
  allowedSourceHosts: readonly string[];
  allowPublicRedirectHosts: boolean;
  imageProcessing: AppImageProcessing;
  mapStyle?: InkMapStyle;
}

export interface InkAppServiceDependencies {
  fetch?: typeof fetch;
  /** Test/deployment seam. Production normally reads INKOS_BAIDU_MAP_AK. */
  baiduMapAk?: string;
  /** Test seam for the bounded remote image resolver. */
  assetResolver?: AssetResolver;
  render?: (input: AppRenderInput) => Promise<RenderedFrame>;
}

export interface ExecutedInkApp {
  request: AppExecuteRequest;
  document: PackagedDocument;
  variant: InkDisplayVariant;
  frame: RenderedFrame;
  sidecar: InkFrameSidecar;
  imageMode: DiagnosticAppImageMode;
}

function appRevision(request: AppExecuteRequest): number {
  const digest = createHash("sha256")
    .update(request.action)
    .update("\0")
    .update(request.nonce)
    .update("\0")
    .update(String(request.requestedAtUnixMs));
  if (request.action === RANDOM_IMAGE_ACTION) {
    for (const image of request.images) {
      digest.update("\0").update(image.id).update("\0").update(image.label)
        .update("\0").update(image.url);
    }
  } else {
    digest.update("\0").update(request.mapStyle);
  }
  digest.update("\0").update(request.imageProcessing);
  const bytes = digest.digest();
  return (bytes.readUInt32BE(0) & 0x7fffffff) || 1;
}

async function readLimitedText(response: Response): Promise<string> {
  const announced = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(announced) && announced > BAIDU_RESPONSE_LIMIT) {
    throw new InkAppServiceError(
      "APP_UPSTREAM_INVALID",
      502,
      "地图定位服务返回的数据过大。",
      true,
    );
  }
  if (!response.body) {
    throw new InkAppServiceError("APP_UPSTREAM_INVALID", 502, "地图定位服务没有返回数据。", true);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > BAIDU_RESPONSE_LIMIT) {
      await reader.cancel();
      throw new InkAppServiceError(
        "APP_UPSTREAM_INVALID",
        502,
        "地图定位服务返回的数据过大。",
        true,
      );
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total),
  );
}

function numericCoordinate(value: unknown): number | undefined {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function baiduIpLocation(fetcher: typeof fetch, ak: string): Promise<{
  longitude: number;
  latitude: number;
}> {
  const url = new URL(BAIDU_IP_LOCATION_ENDPOINT);
  url.searchParams.set("ak", ak);
  url.searchParams.set("coor", "bd09ll");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BAIDU_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetcher(url, {
        headers: { Accept: "application/json" },
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
      });
    } catch {
      throw new InkAppServiceError(
        "APP_UPSTREAM_UNAVAILABLE",
        502,
        "地图定位服务暂时不可用。",
        true,
      );
    }
    if (!response.ok) {
      throw new InkAppServiceError(
        "APP_UPSTREAM_UNAVAILABLE",
        502,
        "地图定位服务暂时不可用。",
        true,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readLimitedText(response));
    } catch (error) {
      if (error instanceof InkAppServiceError) throw error;
      throw new InkAppServiceError(
        "APP_UPSTREAM_INVALID",
        502,
        "地图定位服务返回了无效数据。",
        true,
      );
    }
    const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    const status = numericCoordinate(record.status);
    const content = record.content && typeof record.content === "object"
      ? record.content as Record<string, unknown>
      : {};
    const point = content.point && typeof content.point === "object"
      ? content.point as Record<string, unknown>
      : {};
    const longitude = numericCoordinate(point.x);
    const latitude = numericCoordinate(point.y);
    if (
      status !== 0
      || longitude === undefined
      || latitude === undefined
      || longitude < -180
      || longitude > 180
      || latitude < -90
      || latitude > 90
    ) {
      throw new InkAppServiceError(
        "APP_LOCATION_UNAVAILABLE",
        502,
        "无法通过当前网络确定地图位置。",
        true,
      );
    }
    return { longitude, latitude };
  } finally {
    clearTimeout(timeout);
  }
}

function mapImageUrl(
  ak: string,
  location: { longitude: number; latitude: number },
  displayMeta: DisplayMeta,
  mapStyle: InkMapStyle,
): string {
  const profile = orientScreenProfile(
    getScreenProfile(PAPER_S3_PROFILE_ID),
    displayMeta.orientation,
  );
  const center = `${location.longitude.toFixed(6)},${location.latitude.toFixed(6)}`;
  const url = new URL(BAIDU_STATIC_MAP_ENDPOINT);
  url.searchParams.set("ak", ak);
  // Baidu's scale=2 mode returns a 2x raster. Half-size logical parameters
  // produce the exact PaperS3 frame while keeping roads and labels sharp.
  url.searchParams.set("width", String(profile.logicalSize.width / 2));
  url.searchParams.set("height", String(profile.logicalSize.height / 2));
  url.searchParams.set("center", center);
  url.searchParams.set("zoom", "17");
  url.searchParams.set("scale", "2");
  url.searchParams.set("coordtype", "bd09ll");
  url.searchParams.set("markers", center);
  url.searchParams.set("markerStyles", "l,P,0x000000");
  url.searchParams.set("copyright", "1");
  // Kept in the request identity even though tone conversion is local.
  void mapStyle;
  return url.toString();
}

function randomImageUrl(request: AppExecuteRequest): string {
  const profile = orientScreenProfile(
    getScreenProfile(PAPER_S3_PROFILE_ID),
    request.displayMeta.orientation,
  );
  return `${PICSUM_ORIGIN}/${profile.logicalSize.width}/${profile.logicalSize.height}`
    + `?random=${encodeURIComponent(request.nonce)}`;
}

function appDocument(
  request: AppExecuteRequest,
  imageUrl: string,
  image: AppImageEntry | undefined,
): PackagedDocument {
  const title = APP_TITLES[request.action];
  const uuid = APP_DOCUMENT_UUIDS[request.action];
  const retrievedAt = new Date(request.requestedAtUnixMs).toISOString();
  return packagedDocumentSchema.parse({
    schemaVersion: "inkos.document/v1",
    uuid,
    source: { title, retrievedAt },
    content: {
      schemaVersion: "inkos.content/v2",
      id: uuid,
      revision: appRevision(request),
      locale: "zh-CN",
      updatedAt: retrievedAt,
      page: {
        kind: "image",
        layout: request.action === RANDOM_IMAGE_ACTION ? "cover" : "contain",
        image: {
          source: { kind: "remote", url: imageUrl },
          alt: request.action === RANDOM_IMAGE_ACTION
            ? image?.label ?? "随机灰度照片"
            : "服务器按出口 IP 推测的附近静态地图",
          renderIntent: request.action === RANDOM_IMAGE_ACTION ? "photo" : "map",
        },
      },
    },
  });
}

function baiduAk(dependencies: InkAppServiceDependencies): string {
  const value = dependencies.baiduMapAk ?? process.env.INKOS_BAIDU_MAP_AK;
  if (!value || !/^[A-Za-z0-9_-]{8,256}$/u.test(value)) {
    throw new InkAppServiceError(
      "APP_NOT_CONFIGURED",
      503,
      "地图应用尚未配置服务端凭据。",
      false,
    );
  }
  return value;
}

const MAP_TONE = Object.freeze({
  // The static-map palette is mostly 220..245. PaperS3's final output curve
  // maps input >= 235 to paper white, so a conventional contrast operation
  // erases roads and borders. These values deliberately pull only map fills
  // and pale line work below that shoulder while leaving the neutral land
  // canvas white.
  eink: {
    textScale: 0.94,
    textOffset: -2,
    neutralLineScale: 0.95,
    neutralLineOffset: -17,
    colorWeight: 0.55,
    colorOffset: -8,
  },
  balanced: {
    textScale: 1,
    textOffset: 0,
    neutralLineScale: 1,
    neutralLineOffset: -3,
    colorWeight: 0.28,
    colorOffset: 0,
  },
  detail: {
    textScale: 0.97,
    textOffset: -1,
    neutralLineScale: 0.98,
    neutralLineOffset: -8,
    colorWeight: 0.42,
    colorOffset: -4,
  },
} satisfies Record<InkMapStyle, {
  textScale: number;
  textOffset: number;
  neutralLineScale: number;
  neutralLineOffset: number;
  colorWeight: number;
  colorOffset: number;
}>);

const clampGray = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));

/**
 * Convert one Baidu static-map RGB pixel to an e-paper-oriented gray value.
 *
 * The transform is intentionally colour-aware. Baidu uses neutral 237 gray as
 * its main land canvas, but uses similarly bright coloured pixels for roads,
 * water and parks. A grayscale-only curve cannot whiten the former without
 * also deleting the latter. Dark text stays on a nearly linear branch so its
 * anti-aliased edges are not blurred or posterized.
 */
export function mapBaiduMapPixelToGray(
  style: InkMapStyle,
  red: number,
  green: number,
  blue: number,
): number {
  const tone = MAP_TONE[style];
  const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);

  // Paper/building canvas. Keep this branch tight: neutral boundary pixels
  // below 235 still go through the line branch and remain visible.
  if (luma >= 235 && chroma <= 6) return 255;

  // POI names and their antialiasing. Avoid a second sharpening pass here;
  // the common PaperS3 raster stage already applies a small unsharp mask.
  if (luma <= 205) {
    return clampGray(luma * tone.textScale + tone.textOffset);
  }

  if (chroma <= 6) {
    return clampGray(luma * tone.neutralLineScale + tone.neutralLineOffset);
  }

  // Coloured high-key map regions carry useful semantics. Chroma separates
  // them from the neutral canvas: yellow roads become strongest, green parks
  // medium gray, and pale blue water remains the lightest visible fill.
  return clampGray(luma + tone.colorOffset - chroma * tone.colorWeight);
}

async function defaultRender(
  input: AppRenderInput,
  assetResolver?: AssetResolver,
): Promise<RenderedFrame> {
  const resolver = assetResolver ?? new ControlledRemoteAssetResolver({
    allowedSourceHosts: input.allowedSourceHosts,
    allowPublicRedirectHosts: input.allowPublicRedirectHosts,
    normalization: "diagnostic-raw-colour-png",
  });
  return renderDiagnosticRawColourFrame({
    profileId: PAPER_S3_PROFILE_ID,
    document: input.document,
    displayMeta: input.displayMeta,
    assetResolver: resolver,
    mode: input.imageProcessing === "diagnostic-raw-colour"
      ? DIAGNOSTIC_RAW_COLOUR_MODE
      : undefined,
  });
}

export async function executeInkApp(
  rawRequest: unknown,
  dependencies: InkAppServiceDependencies = {},
): Promise<ExecutedInkApp> {
  const request = appExecuteRequestSchema.parse(rawRequest);
  let imageUrl: string;
  let allowedSourceHosts: readonly string[];
  let selectedImage: AppImageEntry | undefined;
  let allowPublicRedirectHosts = false;
  if (request.action === RANDOM_IMAGE_ACTION) {
    selectedImage = request.images[request.pageIndex];
    if (
      selectedImage.url === DEFAULT_RANDOM_IMAGE_COLLECTION_URL
      || selectedImage.url === LEGACY_GRAYSCALE_RANDOM_IMAGE_COLLECTION_URL
      || selectedImage.url === RANDOM_IMAGE_ACTION
    ) {
      imageUrl = randomImageUrl(request);
      allowedSourceHosts = ["picsum.photos"];
    } else {
      imageUrl = selectedImage.url;
      allowedSourceHosts = [new URL(imageUrl).hostname];
      allowPublicRedirectHosts = true;
    }
  } else {
    const ak = baiduAk(dependencies);
    const location = await baiduIpLocation(dependencies.fetch ?? fetch, ak);
    imageUrl = mapImageUrl(ak, location, request.displayMeta, request.mapStyle);
    allowedSourceHosts = ["api.map.baidu.com"];
  }

  const document = appDocument(request, imageUrl, selectedImage);
  const renderInput = {
    document,
    displayMeta: request.displayMeta,
    allowedSourceHosts,
    allowPublicRedirectHosts,
    imageProcessing: request.imageProcessing,
    mapStyle: request.action === BAIDU_MAP_ACTION ? request.mapStyle : undefined,
  };
  let rendered: RenderedFrame;
  try {
    rendered = dependencies.render
      ? await dependencies.render(renderInput)
      : await defaultRender(renderInput, dependencies.assetResolver);
  } catch {
    throw new InkAppServiceError(
      "APP_IMAGE_UNAVAILABLE",
      502,
      "应用图片暂时无法获取或解码。",
      true,
    );
  }
  const pageIndex = request.action === RANDOM_IMAGE_ACTION ? request.pageIndex : 0;
  const pageCount = request.action === RANDOM_IMAGE_ACTION ? request.images.length : 1;
  const frame: RenderedFrame = {
    ...rendered,
    manifest: {
      ...rendered.manifest,
      pagination: {
        pageIndex,
        pageCount,
        hasPrevious: pageIndex > 0,
        hasNext: pageIndex + 1 < pageCount,
      },
    },
  };
  if (
    (request.action === BAIDU_MAP_ACTION && frame.warnings.length > 0)
    || frame.warnings.some((warning) => warning.includes("rendered as a placeholder"))
  ) {
    throw new InkAppServiceError(
      "APP_IMAGE_UNAVAILABLE",
      502,
      "应用图片暂时无法获取或解码。",
      true,
    );
  }
  const variant = createInkDisplayVariant(PAPER_S3_PROFILE_ID, request.displayMeta);
  const slug = request.action === RANDOM_IMAGE_ACTION ? "random-image" : "baidu-map";
  const page = document.content.page;
  const imageMode = request.imageProcessing === "diagnostic-raw-colour"
    ? DIAGNOSTIC_RAW_COLOUR_MODE
    : diagnosticAppImageModeForRenderIntent(
        page.kind === "image" ? page.image.renderIntent : undefined,
      );
  const sidecar = inkFrameSidecarSchema.parse(frameSidecar({
    packageId: ONLINE_PACKAGE_ID,
    document,
    variant,
    frame,
    imagePath: `apps/${slug}/${request.nonce}/${variant.id}/${document.uuid}/${pageIndex.toString().padStart(4, "0")}.png`,
  }));
  return { request, document, variant, frame, sidecar, imageMode };
}
