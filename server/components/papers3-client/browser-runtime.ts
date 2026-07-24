import { z } from "zod";

import {
  readInkArchive,
  sha256Hex,
  type InkArchiveContents,
} from "@/lib/ink/archive";
import { assessInkCompatibility } from "@/lib/ink/compatibility";
import {
  inkFrameSidecarSchema,
  inkPackageManifestSchema,
  inkUuidSchema,
  packagedDocumentSchema,
  type InkDisplayVariant,
  type InkFrameSidecar,
  type InkPackageManifest,
  type PackagedDocument,
} from "@/lib/ink/contracts";
import {
  INKOS_APP_DOCUMENT_UUIDS,
  isInkClientAppUrl,
  type InkClientAppUrl,
} from "@/lib/ink/app-actions";
import { ONLINE_PACKAGE_ID } from "@/lib/ink/service-contracts";
import { findExactVariant, inkVariantId } from "@/lib/ink/variants";

import {
  paperS3FrameSize,
  type InkArchiveInstallResult,
  type InkAppPreparationOptions,
  type InkAppPreparationResult,
  type InkClientRuntimeAdapter,
  type InkDisplayPreferences,
  type InkOnlineSourcePreparationOptions,
  type InkOnlinePackagePreparationOptions,
  type InkOnlinePackageResult,
  type InkOnlineSourceProgress,
  type InkOnlineSourceResult,
  type InkOpenRequest,
  type InkRuntimeView,
  type InkSourceMode,
} from "./runtime-adapter";

export const PAPER_S3_PROFILE_ID = "m5stack-paper-s3-portrait";

const catalogItemSchema = z
  .object({
    packageId: inkUuidSchema,
    title: z.string().trim().min(1).max(500).optional(),
    revision: z.number().int().positive().optional(),
    entryUuid: inkUuidSchema.optional(),
  })
  .passthrough();

const catalogSchema = z.union([
  z.array(catalogItemSchema),
  z.object({
    packages: z.array(catalogItemSchema),
    defaultPackageId: inkUuidSchema,
    defaultEntryUuid: inkUuidSchema,
  }).passthrough(),
]);

