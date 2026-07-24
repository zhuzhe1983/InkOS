import { createHash } from "node:crypto";

import { z } from "zod";

import {
  displayMetaSchema,
  type DisplayMeta,
} from "../../rendering/contracts";
import {
  getInkCatalogPackage,
  type LoadedInkCatalogPackage,
} from "../catalog-store";
import { outputTuningKey } from "../variants";
import {
  createGeneratorJob,
  type GeneratorStoreError,
} from "./job-store";
import {
  enqueueGeneratorJob,
  INKOS_WEB_GENERATOR_VERSION,
  INKOS_WEB_PACKAGE_REVISION,
} from "./runner";
import {
  normalizeSourceIdentityUrl,
  sourceDocumentUuid,
  sourcePackageUuid,
} from "./transform";
import type { GeneratorJob, GeneratorRequest } from "./contracts";

const PAPER_S3_PROFILE_ID = "m5stack-paper-s3-portrait";
const SOURCE_RESOLUTION_SCHEMA = "inkos.source-resolution/v1" as const;

const credentialFreeHttpsUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => value === value.trim(), "URL cannot have surrounding whitespace")
  .superRefine((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: "custom", message: "Expected an absolute HTTPS URL" });
      return;
    }
    if (url.protocol !== "https:") {
      context.addIssue({ code: "custom", message: "Expected an absolute HTTPS URL" });
    }
    if (url.username || url.password) {
      context.addIssue({ code: "custom", message: "Source URL cannot contain credentials" });
    }
    if (url.port && url.port !== "443") {
      context.addIssue({ code: "custom", message: "Source URL must use the default HTTPS port" });
    }
  });

export const sourceResolveRequestSchema = z
  .object({
    url: credentialFreeHttpsUrlSchema,
    displayMeta: displayMetaSchema.default({
      orientation: "portrait",
      fontLevel: 0,
      invert: false,
    }),
  })
  .strict();

export interface SourceResolverDependencies {
  getPackage?: (packageId: string) => Promise<LoadedInkCatalogPackage | undefined>;
  createJob?: typeof createGeneratorJob;
  enqueueJob?: (jobId: string) => void;
  now?: () => Date;
}

export interface SourceResolution {
  schemaVersion: typeof SOURCE_RESOLUTION_SCHEMA;
  normalizedUrl: string;
  cached: boolean;
  stale?: boolean;
  revalidatingJobId?: string;
  expectedEntryUuid: string;
  expectedPackageId: string;
  status: GeneratorJob["status"];
  job: GeneratorJob | null;
  jobId?: string;
  statusUrl?: string;
  eventsUrl?: string;
  packageId?: string;
  entryUuid?: string;
  revision?: number;
  title?: string;
  manifestUrl?: string;
  downloadUrl?: string;
}

function safeTitleHint(normalizedUrl: string): string {
  const url = new URL(normalizedUrl);
  const encodedSegment = url.pathname.split("/").filter(Boolean).at(-1);
  let segment = encodedSegment ?? "";
  try {
    segment = decodeURIComponent(segment);
  } catch {
    // Keep the URL-encoded path segment if it is not valid percent encoding.
  }
  const cleaned = segment
    .normalize("NFC")
    .replace(/[_-]+/gu, " ")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return (cleaned || url.hostname).slice(0, 500);
}

export function normalizeResolvableSourceUrl(value: string): string {
  const parsed = credentialFreeHttpsUrlSchema.parse(value);
  const url = new URL(parsed);
  url.hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (url.port === "443") url.port = "";
  return normalizeSourceIdentityUrl(url.href);
}

const DEFAULT_SOURCE_DISPLAY_META: DisplayMeta = {
  orientation: "portrait",
  fontLevel: 0,
  invert: false,
};

function normalizedDisplayMeta(rawDisplayMeta: DisplayMeta = DEFAULT_SOURCE_DISPLAY_META): DisplayMeta {
  return displayMetaSchema.parse(rawDisplayMeta);
}

export function sourceResolutionIdempotencyKey(
  normalizedUrl: string,
  rawDisplayMeta: DisplayMeta = DEFAULT_SOURCE_DISPLAY_META,
  freshnessEpoch = 0,
): string {
  const displayMeta = normalizedDisplayMeta(rawDisplayMeta);
  const digest = createHash("sha256")
    .update([
      INKOS_WEB_GENERATOR_VERSION,
      normalizedUrl,
      displayMeta.orientation,
      String(displayMeta.fontLevel),
      outputTuningKey(displayMeta),
      String(freshnessEpoch),
    ].join("\0"))
    .digest("hex");
  return `inkos-source-resolve-v1:${digest}`;
}

