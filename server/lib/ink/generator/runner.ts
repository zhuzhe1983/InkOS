import { createHash } from "node:crypto";

import {
  buildRenderedInkPackage,
  createInkDisplayVariant,
  type BuiltInkPackage,
  type InkPackageBuildInput,
} from "../package-builder";
import {
  GeneratorJobCancelled,
  createGeneratorJob,
  failGeneratorJob,
  publishGeneratorArtifact,
  readGeneratorJob,
  readGeneratorRequest,
  updateGeneratorJob,
} from "./job-store";
import {
  ingestSource,
  SourceIngestionError,
  type SourceIngestionRequest,
  type SourceIngestionResult,
} from "./source";
import { transformIngestedSource } from "./transform";
import { ControlledRemoteAssetResolver } from "../../rendering/asset-resolver";
import { RenderEngine } from "../../rendering/engine";
import type { ContentImage } from "../../rendering/contracts";
import { expandImagePreviewDocuments } from "../image-previews";

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const scheduledJobs = new Map<string, Promise<void>>();
const foregroundQueue: QueuedGeneratorJob[] = [];
const backgroundQueue: QueuedGeneratorJob[] = [];
let runningJobs = 0;

// Bump whenever capture/extraction semantics change so a previously failed or
// stale source job cannot mask the repaired pipeline through idempotency/cache.
export const INKOS_WEB_GENERATOR_VERSION = "2.4.11";
/** Minimum revision that can be displayed immediately. */
export const INKOS_WEB_PACKAGE_REVISION = 17;
/** Complete crawl/image expansion produced outside the first-frame path. */
export const INKOS_WEB_ARCHIVE_REVISION = 18;

const REALTIME_FEED_ITEMS = 16;
// Foreground URL opens must publish quickly even for whole-book HTML files.
// Four semantic blocks retain the title plus the first substantial reading
// section; the complete revision is rendered by the reserved background queue.
const REALTIME_DETAIL_BLOCKS = 4;
const REALTIME_IMAGE_PREVIEWS = 6;

interface QueuedGeneratorJob {
  jobId: string;
  resolve: () => void;
}