const jobStatusSchema = z.enum(["queued", "running", "complete", "failed", "cancelled"]);
const jobPhaseSchema = z.enum(["queued", "fetching", "extracting", "rendering", "packaging", "complete"]);
const jobPackageSchema = z.object({ packageId: inkUuidSchema }).passthrough();
const generatorJobSnapshotSchema = z
  .object({
    schemaVersion: z.literal("inkos.generator-job/v1"),
    jobId: inkUuidSchema,
    status: jobStatusSchema,
    phase: jobPhaseSchema,
    progress: z
      .object({
        completed: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
        message: z.string().trim().min(1).max(500),
      })
      .passthrough(),
    statusUrl: z.string().trim().min(1).max(2048),
    package: jobPackageSchema.optional(),
    error: z
      .object({
        code: z.string().trim().min(1).max(128),
        message: z.string().trim().min(1).max(2000),
        retryable: z.boolean(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const sourceResolutionSchema = z
  .object({
    schemaVersion: z.literal("inkos.source-resolution/v1"),
    normalizedUrl: z.url(),
    cached: z.boolean(),
    status: jobStatusSchema,
    job: generatorJobSnapshotSchema.nullable().optional(),
    jobId: inkUuidSchema.optional(),
    statusUrl: z.string().trim().min(1).max(2048).optional(),
    packageId: inkUuidSchema.optional(),
    entryUuid: inkUuidSchema.optional(),
  })
  .passthrough();

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const frameBoundsSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
}).strict();
const frameSizeSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
}).strict();
const onDemandFrameManifestSchema = z.object({
  schemaVersion: z.literal("inkos.frame/v2"),
  rendererVersion: z.string().trim().min(1).max(128),
  frameId: z.string().regex(/^[a-f0-9]{24}$/u),
  documentId: inkUuidSchema,
  documentRevision: z.number().int().positive(),
  contentType: z.enum(["detail", "list", "reader", "image"]),
  screenProfileId: z.literal(PAPER_S3_PROFILE_ID),
  screenProfileVersion: z.number().int().positive(),
  nativeSize: frameSizeSchema,
  logicalSize: frameSizeSchema,
  displayRotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  pixelFormat: z.literal("gray4"),
  layoutStrategy: z.literal("paper-s3-semantic-v1"),
  rasterStrategy: z.literal("eink-gray4-png-v1"),
  displayMeta: z.object({
    orientation: z.enum(["portrait", "landscape"]),
    fontLevel: z.union([z.literal(-2), z.literal(-1), z.literal(0), z.literal(1), z.literal(2)]),
    invert: z.boolean(),
    outputTuning: z.object({
      gamma: z.number().min(0.5).max(2).optional(),
      contrast: z.number().min(0.5).max(2.5).optional(),
      blackPoint: z.number().int().min(0).max(96).optional(),
      whitePoint: z.number().int().min(159).max(255).optional(),
      sharpen: z.number().min(0).max(2).optional(),
      photoContrast: z.number().min(0.5).max(2.5).optional(),
      quantization: z.enum(["uniform-16", "photo-ordered-16"]).optional(),
      supersampling: z.union([z.literal(1), z.literal(2)]).optional(),
    }).strict().optional(),
  }).strict(),
  codec: z.literal("png"),
  pagination: z.object({
    pageIndex: z.number().int().nonnegative(),
    pageCount: z.number().int().positive(),
    hasPrevious: z.boolean(),
    hasNext: z.boolean(),
  }).strict(),
  update: z.object({
    kind: z.enum(["full", "partial"]),
    region: frameBoundsSchema,
  }).strict(),
  refreshHint: z.literal("binary-text").optional(),
  payloadBytes: z.number().int().positive(),
  sha256: sha256Schema,
  crc32: z.string().regex(/^[a-f0-9]{8}$/u),
  interactions: z.array(z.object({
    contentPath: z.string().trim().min(1).max(512),
    label: z.string().trim().min(1).max(500),
    bounds: frameBoundsSchema,
    action: z.discriminatedUnion("type", [
      z.object({ type: z.literal("open-url"), url: z.url().max(2048) }).strict(),
      z.object({ type: z.literal("open-document"), documentId: inkUuidSchema }).strict(),
    ]),
  }).strict()).max(256),
  warnings: z.array(z.string().max(2000)).max(256),
}).strict();
const onDemandWarningsSchema = z.array(z.string().max(2000)).max(256);
const ONLINE_SOURCE_OPENING_MESSAGE = "正在打开网页内容，请稍等。";

type OnDemandFrameManifest = z.infer<typeof onDemandFrameManifestSchema>;

type GeneratorJobSnapshot = z.infer<typeof generatorJobSnapshotSchema>;
type SourceResolution = z.infer<typeof sourceResolutionSchema>;

class InkHttpResponseError extends Error {
  constructor(
    readonly status: number,
    readonly action: string,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface ObjectUrlFactory {
  create(blob: Blob): string;
  revoke(url: string): void;
}

export interface BrowserInkRuntimeOptions {
  readonly apiBaseUrl?: string;
  readonly fetch?: FetchLike;
  readonly objectUrls?: ObjectUrlFactory;
  /** Browser codec seam: an install is not committed until this decodes its entry image. */
  readonly decodeFrame?: (
    image: Uint8Array,
    signal?: AbortSignal,
    mediaType?: "image/png" | "image/jpeg",
  ) => Promise<void>;
  readonly sourcePollIntervalMs?: number;
  readonly sourceMaxPollAttempts?: number;
  /** Deterministic seams for app-action tests; browsers use crypto/time. */
  readonly appNonce?: () => string;
  readonly now?: () => number;
}

interface InstalledArchive {
  readonly filename: string;
  readonly archive: InkArchiveContents;
  readonly imageUrls: Map<string, string>;
}

interface OnlinePackage {
  readonly manifest: InkPackageManifest;
  readonly manifestSha256: string;
  readonly imageUrls: Map<string, string>;
  readonly verifiedPages: Map<string, VerifiedOnlinePage>;
  readonly sourceUrl?: string;
}

interface ActiveAppFrame {
  readonly action: InkClientAppUrl;
  readonly nonce: string;
  readonly requestedAtUnixMs: number;
  readonly display: InkDisplayPreferences;
  readonly document: PackagedDocument;
  readonly sidecar: InkFrameSidecar;
  readonly image: Uint8Array;
  imageUrl?: string;
}

interface VerifiedOnlinePage {
  readonly document: PackagedDocument;
  readonly sidecar: InkFrameSidecar;
  readonly image: Uint8Array;
  readonly mediaType: "image/png" | "image/jpeg";
}

const DEFAULT_DISPLAY: InkDisplayPreferences = {
  orientation: "portrait",
  fontLevel: 0,
  invert: false,
};

/** Browser settings no longer expose reverse polarity; legacy callers are normalized. */
function normalizeBrowserDisplay(display: InkDisplayPreferences = DEFAULT_DISPLAY): InkDisplayPreferences {
  return {
    orientation: display.orientation,
    fontLevel: display.fontLevel,
    invert: false,
  };
}

const WEB_CLIENT_COMPATIBILITY = {
  client: "web" as const,
  version: "1.0.0",
  formatMajor: 1,
  capabilities: [
    "navigation.parent-v1",
    "navigation.hitbox-v1",
    "display.font-level-v1",
    "device.settings-v1",
    "content-ota.atomic-v1",
    "frame.source-image-jpeg-v1",
  ] as const,
  profileIds: [PAPER_S3_PROFILE_ID],
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The request was aborted", "AbortError");
  }
}

function joinUrl(base: string, ...segments: string[]): string {
  return `${base.replace(/\/$/u, "")}/${segments.map(encodeURIComponent).join("/")}`;
}

function requireHttpsSourceUrl(value: string): string {
  if (!value || value !== value.trim() || value.length > 2048) {
    throw new Error("SOURCE_URL_INVALID：请输入不含首尾空格的 HTTPS URL。");
  }
  try {
    if (new URL(value).protocol !== "https:") throw new Error("protocol");
  } catch {
    throw new Error("SOURCE_URL_INVALID：只支持完整的 HTTPS URL。");
  }
  return value;
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) {
    throwIfAborted(signal);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason instanceof Error
        ? signal.reason
        : new DOMException("The request was aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function notifyProgress(
  callback: ((progress: InkOnlineSourceProgress) => void) | undefined,
  progress: InkOnlineSourceProgress,
): void {
  try {
    callback?.(progress);
  } catch {
    // Observability callbacks cannot change a verified package transaction's outcome.
  }
}

async function responseError(response: Response, action: string): Promise<Error> {
  let detail = "";
  let code: string | undefined;
  try {
    const body = await response.clone().json() as {
      code?: unknown;
      detail?: unknown;
      title?: unknown;
    };
    if (typeof body.code === "string") code = body.code;
    if (typeof body.detail === "string") detail = body.detail;
    else if (typeof body.title === "string") detail = body.title;
  } catch {
    // A runtime endpoint may return an empty or non-JSON error body.
  }
  return new InkHttpResponseError(
    response.status,
    action,
    code,
    `${action}失败（HTTP ${response.status}）${detail ? `：${detail}` : ""}`,
  );
}

async function fetchParsed<T>(
  fetcher: FetchLike,
  url: string,
  schema: z.ZodType<T>,
  action: string,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  const response = await fetcher(url, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw await responseError(response, action);
  const value = schema.parse(await response.json());
  throwIfAborted(signal);
  return value;
}

function assertCompatible(manifest: InkPackageManifest): void {
  const compatibility = assessInkCompatibility(manifest, WEB_CLIENT_COMPATIBILITY);
  if (!compatibility.compatible) {
    throw new Error(`PACKAGE_INCOMPATIBLE：${compatibility.errors.join("；")}`);
  }
}

function declaredContentLength(response: Response, expectedBytes: number, action: string): void {
  const value = responseContentLength(response, action);
  if (value !== expectedBytes) {
    throw new Error(`${action}响应的 Content-Length 与包清单不一致（${value} / ${expectedBytes}）。`);
  }
}

function responseContentLength(response: Response, action: string): number {
  const raw = response.headers.get("Content-Length");
  if (raw === null) throw new Error(`${action}响应缺少 Content-Length。`);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
    throw new Error(`${action}响应的 Content-Length 无效。`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${action}响应的 Content-Length 无效。`);
  }
  return value;
}

async function fetchVerifiedArtifact(
  fetcher: FetchLike,
  url: string,
  action: string,
  expectedBytes: number,
  expectedSha256: string,
  expectedManifestSha256: string,
  accept: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  throwIfAborted(signal);
  const response = await fetcher(url, {
    signal,
    cache: "no-store",
    headers: {
      Accept: accept,
      "If-Match": `"${expectedManifestSha256}"`,
    },
  });
  if (!response.ok) throw await responseError(response, action);
  declaredContentLength(response, expectedBytes, action);

  const body = new Uint8Array(await response.arrayBuffer());
  throwIfAborted(signal);
  if (body.byteLength !== expectedBytes) {
    throw new Error(`${action}字节数与包清单不一致（${body.byteLength} / ${expectedBytes}）。`);
  }
  const actualSha256 = await sha256Hex(body);
  throwIfAborted(signal);
  if (actualSha256 !== expectedSha256) throw new Error(`${action}未通过 SHA-256 校验。`);

  const headerSha256 = response.headers.get("X-Ink-SHA256");
  if (headerSha256 !== null && headerSha256 !== expectedSha256) {
    throw new Error(`${action}响应的 X-Ink-SHA256 与包清单不一致。`);
  }
  return body;
}

function parseVerifiedJson<T>(bytes: Uint8Array, schema: z.ZodType<T>, action: string): T {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return schema.parse(JSON.parse(text));
  } catch (error) {
    if (error instanceof z.ZodError) throw error;
    throw new Error(`${action}不是有效的 UTF-8 JSON。`, { cause: error });
  }
}

function decodeFrameInBrowser(
  image: Uint8Array,
  signal?: AbortSignal,
  mediaType: "image/png" | "image/jpeg" = "image/png",
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof Image === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
      reject(new Error("当前环境没有可用的图片解码器。"));
      return;
    }
    throwIfAborted(signal);
    const copied = new Uint8Array(image.byteLength);
    copied.set(image);
    const url = URL.createObjectURL(new Blob([copied], { type: mediaType }));
    const probe = new Image();
    let settled = false;
    const cleanup = () => {
      probe.onload = null;
      probe.onerror = null;
      signal?.removeEventListener("abort", abort);
      URL.revokeObjectURL(url);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(signal?.reason instanceof Error
      ? signal.reason
      : new DOMException("The request was aborted", "AbortError"));
    probe.onload = () => finish();
    probe.onerror = () => finish(new Error("离线包入口帧不是浏览器可解码的图片。"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    else probe.src = url;
  });
}

function displayMeta(display: InkDisplayPreferences) {
  const normalized = normalizeBrowserDisplay(display);
  return {
    orientation: normalized.orientation,
    fontLevel: normalized.fontLevel,
    invert: false,
  };
}

function sameDisplay(
  left: InkDisplayPreferences,
  right: InkDisplayPreferences,
): boolean {
  return left.orientation === right.orientation
    && left.fontLevel === right.fontLevel;
}

function browserAppNonce(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID().toLowerCase();
  }
  if (!globalThis.crypto) throw new Error("浏览器不支持生成应用请求 nonce。");
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function appTitle(action: InkClientAppUrl): string {
  return action === "inkos://app/random-image" ? "图片查看器" : "附近地图";
}

function sanitizedAppDocument(
  action: InkClientAppUrl,
  requestedAtUnixMs: number,
  frame: OnDemandFrameManifest,
): PackagedDocument {
  const uuid = INKOS_APP_DOCUMENT_UUIDS[action];
  const updatedAt = new Date(requestedAtUnixMs).toISOString();
  return packagedDocumentSchema.parse({
    schemaVersion: "inkos.document/v1",
    uuid,
    source: { title: appTitle(action), retrievedAt: updatedAt },
    content: {
      schemaVersion: "inkos.content/v2",
      id: uuid,
      revision: frame.documentRevision,
      locale: "zh-CN",
      updatedAt,
      page: {
        kind: "image",
        layout: action === "inkos://app/random-image" ? "cover" : "contain",
        image: {
          source: { kind: "asset", assetId: "app/server-rendered-image" },
          alt: appTitle(action),
        },
      },
    },
  });
}

function decodeBase64UrlHeader<T>(
  response: Response,
  name: string,
  schema: z.ZodType<T>,
): T {
  const encoded = response.headers.get(name);
  if (!encoded) throw new Error(`按需渲染响应缺少 ${name}。`);
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded) || encoded.length % 4 === 1) {
    throw new Error(`按需渲染响应的 ${name} 不是规范 base64url。`);
  }
  try {
    const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/")
      .padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return schema.parse(JSON.parse(json));
  } catch (error) {
    throw new Error(`按需渲染响应的 ${name} 无法解析。`, { cause: error });
  }
}

function expectedOnDemandVariant(
  manifest: InkPackageManifest,
  display: InkDisplayPreferences,
): InkDisplayVariant {
  const profileVariant = manifest.variants.find((variant) => variant.profileId === PAPER_S3_PROFILE_ID);
  if (!profileVariant) throw new Error("PACKAGE_INCOMPATIBLE：内容包未声明 PaperS3 profile。");
  return {
    id: inkVariantId(PAPER_S3_PROFILE_ID, displayMeta(display)),
    profileId: PAPER_S3_PROFILE_ID,
    screenProfileVersion: profileVariant.screenProfileVersion,
    displayMeta: displayMeta(display),
    logicalSize: paperS3FrameSize(display.orientation),
    displayRotation: display.orientation === "portrait" ? 90 : 0,
    pixelFormat: "gray4",
    codec: "png",
  };
}

function sameBounds(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
): boolean {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}

function assertOnDemandInteractions(
  frame: OnDemandFrameManifest,
  sidecar: InkFrameSidecar,
  packagedUuids: ReadonlySet<string>,
): void {
  if (frame.interactions.length !== sidecar.interactions.length) {
    throw new Error("按需帧 manifest 与 sidecar 的 hitbox 数量不一致。");
  }
  frame.interactions.forEach((interaction, index) => {
    const hitbox = sidecar.interactions[index];
    const targetUuid = interaction.action.type === "open-document"
      ? interaction.action.documentId
      : sidecar.documentUuid;
    const targetUrl = interaction.action.type === "open-url" ? interaction.action.url : undefined;
    if (
      hitbox.id !== interaction.contentPath
      || hitbox.contentPath !== interaction.contentPath
      || hitbox.label !== interaction.label
      || !sameBounds(hitbox.bounds, interaction.bounds)
      || hitbox.targetUuid !== targetUuid
      || hitbox.targetUrl !== targetUrl
    ) {
      throw new Error(`按需帧第 ${index + 1} 个 hitbox 与 frame manifest 不一致。`);
    }
    if (!packagedUuids.has(targetUuid)) {
      throw new Error(`按需帧 hitbox 指向包内不存在的 UUID ${targetUuid}。`);
    }
  });
}

function assertOnDemandFrame(
  manifest: InkPackageManifest,
  index: InkPackageManifest["documents"][number],
  document: PackagedDocument,
  variant: InkDisplayVariant,
  requestedPageIndex: number,
  imageSha256: string,
  imageBytes: number,
  frame: OnDemandFrameManifest,
  sidecar: InkFrameSidecar,
): void {
  const expectedPageIndex = Math.min(requestedPageIndex, frame.pagination.pageCount - 1);
  const expectedSuffix = `/${variant.id}/${index.uuid}/${expectedPageIndex.toString().padStart(4, "0")}.png`;
  if (
    frame.documentId !== index.uuid
    || frame.documentRevision !== document.content.revision
    || frame.contentType !== index.kind
    || frame.screenProfileVersion !== variant.screenProfileVersion
    || frame.nativeSize.width !== 960
    || frame.nativeSize.height !== 540
    || frame.logicalSize.width !== variant.logicalSize.width
    || frame.logicalSize.height !== variant.logicalSize.height
    || frame.displayRotation !== variant.displayRotation
    || frame.displayMeta.orientation !== variant.displayMeta.orientation
    || frame.displayMeta.fontLevel !== variant.displayMeta.fontLevel
    || frame.displayMeta.invert !== variant.displayMeta.invert
    || frame.pagination.pageIndex !== expectedPageIndex
    || frame.pagination.hasPrevious !== (expectedPageIndex > 0)
    || frame.pagination.hasNext !== (expectedPageIndex + 1 < frame.pagination.pageCount)
    || frame.payloadBytes !== imageBytes
    || frame.sha256 !== imageSha256
    || frame.update.kind !== "full"
    || !sameBounds(frame.update.region, { x: 0, y: 0, ...variant.logicalSize })
  ) {
    throw new Error("按需 frame manifest 与请求、文档或 PaperS3 变体不一致。");
  }
  if (
    sidecar.packageId !== manifest.packageId
    || sidecar.documentUuid !== index.uuid
    || sidecar.parentUuid !== index.parentUuid
    || sidecar.variantId !== variant.id
    || sidecar.pageIndex !== frame.pagination.pageIndex
    || sidecar.pageCount !== frame.pagination.pageCount
    || sidecar.imageSha256 !== imageSha256
    || sidecar.logicalSize.width !== variant.logicalSize.width
    || sidecar.logicalSize.height !== variant.logicalSize.height
    || !sidecar.imagePath.endsWith(expectedSuffix)
  ) {
    throw new Error("按需 sidecar 与 package/document/variant/page 不一致。");
  }
  assertOnDemandInteractions(
    frame,
    sidecar,
    new Set(manifest.documents.map((candidate) => candidate.uuid)),
  );
}

function assertAppFrame(
  action: InkClientAppUrl,
  nonce: string,
  requestedPageIndex: number,
  display: InkDisplayPreferences,
  imageSha256: string,
  imageBytes: number,
  frame: OnDemandFrameManifest,
  sidecar: InkFrameSidecar,
): void {
  const documentUuid = INKOS_APP_DOCUMENT_UUIDS[action];
  const logicalSize = paperS3FrameSize(display.orientation);
  const variantId = inkVariantId(PAPER_S3_PROFILE_ID, displayMeta(display));
  const slug = action === "inkos://app/random-image" ? "random-image" : "baidu-map";
  const expectedPath = `apps/${slug}/${nonce}/${variantId}/${documentUuid}/${requestedPageIndex.toString().padStart(4, "0")}.png`;
  if (
    frame.documentId !== documentUuid
    || frame.documentRevision < 1
    || frame.contentType !== "image"
    || frame.screenProfileVersion !== 2
    || frame.nativeSize.width !== 960
    || frame.nativeSize.height !== 540
    || frame.logicalSize.width !== logicalSize.width
    || frame.logicalSize.height !== logicalSize.height
    || frame.displayRotation !== (display.orientation === "portrait" ? 90 : 0)
    || frame.displayMeta.orientation !== display.orientation
    || frame.displayMeta.fontLevel !== display.fontLevel
    || frame.displayMeta.invert !== display.invert
    || frame.pagination.pageIndex !== requestedPageIndex
    || frame.pagination.pageCount < 1
    || frame.pagination.hasPrevious !== (requestedPageIndex > 0)
    || frame.pagination.hasNext !== (requestedPageIndex + 1 < frame.pagination.pageCount)
    || (action === "inkos://app/baidu-map" && frame.pagination.pageCount !== 1)
    || frame.payloadBytes !== imageBytes
    || frame.sha256 !== imageSha256
    || frame.update.kind !== "full"
    || !sameBounds(frame.update.region, { x: 0, y: 0, ...logicalSize })
    || frame.interactions.length !== 0
  ) {
    throw new Error("应用 frame manifest 与动作请求或 PaperS3 变体不一致。");
  }
  if (
    sidecar.packageId !== ONLINE_PACKAGE_ID
    || sidecar.documentUuid !== documentUuid
    || sidecar.parentUuid !== undefined
    || sidecar.variantId !== variantId
    || sidecar.pageIndex !== requestedPageIndex
    || sidecar.pageCount !== frame.pagination.pageCount
    || sidecar.imagePath !== expectedPath
    || sidecar.imageSha256 !== imageSha256
    || sidecar.logicalSize.width !== logicalSize.width
    || sidecar.logicalSize.height !== logicalSize.height
    || sidecar.interactions.length !== 0
    || (sidecar.dynamicRegions?.length ?? 0) !== 0
  ) {
    throw new Error("应用 sidecar 与动作请求或 frame manifest 不一致。");
  }
}

function isPackagedFrameUnavailable(error: unknown): error is InkHttpResponseError {
  return error instanceof InkHttpResponseError
    && error.status === 404
    && (error.action === "读取在线帧" || error.action === "读取在线 sidecar");
}

function isPackageRevisionChanged(error: unknown): error is InkHttpResponseError {
  return error instanceof InkHttpResponseError
    && error.status === 412
    && error.code === "PACKAGE_REVISION_CHANGED";
}

function requireExactHeader(response: Response, name: string, expected: string): void {
  const actual = response.headers.get(name);
  if (actual !== expected) {
    throw new Error(`按需渲染响应的 ${name} 与请求或包清单不一致。`);
  }
}

function requirePaperS3Variant(
  manifest: InkPackageManifest,
  display: InkDisplayPreferences,
): InkDisplayVariant {
  const variant = findExactVariant(manifest, PAPER_S3_PROFILE_ID, displayMeta(display));
  if (!variant) {
    const orientation = display.orientation === "landscape" ? "横屏" : "竖屏";
    throw new Error(`VARIANT_UNAVAILABLE：包内没有 PaperS3 ${orientation} / 字号 ${display.fontLevel} 的正常显示帧。`);
  }
  const expectedSize = paperS3FrameSize(display.orientation);
  if (
    variant.logicalSize.width !== expectedSize.width
    || variant.logicalSize.height !== expectedSize.height
  ) {
    throw new Error(
      `PaperS3 变体 ${variant.id} 的逻辑尺寸不是 ${expectedSize.width} × ${expectedSize.height}。`,
    );
  }
  return variant;
}

function findDocumentIndex(manifest: InkPackageManifest, uuid: string) {
  const index = manifest.documents.find((document) => document.uuid === uuid);
  if (!index) throw new Error(`内容 ${uuid} 不在当前包中。`);
  return index;
}

function findFrame(
  manifest: InkPackageManifest,
  uuid: string,
  variant: InkDisplayVariant,
  requestedPage: number,
) {
  const document = findDocumentIndex(manifest, uuid);
  const frameSet = document.variants.find((candidate) => candidate.variantId === variant.id);
  if (!frameSet) throw new Error(`内容 ${uuid} 缺少变体 ${variant.id}。`);
  const pageIndex = Math.max(0, Math.min(requestedPage, frameSet.pageCount - 1));
  const frame = frameSet.pages.find((candidate) => candidate.pageIndex === pageIndex);
  if (!frame) throw new Error(`内容 ${uuid} 缺少第 ${pageIndex + 1} 页。`);
  return { document, frameSet, frame, pageIndex };
}

function assertDocumentMatches(
  document: PackagedDocument,
  index: InkPackageManifest["documents"][number],
): void {
  if (
    document.uuid !== index.uuid
    || document.parentUuid !== index.parentUuid
    || document.content.page.kind !== index.kind
  ) {
    throw new Error(`文档 ${index.uuid} 与在线包清单不一致。`);
  }
}

function samePackagedSourceImage(
  left: InkFrameSidecar["sourceImage"],
  right: InkPackageManifest["documents"][number]["variants"][number]["pages"][number]["sourceImage"],
): boolean {
  if (!left || !right) return left === right;
  return left.path === right.path
    && left.bytes === right.bytes
    && left.sha256 === right.sha256
    && left.mediaType === right.mediaType
    && left.pixelSize.width === right.pixelSize.width
    && left.pixelSize.height === right.pixelSize.height
    && left.fit === right.fit;
}

function assertSidecarMatches(
  sidecar: InkFrameSidecar,
  manifest: InkPackageManifest,
  document: InkPackageManifest["documents"][number],
  variant: InkDisplayVariant,
  frameSet: InkPackageManifest["documents"][number]["variants"][number],
  frame: InkPackageManifest["documents"][number]["variants"][number]["pages"][number],
): void {
  if (
    sidecar.packageId !== manifest.packageId
    || sidecar.documentUuid !== document.uuid
    || sidecar.parentUuid !== document.parentUuid
    || sidecar.variantId !== variant.id
    || sidecar.pageIndex !== frame.pageIndex
    || sidecar.pageCount !== frameSet.pageCount
    || sidecar.imagePath !== frame.imagePath
    || sidecar.imageSha256 !== frame.imageSha256
    || !samePackagedSourceImage(sidecar.sourceImage, frame.sourceImage)
    || sidecar.logicalSize.width !== variant.logicalSize.width
    || sidecar.logicalSize.height !== variant.logicalSize.height
  ) {
    throw new Error(`第 ${frame.pageIndex + 1} 页的 sidecar 与包清单不一致。`);
  }

  const packagedUuids = new Set(manifest.documents.map((candidate) => candidate.uuid));
  const dangling = sidecar.interactions.find((interaction) => !packagedUuids.has(interaction.targetUuid));
  if (dangling) throw new Error(`sidecar 指向包内不存在的 UUID ${dangling.targetUuid}。`);
}

function toView(
  manifest: InkPackageManifest,
  document: PackagedDocument,
  sidecar: InkFrameSidecar,
  imageUrl: string,
  source: InkRuntimeView["source"],
): InkRuntimeView {
  const titles = new Map(manifest.documents.map((entry) => [entry.uuid, entry.title]));
  return {
    document: {
      uuid: document.uuid,
      ...(document.parentUuid ? { parentUuid: document.parentUuid } : {}),
      kind: document.content.page.kind,
      title: document.source.title,
      revision: document.content.revision,
    },
    page: {
      index: sidecar.pageIndex,
      count: sidecar.pageCount,
      pixelSize: {
        width: sidecar.logicalSize.width,
        height: sidecar.logicalSize.height,
      },
      imageUrl,
      imageAlt: `${document.source.title}，第 ${sidecar.pageIndex + 1} 页`,
      ...(sidecar.dynamicRegions ? { dynamicRegions: sidecar.dynamicRegions } : {}),
      linkHitboxes: sidecar.interactions.map((interaction) => ({
        id: interaction.id,
        label: interaction.label ?? (interaction.targetUrl
          ? (() => {
              try {
                return new URL(interaction.targetUrl).hostname;
              } catch {
                return interaction.contentPath;
              }
            })()
          : titles.get(interaction.targetUuid) ?? interaction.contentPath),
        targetUuid: interaction.targetUuid,
        ...(interaction.targetUrl ? { targetUrl: interaction.targetUrl } : {}),
        bounds: interaction.bounds,
      })),
    },
    source,
  };
}

function archiveBytes(input: File | ArrayBuffer | Uint8Array): Promise<Uint8Array> | Uint8Array {
  if (input instanceof Uint8Array) return new Uint8Array(input);
  if (input instanceof ArrayBuffer) return new Uint8Array(input.slice(0));
  return input.arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

/**
 * Real PaperS3 browser runtime. It executes verified pre-rendered artifacts and
 * deliberately contains no semantic layout code.
 */
export class BrowserInkRuntimeAdapter implements InkClientRuntimeAdapter {
  readonly adapterId = "inkos-browser-package-runtime/v1";

  private readonly apiBaseUrl: string;
  private readonly fetcher: FetchLike;
  private readonly objectUrls: ObjectUrlFactory;
  private readonly decodeFrame: (
    image: Uint8Array,
    signal?: AbortSignal,
    mediaType?: "image/png" | "image/jpeg",
  ) => Promise<void>;
  private readonly sourcePollIntervalMs: number;
  private readonly sourceMaxPollAttempts: number;
  private readonly appNonce: () => string;
  private readonly now: () => number;
  private installed?: InstalledArchive;
  private online?: OnlinePackage;
  private activeApp?: ActiveAppFrame;

  constructor(options: BrowserInkRuntimeOptions = {}) {
    this.apiBaseUrl = options.apiBaseUrl ?? "/api/ink/v1";
    this.fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.objectUrls = options.objectUrls ?? {
      create: (blob) => URL.createObjectURL(blob),
      revoke: (url) => URL.revokeObjectURL(url),
    };
    this.decodeFrame = options.decodeFrame ?? decodeFrameInBrowser;
    this.sourcePollIntervalMs = options.sourcePollIntervalMs ?? 250;
    this.sourceMaxPollAttempts = options.sourceMaxPollAttempts ?? 240;
    this.appNonce = options.appNonce ?? browserAppNonce;
    this.now = options.now ?? Date.now;
  }

  getRootUuid(sourceMode: InkSourceMode): string | undefined {
    return sourceMode === "offline"
      ? this.installed?.archive.manifest.entryUuid
      : this.online?.manifest.entryUuid;
  }

  async resolveRootUuid(sourceMode: InkSourceMode, signal?: AbortSignal): Promise<string> {
    if (sourceMode === "offline") {
      const root = this.installed?.archive.manifest.entryUuid;
      if (!root) throw new Error("请先选择并校验一个 .ink 内容包。包不会上传到服务器。");
      return root;
    }
    return (await this.resolveOnlinePackage(signal)).manifest.entryUuid;
  }

  async prepareOnlineSource(
    rawUrl: string,
    options: InkOnlineSourcePreparationOptions = {},
  ): Promise<InkOnlineSourceResult> {
    const url = requireHttpsSourceUrl(rawUrl);
    const {
      signal,
      onProgress,
      display: legacyDisplay = DEFAULT_DISPLAY,
      expectedPackageId,
      targetUuid,
      pageIndex = 0,
    } = options;
    const display = normalizeBrowserDisplay(legacyDisplay);
    const emit = (progress: InkOnlineSourceProgress) => {
      throwIfAborted(signal);
      notifyProgress(onProgress, progress);
    };
    emit({ phase: "resolving", message: ONLINE_SOURCE_OPENING_MESSAGE });

    const resolverUrl = joinUrl(this.apiBaseUrl, "sources", "resolve");
    const response = await this.fetcher(resolverUrl, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ url, displayMeta: displayMeta(display) }),
      cache: "no-store",
      signal,
    });
    if (!response.ok) throw await responseError(response, "解析在线网页来源");
    const resolution = sourceResolutionSchema.parse(await response.json());
    throwIfAborted(signal);

    if (resolution.status === "failed") {
      throw new Error(`SOURCE_GENERATION_FAILED：${resolution.job?.error?.message ?? "服务端生成失败。"}`);
    }
    if (resolution.status === "cancelled") throw new Error("SOURCE_GENERATION_CANCELLED：服务端已取消生成任务。");
    if (resolution.status === "complete") {
      const packageId = resolution.packageId ?? resolution.job?.package?.packageId;
      if (!packageId) throw new Error("SOURCE_RESOLUTION_INVALID：完成响应缺少 packageId。");
      if (expectedPackageId && packageId !== expectedPackageId) {
        throw new Error("SOURCE_PACKAGE_MISMATCH：分享链接的 package UUID 与服务器解析结果不一致。");
      }
      return this.activateResolvedSource(
        resolution,
        packageId,
        display,
        signal,
        onProgress,
        targetUuid ? { uuid: targetUuid, pageIndex } : undefined,
      );
    }

    if (resolution.job) emit(this.jobProgress(resolution.job));
    const statusUrl = resolution.statusUrl ?? resolution.job?.statusUrl;
    if (!statusUrl) throw new Error("SOURCE_RESOLUTION_INVALID：待处理响应缺少 statusUrl。");
    const resolvedStatusUrl = this.resolveServiceUrl(statusUrl);

    for (let attempt = 0; attempt < this.sourceMaxPollAttempts; attempt += 1) {
      if (attempt > 0) await abortableDelay(this.sourcePollIntervalMs, signal);
      const statusResponse = await this.fetcher(resolvedStatusUrl, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal,
      });
      if (!statusResponse.ok) throw await responseError(statusResponse, "读取网页生成进度");
      const job = generatorJobSnapshotSchema.parse(await statusResponse.json());
      throwIfAborted(signal);
      if (job.jobId !== (resolution.jobId ?? resolution.job?.jobId)) {
        throw new Error("SOURCE_RESOLUTION_INVALID：任务状态的 jobId 与解析响应不一致。");
      }
      if (job.status === "failed") {
        throw new Error(`SOURCE_GENERATION_FAILED：${job.error?.message ?? "服务端生成失败。"}`);
      }
      if (job.status === "cancelled") throw new Error("SOURCE_GENERATION_CANCELLED：服务端已取消生成任务。");
      if (job.status === "complete") {
        if (!job.package?.packageId) throw new Error("SOURCE_RESOLUTION_INVALID：完成任务缺少 packageId。");
        if (expectedPackageId && job.package.packageId !== expectedPackageId) {
          throw new Error("SOURCE_PACKAGE_MISMATCH：分享链接的 package UUID 与服务器解析结果不一致。");
        }
        return this.activateResolvedSource(
          resolution,
          job.package.packageId,
          display,
          signal,
          onProgress,
          targetUuid ? { uuid: targetUuid, pageIndex } : undefined,
        );
      }
      emit(this.jobProgress(job));
    }
    throw new Error(`SOURCE_PREPARATION_TIMEOUT：超过 ${this.sourceMaxPollAttempts} 次轮询仍未完成。`);
  }

  async prepareOnlinePackage(
    rawPackageId: string,
    options: InkOnlinePackagePreparationOptions = {},
  ): Promise<InkOnlinePackageResult> {
    const packageId = inkUuidSchema.parse(rawPackageId);
    const targetUuid = options.targetUuid ? inkUuidSchema.parse(options.targetUuid) : undefined;
    const expectedEntryUuid = options.expectedEntryUuid
      ? inkUuidSchema.parse(options.expectedEntryUuid)
      : undefined;
    const pageIndex = options.pageIndex ?? 0;
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
      throw new Error("SOURCE_PAGE_INVALID：分享链接的页码必须是非负整数。");
    }
    const selected = await this.activateOnlinePackage(
      packageId,
      options.signal,
      expectedEntryUuid,
      undefined,
      normalizeBrowserDisplay(options.display),
      targetUuid ? { uuid: targetUuid, pageIndex } : undefined,
    );
    return { packageId: selected.manifest.packageId, entryUuid: selected.manifest.entryUuid };
  }

  async prepareAppAction(
    action: InkClientAppUrl,
    options: InkAppPreparationOptions = {},
  ): Promise<InkAppPreparationResult> {
    if (!isInkClientAppUrl(action)) throw new Error("APP_ACTION_INVALID：应用动作不在白名单中。");
    const nonce = this.appNonce();
    const requestedAtUnixMs = this.now();
    if (!/^[a-z0-9_-]{16,96}$/u.test(nonce)) {
      throw new Error("APP_NONCE_INVALID：客户端未生成有效的应用 nonce。");
    }
    if (
      !Number.isSafeInteger(requestedAtUnixMs)
      || requestedAtUnixMs < 0
      || requestedAtUnixMs > 4_102_444_800_000
    ) {
      throw new Error("APP_TIMESTAMP_INVALID：客户端应用时间戳无效。");
    }
    const candidate = await this.fetchAppFrame(
      action,
      nonce,
      requestedAtUnixMs,
      normalizeBrowserDisplay(options.display),
      0,
      options.signal,
    );
    throwIfAborted(options.signal);
    const previous = this.activeApp;
    this.activeApp = candidate;
    if (previous?.imageUrl) this.objectUrls.revoke(previous.imageUrl);
    return {
      action,
      documentUuid: candidate.document.uuid,
      nonce,
      requestedAtUnixMs,
    };
  }

  async installArchive(
    input: File | ArrayBuffer | Uint8Array,
    filename?: string,
    signal?: AbortSignal,
    display: InkDisplayPreferences = DEFAULT_DISPLAY,
  ): Promise<InkArchiveInstallResult> {
    display = normalizeBrowserDisplay(display);
    throwIfAborted(signal);
    const bytes = await archiveBytes(input);
    throwIfAborted(signal);
    const archive = await readInkArchive(bytes);
    throwIfAborted(signal);

    assertCompatible(archive.manifest);

    // Signature/header checks are insufficient: make the browser codec decode
    // the selected variant's entry frame before replacing a working package.
    const entryVariant = requirePaperS3Variant(archive.manifest, display);
    const { frame: entryFrame } = findFrame(
      archive.manifest,
      archive.manifest.entryUuid,
      entryVariant,
      0,
    );
    const entryPath = entryFrame.sourceImage?.path ?? entryFrame.imagePath;
    const entryImage = archive.files.get(entryPath);
    if (!entryImage) throw new Error(`离线包缺少入口帧 ${entryPath}。`);
    await this.decodeFrame(
      new Uint8Array(entryImage),
      signal,
      entryFrame.sourceImage ? "image/jpeg" : "image/png",
    );
    throwIfAborted(signal);

    const resolvedFilename = filename
      ?? (typeof File !== "undefined" && input instanceof File ? input.name : `${archive.manifest.slug}.ink`);
    const previous = this.installed;
    this.installed = { archive, filename: resolvedFilename, imageUrls: new Map() };
    this.revoke(previous?.imageUrls);
    return {
      packageId: archive.manifest.packageId,
      title: archive.manifest.title,
      revision: archive.manifest.revision,
      entryUuid: archive.manifest.entryUuid,
      filename: resolvedFilename,
      documentCount: archive.manifest.documents.length,
      variantCount: archive.manifest.variants.length,
    };
  }

  async open(request: InkOpenRequest, signal?: AbortSignal): Promise<InkRuntimeView> {
    throwIfAborted(signal);
    const normalizedRequest = {
      ...request,
      display: normalizeBrowserDisplay(request.display),
    };
    return normalizedRequest.sourceMode === "offline"
      ? this.openOffline(normalizedRequest, signal)
      : this.openOnline(normalizedRequest, signal);
  }

  dispose(): void {
    this.revoke(this.installed?.imageUrls);
    this.revoke(this.online?.imageUrls);
    if (this.activeApp?.imageUrl) this.objectUrls.revoke(this.activeApp.imageUrl);
  }

  private revoke(urls?: Map<string, string>): void {
    if (!urls) return;
    for (const url of urls.values()) {
      try {
        this.objectUrls.revoke(url);
      } catch {
        // URL cleanup must never turn an already-committed package swap into a failed transaction.
      }
    }
    urls.clear();
  }

  private resolveServiceUrl(value: string): string {
    if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) return value;
    if (/^https?:/iu.test(this.apiBaseUrl)) {
      return new URL(value, new URL(this.apiBaseUrl).origin).toString();
    }
    if (value.startsWith("/")) return value;
    return joinUrl(this.apiBaseUrl, value);
  }

  private async fetchAppFrame(
    action: InkClientAppUrl,
    nonce: string,
    requestedAtUnixMs: number,
    display: InkDisplayPreferences,
    pageIndex: number,
    signal?: AbortSignal,
  ): Promise<ActiveAppFrame> {
    throwIfAborted(signal);
    const response = await this.fetcher(joinUrl(this.apiBaseUrl, "apps", "execute"), {
      method: "POST",
      headers: { Accept: "image/png", "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        nonce,
        requestedAtUnixMs,
        pageIndex,
        displayMeta: displayMeta(display),
      }),
      cache: "no-store",
      signal,
    });
    if (!response.ok) throw await responseError(response, "执行墨水屏应用");
    const contentType = response.headers.get("Content-Type")
      ?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "image/png") throw new Error("应用响应不是 image/png。");
    if (response.headers.get("Cache-Control")?.trim().toLowerCase() !== "no-store") {
      throw new Error("应用响应缺少 Cache-Control: no-store。");
    }
    requireExactHeader(response, "X-Ink-App-Action", action);
    requireExactHeader(response, "X-Ink-App-Nonce", nonce);
    requireExactHeader(response, "X-Ink-App-Requested-At", String(requestedAtUnixMs));
    requireExactHeader(response, "X-Ink-App-Page-Index", String(pageIndex));
    const contentLength = responseContentLength(response, "执行墨水屏应用");
    const frame = decodeBase64UrlHeader(
      response,
      "X-Ink-Frame-Manifest",
      onDemandFrameManifestSchema,
    );
    const sidecar = decodeBase64UrlHeader(response, "X-Ink-Sidecar", inkFrameSidecarSchema);
    const warnings = decodeBase64UrlHeader(response, "X-Ink-Warnings", onDemandWarningsSchema);
    const image = new Uint8Array(await response.arrayBuffer());
    throwIfAborted(signal);
    if (image.byteLength !== contentLength) {
      throw new Error(`应用响应字节数与 Content-Length 不一致（${image.byteLength} / ${contentLength}）。`);
    }
    const imageSha256 = await sha256Hex(image);
    throwIfAborted(signal);
    requireExactHeader(response, "X-Ink-SHA256", imageSha256);
    requireExactHeader(response, "ETag", `"${imageSha256}"`);
    if (JSON.stringify(warnings) !== JSON.stringify(frame.warnings)) {
      throw new Error("应用响应的 warnings 与 frame manifest 不一致。");
    }
    assertAppFrame(
      action,
      nonce,
      pageIndex,
      display,
      imageSha256,
      image.byteLength,
      frame,
      sidecar,
    );
    await this.decodeFrame(new Uint8Array(image), signal);
    throwIfAborted(signal);
    return {
      action,
      nonce,
      requestedAtUnixMs,
      display: { ...display },
      document: sanitizedAppDocument(action, requestedAtUnixMs, frame),
      sidecar,
      image,
    };
  }

  private appView(active: ActiveAppFrame): InkRuntimeView {
    if (!active.imageUrl) {
      const copied = new Uint8Array(active.image.byteLength);
      copied.set(active.image);
      active.imageUrl = this.objectUrls.create(new Blob([copied], { type: "image/png" }));
    }
    return {
      document: {
        uuid: active.document.uuid,
        kind: "image",
        title: active.document.source.title,
        revision: active.document.content.revision,
      },
      page: {
        index: active.sidecar.pageIndex,
        count: active.sidecar.pageCount,
        pixelSize: { ...active.sidecar.logicalSize },
        imageUrl: active.imageUrl,
        imageAlt: active.document.source.title,
        linkHitboxes: [],
      },
      source: {
        mode: "online",
        label: "实时应用",
        detail: `${active.document.source.title} · 服务端抓取并渲染`,
        verified: true,
      },
    };
  }

  private jobProgress(job: GeneratorJobSnapshot): InkOnlineSourceProgress {
    return {
      phase: job.phase === "complete" ? "loading-package" : job.phase,
      message: ONLINE_SOURCE_OPENING_MESSAGE,
      completed: job.progress.completed,
      total: job.progress.total,
    };
  }

  private async activateResolvedSource(
    resolution: SourceResolution,
    packageId: string,
    display: InkDisplayPreferences,
    signal?: AbortSignal,
    onProgress?: (progress: InkOnlineSourceProgress) => void,
    stagedTarget?: { uuid: string; pageIndex: number },
  ): Promise<InkOnlineSourceResult> {
    notifyProgress(onProgress, {
      phase: "loading-package",
      message: ONLINE_SOURCE_OPENING_MESSAGE,
    });
    const selected = await this.activateOnlinePackage(
      packageId,
      signal,
      resolution.entryUuid,
      resolution.normalizedUrl,
      display,
      stagedTarget,
    );
    const result = {
      normalizedUrl: resolution.normalizedUrl,
      packageId: selected.manifest.packageId,
      entryUuid: selected.manifest.entryUuid,
      cached: resolution.cached,
    };
    notifyProgress(onProgress, { phase: "ready", message: ONLINE_SOURCE_OPENING_MESSAGE });
    return result;
  }

  private imageUrl(
    urls: Map<string, string>,
    key: string,
    image: Uint8Array,
    mediaType: "image/png" | "image/jpeg" = "image/png",
  ): string {
    const cached = urls.get(key);
    if (cached) return cached;
    const copied = new Uint8Array(image.byteLength);
    copied.set(image);
    const url = this.objectUrls.create(new Blob([copied], { type: mediaType }));
    urls.set(key, url);
    return url;
  }

  private async openOffline(request: InkOpenRequest, signal?: AbortSignal): Promise<InkRuntimeView> {
    const installed = this.installed;
    if (!installed) throw new Error("尚未安装离线 .ink 内容包。请选择文件后再切换到离线模式。");
    const { manifest } = installed.archive;
    const variant = requirePaperS3Variant(manifest, request.display);
    const { document: index, frameSet, frame } = findFrame(manifest, request.uuid, variant, request.pageIndex);
    const document = installed.archive.documents.get(request.uuid);
    const sidecar = installed.archive.sidecars.get(frame.sidecarPath);
    const displayPath = frame.sourceImage?.path ?? frame.imagePath;
    const image = installed.archive.files.get(displayPath);
    if (!document || !sidecar || !image) throw new Error(`离线包缺少内容 ${request.uuid} 的已声明资源。`);
    assertDocumentMatches(document, index);
    assertSidecarMatches(sidecar, manifest, index, variant, frameSet, frame);
    throwIfAborted(signal);

    return toView(
      manifest,
      document,
      sidecar,
      this.imageUrl(
        installed.imageUrls,
        displayPath,
        image,
        frame.sourceImage ? "image/jpeg" : "image/png",
      ),
      {
        mode: "offline",
        label: "离线包",
        detail: `${installed.filename} · ${manifest.title} · r${manifest.revision}`,
        packageId: manifest.packageId,
        packageFilename: installed.filename,
        verified: true,
      },
    );
  }

  private async resolveOnlinePackage(signal?: AbortSignal): Promise<OnlinePackage> {
    if (this.online) return this.online;
    const catalog = await fetchParsed(
      this.fetcher,
      joinUrl(this.apiBaseUrl, "packages"),
      catalogSchema,
      "读取在线内容目录",
      signal,
    );
    if (Array.isArray(catalog)) {
      const selected = catalog[0];
      if (!selected) throw new Error("在线内容目录为空。可安装本地 .ink 包继续浏览。");
      return this.activateOnlinePackage(selected.packageId, signal, selected.entryUuid);
    }

    const selected = catalog.packages.find((candidate) =>
      candidate.packageId === catalog.defaultPackageId,
    );
    if (!selected) {
      throw new Error("在线内容目录的 defaultPackageId 不在 packages 列表中。");
    }
    if (selected.entryUuid !== catalog.defaultEntryUuid) {
      throw new Error("在线内容目录的 defaultEntryUuid 与默认包条目不一致。");
    }
    return this.activateOnlinePackage(
      catalog.defaultPackageId,
      signal,
      catalog.defaultEntryUuid,
    );
  }

  private async activateOnlinePackage(
    packageId: string,
    signal?: AbortSignal,
    expectedEntryUuid?: string,
    sourceUrl?: string,
    stagedDisplay?: InkDisplayPreferences,
    stagedTarget?: { uuid: string; pageIndex: number },
  ): Promise<OnlinePackage> {
    const previous = this.online;
    let candidate = await this.fetchOnlinePackageCandidate(
      packageId,
      signal,
      expectedEntryUuid,
      sourceUrl,
    );
    if (stagedDisplay) {
      const target = stagedTarget ?? { uuid: candidate.manifest.entryUuid, pageIndex: 0 };
      try {
        await this.loadOnlinePage(
          candidate,
          target.uuid,
          target.pageIndex,
          stagedDisplay,
          signal,
          { decodePackaged: true },
        );
      } catch (error) {
        if (!isPackageRevisionChanged(error)) throw error;
        candidate = await this.fetchOnlinePackageCandidate(
          packageId,
          signal,
          expectedEntryUuid,
          sourceUrl,
        );
        // A second 412 is deliberately not caught: one manifest refresh is the
        // complete recovery budget for this transaction.
        await this.loadOnlinePage(
          candidate,
          target.uuid,
          target.pageIndex,
          stagedDisplay,
          signal,
          { decodePackaged: true },
        );
      }
    }
    throwIfAborted(signal);
    if (this.online !== previous) {
      throw new Error("在线包在校验期间已被另一项操作更新，请重试。");
    }
    this.online = candidate;
    this.revoke(previous?.imageUrls);
    return candidate;
  }

  private async fetchOnlinePackageCandidate(
    packageId: string,
    signal?: AbortSignal,
    expectedEntryUuid?: string,
    sourceUrl?: string,
  ): Promise<OnlinePackage> {
    const manifestResponse = await this.fetcher(
      joinUrl(this.apiBaseUrl, "packages", packageId, "manifest"),
      { signal, headers: { Accept: "application/json" }, cache: "no-store" },
    );
    if (!manifestResponse.ok) throw await responseError(manifestResponse, "读取在线包清单");
    if (manifestResponse.status !== 200) {
      throw new Error(`读取在线包清单返回了非预期状态 HTTP ${manifestResponse.status}。`);
    }
    const manifestContentType = manifestResponse.headers.get("Content-Type")
      ?.split(";", 1)[0]?.trim().toLowerCase();
    if (manifestContentType !== "application/json") {
      throw new Error("在线包清单响应不是 application/json。");
    }
    const manifestContentLength = responseContentLength(manifestResponse, "读取在线包清单");
    const manifestBytes = new Uint8Array(await manifestResponse.arrayBuffer());
    throwIfAborted(signal);
    if (manifestBytes.byteLength !== manifestContentLength) {
      throw new Error("在线包清单字节数与 Content-Length 不一致。");
    }
    const manifestSha256 = await sha256Hex(manifestBytes);
    throwIfAborted(signal);
    requireExactHeader(manifestResponse, "X-Ink-SHA256", manifestSha256);
    requireExactHeader(manifestResponse, "ETag", `"${manifestSha256}"`);
    requireExactHeader(manifestResponse, "X-Ink-Package-Id", packageId);
    const manifest = parseVerifiedJson(manifestBytes, inkPackageManifestSchema, "在线包清单");
    if (manifest.packageId !== packageId) throw new Error("目标 packageId 与包清单不一致。");
    requireExactHeader(manifestResponse, "X-Ink-Package-Revision", String(manifest.revision));
    if (expectedEntryUuid && manifest.entryUuid !== expectedEntryUuid) {
      throw new Error("目标 entryUuid 与包清单不一致。");
    }
    assertCompatible(manifest);
    throwIfAborted(signal);
    return {
      manifest,
      manifestSha256,
      imageUrls: new Map(),
      verifiedPages: new Map(),
      ...(sourceUrl ? { sourceUrl } : {}),
    };
  }

  private onlinePageKey(variantId: string, uuid: string, pageIndex: number): string {
    return `${variantId}/${uuid}/${pageIndex}`;
  }

  private async fetchOnlinePage(
    online: OnlinePackage,
    index: InkPackageManifest["documents"][number],
    frameSet: InkPackageManifest["documents"][number]["variants"][number],
    frame: InkPackageManifest["documents"][number]["variants"][number]["pages"][number],
    variant: InkDisplayVariant,
    pageIndex: number,
    signal?: AbortSignal,
  ): Promise<VerifiedOnlinePage> {
    const { manifest, manifestSha256 } = online;
    const packageBase = ["packages", manifest.packageId] as const;
    // Always authenticate the semantic document before treating a stale frame
    // artifact as eligible for the on-demand fallback.
    const documentBytes = await fetchVerifiedArtifact(
      this.fetcher,
      joinUrl(this.apiBaseUrl, ...packageBase, "documents", index.uuid),
      "读取在线文档",
      index.documentBytes,
      index.documentSha256,
      manifestSha256,
      "application/json",
      signal,
    );
    const document = parseVerifiedJson(documentBytes, packagedDocumentSchema, "在线文档");
    assertDocumentMatches(document, index);

    const [sidecarResult, imageResult] = await Promise.allSettled([
      fetchVerifiedArtifact(
        this.fetcher,
        joinUrl(
          this.apiBaseUrl,
          ...packageBase,
          "frames",
          variant.id,
          index.uuid,
          String(pageIndex),
          "sidecar",
        ),
        "读取在线 sidecar",
        frame.sidecarBytes,
        frame.sidecarSha256,
        manifestSha256,
        "application/json",
        signal,
      ),
      fetchVerifiedArtifact(
        this.fetcher,
        joinUrl(
          this.apiBaseUrl,
          ...packageBase,
          "frames",
          variant.id,
          index.uuid,
          String(pageIndex),
        ),
        "读取在线帧",
        frame.imageBytes,
        frame.imageSha256,
        manifestSha256,
        "image/png",
        signal,
      ),
    ]);

    const failures = [sidecarResult, imageResult]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason as unknown);
    const integrityFailure = failures.find((error) => !isPackagedFrameUnavailable(error));
    if (integrityFailure) throw integrityFailure;

    let sidecar: InkFrameSidecar | undefined;
    if (sidecarResult.status === "fulfilled") {
      sidecar = parseVerifiedJson(sidecarResult.value, inkFrameSidecarSchema, "在线 sidecar");
      assertSidecarMatches(sidecar, manifest, index, variant, frameSet, frame);
    }
    const unavailable = failures.find(isPackagedFrameUnavailable);
    if (unavailable) throw unavailable;
    if (!sidecar || imageResult.status !== "fulfilled") {
      throw new Error("在线帧校验未产生完整结果。");
    }
    throwIfAborted(signal);
    return {
      document,
      sidecar,
      image: imageResult.value,
      mediaType: "image/png",
    };
  }

  private async fetchOnDemandPage(
    online: OnlinePackage,
    index: InkPackageManifest["documents"][number],
    display: InkDisplayPreferences,
    requestedPageIndex: number,
    signal?: AbortSignal,
  ): Promise<{ verified: VerifiedOnlinePage; variant: InkDisplayVariant; key: string }> {
    const { manifest } = online;
    const variant = expectedOnDemandVariant(manifest, display);
    const documentBytes = await fetchVerifiedArtifact(
      this.fetcher,
      joinUrl(this.apiBaseUrl, "packages", manifest.packageId, "documents", index.uuid),
      "读取在线文档",
      index.documentBytes,
      index.documentSha256,
      online.manifestSha256,
      "application/json",
      signal,
    );
    const document = parseVerifiedJson(documentBytes, packagedDocumentSchema, "在线文档");
    assertDocumentMatches(document, index);
    throwIfAborted(signal);

    const response = await this.fetcher(
      joinUrl(this.apiBaseUrl, "packages", manifest.packageId, "render"),
      {
        method: "POST",
        headers: {
          Accept: "image/png",
          "Content-Type": "application/json",
          "If-Match": `"${online.manifestSha256}"`,
        },
        body: JSON.stringify({
          documentUuid: index.uuid,
          manifestSha256: online.manifestSha256,
          displayMeta: displayMeta(display),
          pageIndex: requestedPageIndex,
        }),
        cache: "no-store",
        signal,
      },
    );
    if (!response.ok) throw await responseError(response, "按需渲染在线帧");
    if (response.status !== 200) throw new Error(`按需渲染返回了非预期状态 HTTP ${response.status}。`);

    const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "image/png") throw new Error("按需渲染响应不是 image/png。");
    if (!response.headers.get("Cache-Control")?.toLowerCase().split(",").map((part) => part.trim()).includes("no-store")) {
      throw new Error("按需渲染响应缺少 Cache-Control: no-store。");
    }
    const contentLength = responseContentLength(response, "按需渲染");
    requireExactHeader(response, "X-Ink-Package-Id", manifest.packageId);
    requireExactHeader(response, "X-Ink-Package-Revision", String(manifest.revision));
    requireExactHeader(response, "X-Ink-Manifest-SHA256", online.manifestSha256);
    requireExactHeader(response, "X-Ink-Requested-Page-Index", String(requestedPageIndex));

    const frame = decodeBase64UrlHeader(
      response,
      "X-Ink-Frame-Manifest",
      onDemandFrameManifestSchema,
    );
    const sidecar = decodeBase64UrlHeader(response, "X-Ink-Sidecar", inkFrameSidecarSchema);
    const warnings = decodeBase64UrlHeader(response, "X-Ink-Warnings", onDemandWarningsSchema);
    const image = new Uint8Array(await response.arrayBuffer());
    throwIfAborted(signal);
    if (image.byteLength !== contentLength) {
      throw new Error(`按需渲染响应字节数与 Content-Length 不一致（${image.byteLength} / ${contentLength}）。`);
    }
    const imageSha256 = await sha256Hex(image);
    throwIfAborted(signal);
    requireExactHeader(response, "X-Ink-SHA256", imageSha256);
    requireExactHeader(response, "ETag", `"${imageSha256}"`);
    requireExactHeader(response, "X-Ink-Actual-Page-Index", String(frame.pagination.pageIndex));
    if (JSON.stringify(warnings) !== JSON.stringify(frame.warnings)) {
      throw new Error("按需渲染响应的 warnings 与 frame manifest 不一致。");
    }
    assertOnDemandFrame(
      manifest,
      index,
      document,
      variant,
      requestedPageIndex,
      imageSha256,
      image.byteLength,
      frame,
      sidecar,
    );

    // Decoding is part of the transaction. Nothing is cached and no object URL
    // is created until the browser codec has accepted these exact bytes.
    await this.decodeFrame(new Uint8Array(image), signal);
    throwIfAborted(signal);
    const key = this.onlinePageKey(variant.id, index.uuid, sidecar.pageIndex);
    return {
      verified: { document, sidecar, image, mediaType: "image/png" },
      variant,
      key,
    };
  }

  private async loadOnlinePage(
    online: OnlinePackage,
    uuid: string,
    requestedPageIndex: number,
    display: InkDisplayPreferences,
    signal?: AbortSignal,
    options: { decodePackaged: boolean } = {
      decodePackaged: false,
    },
  ): Promise<{ verified: VerifiedOnlinePage; key: string }> {
    const { manifest } = online;
    const index = findDocumentIndex(manifest, uuid);
    const dynamicVariant = expectedOnDemandVariant(manifest, display);
    const requestKey = this.onlinePageKey(dynamicVariant.id, uuid, requestedPageIndex);
    const cachedRequest = online.verifiedPages.get(requestKey);
    if (cachedRequest) {
      return {
        verified: cachedRequest,
        key: this.onlinePageKey(dynamicVariant.id, uuid, cachedRequest.sidecar.pageIndex),
      };
    }

    const packagedVariant = findExactVariant(manifest, PAPER_S3_PROFILE_ID, displayMeta(display));
    if (packagedVariant) {
      const { frameSet, frame, pageIndex } = findFrame(
        manifest,
        uuid,
        packagedVariant,
        requestedPageIndex,
      );
      const key = this.onlinePageKey(packagedVariant.id, uuid, pageIndex);
      const cached = online.verifiedPages.get(key);
      if (cached) return { verified: cached, key };
      try {
        const verified = await this.fetchOnlinePage(
          online,
          index,
          frameSet,
          frame,
          packagedVariant,
          pageIndex,
          signal,
        );
        if (options.decodePackaged) {
          await this.decodeFrame(
            new Uint8Array(verified.image),
            signal,
            verified.mediaType,
          );
          throwIfAborted(signal);
        }
        online.verifiedPages.set(key, verified);
        return { verified, key };
      } catch (error) {
        if (!isPackagedFrameUnavailable(error)) throw error;
      }
    }

    const rendered = await this.fetchOnDemandPage(
      online,
      index,
      display,
      requestedPageIndex,
      signal,
    );
    throwIfAborted(signal);
    online.verifiedPages.set(rendered.key, rendered.verified);
    if (requestKey !== rendered.key) online.verifiedPages.set(requestKey, rendered.verified);
    return { verified: rendered.verified, key: rendered.key };
  }

  private async openOnline(request: InkOpenRequest, signal?: AbortSignal): Promise<InkRuntimeView> {
    const activeApp = this.activeApp;
    if (activeApp?.document.uuid === request.uuid) {
      if (
        !sameDisplay(activeApp.display, request.display)
        || activeApp.sidecar.pageIndex !== request.pageIndex
      ) {
        const candidate = await this.fetchAppFrame(
          activeApp.action,
          activeApp.nonce,
          activeApp.requestedAtUnixMs,
          request.display,
          request.pageIndex,
          signal,
        );
        throwIfAborted(signal);
        if (this.activeApp !== activeApp) {
          throw new Error("应用在重新渲染期间已被另一项操作替换，请重试。");
        }
        this.activeApp = candidate;
        if (activeApp.imageUrl) this.objectUrls.revoke(activeApp.imageUrl);
        return this.appView(candidate);
      }
      return this.appView(activeApp);
    }
    let online = await this.resolveOnlinePackage(signal);
    let loaded: { verified: VerifiedOnlinePage; key: string };
    let preparedImageUrl: string | undefined;
    try {
      loaded = await this.loadOnlinePage(
        online,
        request.uuid,
        request.pageIndex,
        request.display,
        signal,
      );
    } catch (error) {
      if (!isPackageRevisionChanged(error)) throw error;
      const previous = online;
      const candidate = await this.fetchOnlinePackageCandidate(
        previous.manifest.packageId,
        signal,
        undefined,
        previous.sourceUrl,
      );
      // Stage and browser-decode the same logical request against the new
      // manifest. Missing UUIDs, corrupt manifests and a second 412 all leave
      // the working package untouched.
      loaded = await this.loadOnlinePage(
        candidate,
        request.uuid,
        request.pageIndex,
        request.display,
        signal,
        { decodePackaged: true },
      );
      throwIfAborted(signal);
      preparedImageUrl = this.imageUrl(
        candidate.imageUrls,
        loaded.key,
        loaded.verified.image,
        loaded.verified.mediaType,
      );
      if (this.online !== previous) {
        this.revoke(candidate.imageUrls);
        throw new Error("在线包在刷新期间已被另一项操作更新，请重试。");
      }
      this.online = candidate;
      online = candidate;
      this.revoke(previous.imageUrls);
    }
    const { manifest } = online;
    const { verified, key } = loaded;

    return toView(
      manifest,
      verified.document,
      verified.sidecar,
      preparedImageUrl ?? this.imageUrl(
        online.imageUrls,
        key,
        verified.image,
        verified.mediaType,
      ),
      {
        mode: "online",
        label: "在线包",
        detail: `${manifest.title} · revision ${manifest.revision}${online.sourceUrl ? ` · ${online.sourceUrl}` : ""}`,
        packageId: manifest.packageId,
        ...(online.sourceUrl ? { sourceUrl: online.sourceUrl } : {}),
        verified: true,
      },
    );
  }
}