export function generatorRequestForSource(
  normalizedUrl: string,
  rawDisplayMeta: DisplayMeta = DEFAULT_SOURCE_DISPLAY_META,
): GeneratorRequest {
  const displayMeta = normalizedDisplayMeta(rawDisplayMeta);
  return {
    seedUrl: normalizedUrl,
    title: safeTitleHint(normalizedUrl),
    sourceMode: "chromium",
    deliveryMode: "realtime",
    maxDepth: 0,
    maxDocuments: 1,
    profileIds: [PAPER_S3_PROFILE_ID],
    orientations: [displayMeta.orientation],
    fontLevels: [displayMeta.fontLevel],
    ...(displayMeta.outputTuning ? { outputTuning: displayMeta.outputTuning } : {}),
  };
}

export const DEFAULT_SOURCE_CACHE_TTL_MS = 3 * 60 * 1_000;

function sourceCacheTtlMs(): number {
  const parsed = Number.parseInt(process.env.INKOS_SOURCE_CACHE_TTL_MS ?? "", 10);
  return Number.isInteger(parsed) && parsed >= 10_000 && parsed <= 24 * 60 * 60 * 1_000
    ? parsed
    : DEFAULT_SOURCE_CACHE_TTL_MS;
}

function packageRetrievedAt(loaded: LoadedInkCatalogPackage): number | undefined {
  const value = loaded.manifest.provenance?.seeds?.[0]?.retrievedAt;
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function packageFields(loaded: LoadedInkCatalogPackage) {
  const packageId = loaded.manifest.packageId;
  const baseUrl = `/api/ink/v1/packages/${encodeURIComponent(packageId)}`;
  return {
    packageId,
    entryUuid: loaded.manifest.entryUuid,
    revision: loaded.manifest.revision,
    title: loaded.manifest.title,
    manifestUrl: `${baseUrl}/manifest`,
    downloadUrl: `${baseUrl}/download`,
  };
}

export async function resolveSource(
  rawRequest: unknown,
  dependencies: SourceResolverDependencies = {},
): Promise<SourceResolution> {
  const request = sourceResolveRequestSchema.parse(rawRequest);
  const normalizedUrl = normalizeResolvableSourceUrl(request.url);
  const expectedEntryUuid = sourceDocumentUuid(normalizedUrl);
  const expectedPackageId = sourcePackageUuid(normalizedUrl);
  const getPackage = dependencies.getPackage ?? ((packageId) => getInkCatalogPackage(packageId));
  const now = (dependencies.now ?? (() => new Date()))();
  const cacheTtlMs = sourceCacheTtlMs();
  const freshnessEpoch = Math.floor(now.getTime() / cacheTtlMs);

  const published = await getPackage(expectedPackageId);
  const reusable = Boolean(
    published
    && published.manifest.generator.name === "inkos-web-generator"
    && published.manifest.generator.version === INKOS_WEB_GENERATOR_VERSION
    && published.manifest.revision >= INKOS_WEB_PACKAGE_REVISION
  );
  const retrievedAt = published ? packageRetrievedAt(published) : undefined;
  const stale = reusable && retrievedAt !== undefined && now.getTime() - retrievedAt >= cacheTtlMs;
  if (published && reusable && !stale) {
    return {
      schemaVersion: SOURCE_RESOLUTION_SCHEMA,
      normalizedUrl,
      cached: true,
      expectedEntryUuid,
      expectedPackageId,
      status: "complete",
      job: null,
      ...packageFields(published),
    };
  }

  const createJob = dependencies.createJob ?? createGeneratorJob;
  const created = await createJob(
    generatorRequestForSource(normalizedUrl, request.displayMeta),
    sourceResolutionIdempotencyKey(normalizedUrl, request.displayMeta, freshnessEpoch),
  );
  if (created.created) (dependencies.enqueueJob ?? enqueueGeneratorJob)(created.job.jobId);

  // Stale-while-revalidate: an existing verified package is still the fastest
  // trustworthy frame. Refresh it in the foreground queue without making the
  // client wait for Chromium again.
  if (published && reusable) {
    return {
      schemaVersion: SOURCE_RESOLUTION_SCHEMA,
      normalizedUrl,
      cached: true,
      stale: true,
      revalidatingJobId: created.job.jobId,
      expectedEntryUuid,
      expectedPackageId,
      status: "complete",
      job: null,
      ...packageFields(published),
    };
  }

  const actualPackage = created.job.package
    ? await getPackage(created.job.package.packageId)
    : undefined;
  return {
    schemaVersion: SOURCE_RESOLUTION_SCHEMA,
    normalizedUrl,
    cached: !created.created,
    expectedEntryUuid,
    expectedPackageId,
    status: created.job.status,
    job: created.job,
    jobId: created.job.jobId,
    statusUrl: created.job.statusUrl,
    eventsUrl: created.job.eventsUrl,
    ...(actualPackage
      ? packageFields(actualPackage)
      : created.job.package
        ? { packageId: created.job.package.packageId }
        : {}),
  };
}

export function isIdempotencyConflict(
  error: unknown,
): error is GeneratorStoreError & { code: "IDEMPOTENCY_CONFLICT" } {
  return error instanceof Error
    && "code" in error
    && error.code === "IDEMPOTENCY_CONFLICT";
}