function generatorConcurrency(): number {
  const parsed = Number.parseInt(process.env.INKOS_GENERATOR_CONCURRENCY ?? "2", 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 8 ? parsed : 2;
}

export function remoteImageHosts(documents: InkPackageBuildInput["documents"]): string[] {
  const hosts = new Set<string>();
  const addImage = (image: ContentImage | undefined) => {
    if (!image || image.source.kind !== "remote") return;
    try {
      const url = new URL(image.source.url);
      if (
        url.protocol !== "https:"
        || url.username
        || url.password
        || (url.port && url.port !== "443")
      ) return;
      const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
      if (hostname) hosts.add(hostname);
    } catch {
      // Content schemas reject malformed remote URLs before rendering. Keep
      // this discovery seam defensive because it defines a network allowlist.
    }
  };

  for (const document of documents) {
    const page = document.content.page;
    switch (page.kind) {
      case "detail":
        addImage(page.heroImage);
        for (const block of page.content) {
          if (block.type === "image") addImage(block.image);
        }
        break;
      case "list":
        for (const item of page.items) addImage(item.image);
        break;
      case "image":
        addImage(page.image);
        break;
      case "reader":
        break;
    }
  }
  return [...hosts].sort();
}

export interface GeneratorRunnerDependencies {
  ingest?: (request: SourceIngestionRequest) => Promise<SourceIngestionResult>;
  build?: (input: InkPackageBuildInput) => Promise<BuiltInkPackage>;
}

function safeSlug(title: string, packageId: string): string {
  const ascii = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return ascii || `ink-${packageId.slice(0, 8)}`;
}

async function progress(
  jobId: string,
  phase: "fetching" | "extracting" | "rendering" | "packaging",
  completed: number,
  total: number,
  message: string,
): Promise<void> {
  await updateGeneratorJob(jobId, (job) => ({
    ...job,
    status: "running",
    phase,
    progress: { completed, total, message },
    updatedAt: new Date().toISOString(),
    error: undefined,
  }));
}

async function recordTimings(jobId: string, timings: Record<string, number>): Promise<void> {
  await updateGeneratorJob(jobId, (job) => ({
    ...job,
    timings: {
      ...(job.timings ?? {}),
      ...Object.fromEntries(Object.entries(timings).map(([key, value]) => [key, Math.max(0, Math.round(value))])),
    },
    updatedAt: new Date().toISOString(),
  }));
}

async function scheduleArchiveUpgrade(
  foregroundJobId: string,
  request: Awaited<ReturnType<typeof readGeneratorRequest>>,
): Promise<void> {
  if (request.deliveryMode !== "realtime") return;
  const archiveRequest = {
    ...request,
    deliveryMode: "archive" as const,
    maxDepth: Math.max(1, request.maxDepth),
    maxDocuments: Math.max(4, request.maxDocuments),
  };
  const digest = createHash("sha256")
    .update(`${INKOS_WEB_GENERATOR_VERSION}\0${foregroundJobId}\0${request.seedUrl}`)
    .digest("hex");
  const created = await createGeneratorJob(
    archiveRequest,
    `inkos-source-archive-v2:${digest}`,
  );
  if (created.created) enqueueGeneratorJob(created.job.jobId, "background");
}

export async function runGeneratorJob(
  jobId: string,
  dependencies: GeneratorRunnerDependencies = {},
): Promise<void> {
  let currentPhase: "fetching" | "extracting" | "rendering" | "packaging" = "fetching";
  const totalStartedAt = performance.now();
  try {
    const initial = await readGeneratorJob(jobId);
    if (initial.status === "complete" || initial.status === "failed" || initial.status === "cancelled") return;
    const request = await readGeneratorRequest(jobId);
    await progress(
      jobId,
      "fetching",
      0,
      1,
      request.sourceMode === "chromium"
        ? "正在用 Chromium 执行网页并等待主要内容稳定"
        : "正在安全抓取来源网页",
    );
    const ingestionStartedAt = performance.now();
    const ingestion = await (dependencies.ingest ?? ingestSource)({
      seedUrl: request.seedUrl,
      maxDepth: request.maxDepth,
      maxDocuments: request.maxDocuments,
      mode: request.sourceMode,
    });
    await recordTimings(jobId, {
      ingest_ms: performance.now() - ingestionStartedAt,
      ...(ingestion.timings ?? {}),
    });

    currentPhase = "extracting";
    await progress(
      jobId,
      "extracting",
      0,
      ingestion.pages.length,
      request.sourceMode === "chromium"
        ? "正在把 Markdown 转换为 InkOS 结构化内容"
        : "正在转换结构化文档与 UUID 层级",
    );
    const transformStartedAt = performance.now();
    const realtime = request.deliveryMode === "realtime";
    const transformed = transformIngestedSource(ingestion, realtime
      ? { maxFeedItems: REALTIME_FEED_ITEMS, maxDetailBlocks: REALTIME_DETAIL_BLOCKS }
      : {});
    await recordTimings(jobId, { transform_ms: performance.now() - transformStartedAt });
    await progress(
      jobId,
      "extracting",
      ingestion.pages.length,
      ingestion.pages.length,
      `已提取 ${ingestion.pages.length} 篇文档`,
    );

    const variants = request.profileIds.flatMap((profileId) =>
      request.orientations.flatMap((orientation) =>
        request.fontLevels.map((fontLevel) => createInkDisplayVariant(profileId, {
          orientation,
          fontLevel,
          invert: false,
          ...(request.outputTuning ? { outputTuning: request.outputTuning } : {}),
        })),
      ),
    );
    const maximumPreviews = realtime ? REALTIME_IMAGE_PREVIEWS : Number.POSITIVE_INFINITY;
    const expandedDocumentCount = expandImagePreviewDocuments(
      transformed.documents,
      undefined,
      maximumPreviews,
    ).documents.length;
    const renderTotal = expandedDocumentCount * variants.length;
    const renderPlanLabel = `${expandedDocumentCount} 份内容 × ${variants.length} 种显示配置`;
    currentPhase = "rendering";
    await progress(
      jobId,
      "rendering",
      0,
      renderTotal,
      `正在生成离线显示帧（${renderPlanLabel}）`,
    );
    const entryPage = ingestion.pages.find((page) => page.canonicalUrl === ingestion.entryCanonicalUrl)!;
    const packageInput: InkPackageBuildInput = {
      packageId: transformed.packageId,
      slug: safeSlug(request.title, transformed.packageId),
      revision: realtime ? INKOS_WEB_PACKAGE_REVISION : INKOS_WEB_ARCHIVE_REVISION,
      title: entryPage.title,
      entryUuid: transformed.entryUuid,
      createdAt: initial.createdAt,
      generator: { name: "inkos-web-generator", version: INKOS_WEB_GENERATOR_VERSION },
      provenance: {
        seeds: [{
          url: ingestion.seedUrl,
          title: entryPage.title,
          retrievedAt: entryPage.provenance.retrievedAt,
          ...(entryPage.license?.name ? { license: entryPage.license.name } : {}),
        }],
        crawl: ingestion.limits,
      },
      variants,
      documents: transformed.documents,
      ...(realtime ? { maxImagePreviewDocuments: REALTIME_IMAGE_PREVIEWS } : {}),
    };
    const build = dependencies.build;
    const jobRenderEngine = new RenderEngine({
      assetResolver: new ControlledRemoteAssetResolver({
        allowedSourceHosts: remoteImageHosts(transformed.documents),
        allowPublicRedirectHosts: true,
      }),
    });
    const renderStartedAt = performance.now();
    const built = build
      ? await build(packageInput)
      : await buildRenderedInkPackage(packageInput, jobRenderEngine, {
          onVariantRendered: async ({ completed, total }) => {
            await progress(
              jobId,
              "rendering",
              completed,
              total,
              `正在生成离线显示帧：${completed} / ${total}（${renderPlanLabel}）`,
            );
          },
          onPackaging: async () => {
            currentPhase = "packaging";
            await progress(jobId, "packaging", 0, 1, "正在校验清单、摘要与压缩包");
          },
        });
    await recordTimings(jobId, { render_package_ms: performance.now() - renderStartedAt });
    if (built.archive.byteLength > MAX_ARTIFACT_BYTES) {
      throw new Error(`Generated package exceeds ${MAX_ARTIFACT_BYTES} bytes`);
    }
    currentPhase = "packaging";
    await progress(jobId, "packaging", 1, 1, "压缩包验证完成，正在原子发布");
    const fileName = `${built.manifest.slug}-r${built.manifest.revision}.ink`;
    await publishGeneratorArtifact(jobId, built.archive, {
      packageId: built.manifest.packageId,
      fileName,
      bytes: built.archive.byteLength,
      sha256: built.sha256,
    });
    await recordTimings(jobId, { total_ms: performance.now() - totalStartedAt });
    // A complete archive is deliberately outside the foreground critical path.
    // Failure to enqueue it must not invalidate the already published draft.
    void scheduleArchiveUpgrade(jobId, request).catch(() => undefined);
  } catch (error) {
    if (error instanceof GeneratorJobCancelled) return;
    const sourceError = error instanceof SourceIngestionError ? error : undefined;
    const code = sourceError?.code
      ?? (currentPhase === "rendering" ? "RENDER_FAILED" : currentPhase === "packaging" ? "PACKAGE_INVALID" : "INTERNAL_ERROR");
    await failGeneratorJob(jobId, {
      code,
      message: (error instanceof Error ? error.message : "Unknown generator failure").slice(0, 2000),
      retryable: sourceError?.retryable ?? false,
    });
  }
}

function pumpGeneratorQueue(): void {
  while (runningJobs < generatorConcurrency()) {
    // Background completeness work uses at most one slot and starts only when
    // the foreground queue is drained. A newly arriving user request can then
    // always take the reserved slot immediately.
    const queued = foregroundQueue.shift()
      ?? (runningJobs === 0 ? backgroundQueue.shift() : undefined);
    if (!queued) return;
    runningJobs += 1;
    void runGeneratorJob(queued.jobId).finally(() => {
      runningJobs -= 1;
      scheduledJobs.delete(queued.jobId);
      queued.resolve();
      pumpGeneratorQueue();
    });
  }
}

export function enqueueGeneratorJob(
  jobId: string,
  priority: "foreground" | "background" = "foreground",
): void {
  if (scheduledJobs.has(jobId)) return;
  let resolve!: () => void;
  const pending = new Promise<void>((done) => {
    resolve = done;
  });
  scheduledJobs.set(jobId, pending);
  (priority === "foreground" ? foregroundQueue : backgroundQueue).push({ jobId, resolve });
  queueMicrotask(pumpGeneratorQueue);
}

export async function waitForGeneratorJob(jobId: string): Promise<void> {
  await scheduledJobs.get(jobId);
}
