import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { readInkArchive, sha256Hex, type InkArchiveContents } from "./archive";
import {
  ensurePaperS3HomePackage,
  PAPERS3_HOME_PACKAGE_ID,
} from "./builtin/papers3-home";
import { inkUuidSchema, type InkPackageManifest } from "./contracts";

const JOB_FILE_NAME = "job.json";
const ARTIFACT_FILE_NAME = "artifact.ink";
const MANIFEST_PATH = "ink-manifest.json";
const MAX_JOB_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const SAFE_JOB_DIRECTORY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const VARIANT_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const PAGE_INDEX = /^(?:0|[1-9][0-9]{0,5})$/u;
const MAX_CATALOG_VALIDATION_CACHE_ENTRIES = 256;

const packageFileNameSchema = z
  .string()
  .min(5)
  .max(255)
  .refine((value) => value.toLowerCase().endsWith(".ink"), "Expected an .ink file name")
  .refine(
    (value) =>
      path.basename(value) === value &&
      !value.includes("\\") &&
      !/[\u0000-\u001f\u007f]/u.test(value),
    "Expected a safe base file name",
  );

const completedJobSchema = z
  .object({
    status: z.literal("complete"),
    package: z
      .object({
        packageId: inkUuidSchema,
        fileName: packageFileNameSchema,
        bytes: z.number().int().positive().max(MAX_ARCHIVE_BYTES),
        sha256: z.string().regex(SHA256),
      })
      .passthrough(),
  })
  .passthrough();

interface CompletedJob {
  jobDirectory: string;
  package: z.infer<typeof completedJobSchema>["package"];
}

export interface InkCatalogStoreOptions {
  dataDir?: string;
}

export interface InkCatalogEntry {
  packageId: string;
  revision: number;
  title: string;
  entryUuid: string;
  fileName: string;
  bytes: number;
  sha256: string;
  manifestUrl: string;
  downloadUrl: string;
}

export interface LoadedInkCatalogPackage {
  manifest: InkPackageManifest;
  contents: InkArchiveContents;
  archive: Uint8Array;
  archiveSha256: string;
  fileName: string;
  manifestSha256: string;
}

export interface InkCatalogArtifact {
  bytes: Uint8Array;
  contentType: string;
  sha256: string;
  cacheControl: string;
  fileName?: string;
}

interface PublishedCatalogEntry {
  entry: InkCatalogEntry;
  revision: number;
  createdAt: string;
  archiveSha256: string;
}

interface CatalogValidationCacheEntry {
  candidate: PublishedCatalogEntry | undefined;
}

interface CatalogValidationCacheStats {
  hits: number;
  misses: number;
  validations: number;
}

const catalogValidationCache = new Map<string, CatalogValidationCacheEntry>();
const catalogValidationInflight = new Map<string, Promise<PublishedCatalogEntry | undefined>>();
const catalogValidationCacheStats: CatalogValidationCacheStats = {
  hits: 0,
  misses: 0,
  validations: 0,
};

export class InkCatalogInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InkCatalogInputError";
  }
}

function dataDirectory(options: InkCatalogStoreOptions): string {
  return path.resolve(options.dataDir ?? process.env.INKOS_DATA_DIR ?? path.join(process.cwd(), ".ink-data"));
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function readRegularFile(filePath: string, maximumBytes: number): Promise<Uint8Array> {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("Catalog entry is not a regular file");
    if (metadata.size > maximumBytes) throw new Error("Catalog entry exceeds its byte limit");
    const bytes = new Uint8Array(await handle.readFile());
    if (bytes.byteLength > maximumBytes) throw new Error("Catalog entry exceeds its byte limit");
    return bytes;
  } finally {
    await handle.close();
  }
}

async function regularFileIdentity(filePath: string): Promise<string | undefined> {
  try {
    const metadata = await lstat(filePath, { bigint: true });
    if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined;
    return [
      metadata.dev,
      metadata.ino,
      metadata.mode,
      metadata.nlink,
      metadata.size,
      metadata.mtimeNs,
      metadata.ctimeNs,
    ].join(":");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function parseJob(bytes: Uint8Array, jobDirectory: string): CompletedJob | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const job = completedJobSchema.parse(JSON.parse(text));
    return { jobDirectory, package: job.package };
  } catch {
    return undefined;
  }
}

async function scanCompletedJobs(options: InkCatalogStoreOptions): Promise<CompletedJob[]> {
  const jobsPath = path.join(dataDirectory(options), "jobs");
  let jobsStat;
  try {
    jobsStat = await lstat(jobsPath);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  if (!jobsStat.isDirectory() || jobsStat.isSymbolicLink()) return [];

  const jobsRoot = await realpath(jobsPath);
  const entries = (await readdir(jobsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && SAFE_JOB_DIRECTORY.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const jobs: CompletedJob[] = [];

  for (const entry of entries) {
    const candidate = path.join(jobsRoot, entry.name);
    try {
      const candidateStat = await lstat(candidate);
      if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) continue;
      const resolvedCandidate = await realpath(candidate);
      if (path.dirname(resolvedCandidate) !== jobsRoot) continue;
      const jobBytes = await readRegularFile(path.join(resolvedCandidate, JOB_FILE_NAME), MAX_JOB_BYTES);
      const job = parseJob(jobBytes, resolvedCandidate);
      if (job) jobs.push(job);
    } catch {
      // An incomplete or concurrently-written job is not a published package.
    }
  }
  return jobs;
}

async function readCompletedJob(jobDirectory: string): Promise<CompletedJob | undefined> {
  try {
    const bytes = await readRegularFile(path.join(jobDirectory, JOB_FILE_NAME), MAX_JOB_BYTES);
    return parseJob(bytes, jobDirectory);
  } catch {
    return undefined;
  }
}

async function loadCompletedPackage(job: CompletedJob): Promise<LoadedInkCatalogPackage | undefined> {
  try {
    const archive = await readRegularFile(
      path.join(job.jobDirectory, ARTIFACT_FILE_NAME),
      MAX_ARCHIVE_BYTES,
    );
    if (archive.byteLength !== job.package.bytes) return undefined;
    const archiveSha256 = await sha256Hex(archive);
    if (archiveSha256 !== job.package.sha256) return undefined;

    const contents = await readInkArchive(archive, { maxArchiveBytes: MAX_ARCHIVE_BYTES });
    if (contents.manifest.packageId !== job.package.packageId) return undefined;
    const manifestBytes = contents.files.get(MANIFEST_PATH);
    if (!manifestBytes) return undefined;

    return {
      manifest: contents.manifest,
      contents,
      archive,
      archiveSha256,
      fileName: job.package.fileName,
      manifestSha256: await sha256Hex(manifestBytes),
    };
  } catch {
    // A job is visible in the catalog only after its artifact passes full .ink validation.
    return undefined;
  }
}

function preferPackage(
  current: LoadedInkCatalogPackage | undefined,
  candidate: LoadedInkCatalogPackage,
): LoadedInkCatalogPackage {
  if (!current) return candidate;
  if (candidate.manifest.revision !== current.manifest.revision) {
    return candidate.manifest.revision > current.manifest.revision ? candidate : current;
  }
  const createdComparison = candidate.manifest.createdAt.localeCompare(current.manifest.createdAt);
  if (createdComparison !== 0) return createdComparison > 0 ? candidate : current;
  return candidate.archiveSha256.localeCompare(current.archiveSha256) > 0 ? candidate : current;
}

function catalogEntry(loaded: LoadedInkCatalogPackage): InkCatalogEntry {
  const packageId = loaded.manifest.packageId;
  const baseUrl = `/api/ink/v1/packages/${encodeURIComponent(packageId)}`;
  return {
    packageId,
    revision: loaded.manifest.revision,
    title: loaded.manifest.title,
    entryUuid: loaded.manifest.entryUuid,
    fileName: loaded.fileName,
    bytes: loaded.archive.byteLength,
    sha256: loaded.archiveSha256,
    manifestUrl: `${baseUrl}/manifest`,
    downloadUrl: `${baseUrl}/download`,
  };
}

function completedJobSignature(job: CompletedJob): string {
  return JSON.stringify({
    packageId: job.package.packageId,
    fileName: job.package.fileName,
    bytes: job.package.bytes,
    sha256: job.package.sha256,
  });
}

function clonePublishedCatalogEntry(candidate: PublishedCatalogEntry): PublishedCatalogEntry {
  return {
    ...candidate,
    entry: { ...candidate.entry },
  };
}

function rememberCatalogValidation(
  cacheKey: string,
  candidate: PublishedCatalogEntry | undefined,
): void {
  catalogValidationCache.delete(cacheKey);
  catalogValidationCache.set(cacheKey, {
    candidate: candidate ? clonePublishedCatalogEntry(candidate) : undefined,
  });
  while (catalogValidationCache.size > MAX_CATALOG_VALIDATION_CACHE_ENTRIES) {
    const oldest = catalogValidationCache.keys().next().value;
    if (oldest === undefined) break;
    catalogValidationCache.delete(oldest);
  }
}

async function fullyValidateCatalogJob(
  job: CompletedJob,
  expectedJobSignature: string,
  expectedArtifactIdentity: string,
): Promise<PublishedCatalogEntry | undefined> {
  catalogValidationCacheStats.validations += 1;
  const loaded = await loadCompletedPackage(job);
  if (!loaded) return undefined;

  // Publication writes artifact.ink and job.json with separate atomic renames.
  // Recheck both after the expensive validation so a scan that overlaps those
  // renames cannot publish metadata from a mixed old/new pair.
  const [stableJob, stableArtifactIdentity] = await Promise.all([
    readCompletedJob(job.jobDirectory),
    regularFileIdentity(path.join(job.jobDirectory, ARTIFACT_FILE_NAME)),
  ]);
  if (
    !stableJob
    || completedJobSignature(stableJob) !== expectedJobSignature
    || stableArtifactIdentity !== expectedArtifactIdentity
  ) return undefined;

  return {
    entry: catalogEntry(loaded),
    revision: loaded.manifest.revision,
    createdAt: loaded.manifest.createdAt,
    archiveSha256: loaded.archiveSha256,
  };
}

async function loadCompletedCatalogEntry(
  job: CompletedJob,
): Promise<PublishedCatalogEntry | undefined> {
  const artifactIdentity = await regularFileIdentity(
    path.join(job.jobDirectory, ARTIFACT_FILE_NAME),
  );
  if (!artifactIdentity) return undefined;
  const jobSignature = completedJobSignature(job);
  const cacheKey = `${job.jobDirectory}\0${jobSignature}\0${artifactIdentity}`;
  const cached = catalogValidationCache.get(cacheKey);
  if (cached) {
    catalogValidationCacheStats.hits += 1;
    catalogValidationCache.delete(cacheKey);
    catalogValidationCache.set(cacheKey, cached);
    return cached.candidate ? clonePublishedCatalogEntry(cached.candidate) : undefined;
  }

  catalogValidationCacheStats.misses += 1;
  let pending = catalogValidationInflight.get(cacheKey);
  if (!pending) {
    pending = fullyValidateCatalogJob(job, jobSignature, artifactIdentity);
    catalogValidationInflight.set(cacheKey, pending);
  }
  try {
    const candidate = await pending;
    rememberCatalogValidation(cacheKey, candidate);
    return candidate ? clonePublishedCatalogEntry(candidate) : undefined;
  } finally {
    if (catalogValidationInflight.get(cacheKey) === pending) {
      catalogValidationInflight.delete(cacheKey);
    }
  }
}

/** Test seam for asserting catalog validation-cache behavior without retaining archives. */
export function resetInkCatalogValidationCacheForTests(): void {
  catalogValidationCache.clear();
  catalogValidationInflight.clear();
  catalogValidationCacheStats.hits = 0;
  catalogValidationCacheStats.misses = 0;
  catalogValidationCacheStats.validations = 0;
}

/** Test seam; production callers should treat cache operation as an implementation detail. */
export function inkCatalogValidationCacheStatsForTests(): CatalogValidationCacheStats & {
  entries: number;
} {
  return {
    ...catalogValidationCacheStats,
    entries: catalogValidationCache.size,
  };
}

function parsePackageId(value: string): string {
  const parsed = inkUuidSchema.safeParse(value);
  if (!parsed.success) throw new InkCatalogInputError("packageId must be a lowercase RFC 9562 UUID");
  return parsed.data;
}

function parseDocumentUuid(value: string): string {
  const parsed = inkUuidSchema.safeParse(value);
  if (!parsed.success) throw new InkCatalogInputError("uuid must be a lowercase RFC 9562 UUID");
  return parsed.data;
}

function parseVariantId(value: string): string {
  if (!VARIANT_ID.test(value)) throw new InkCatalogInputError("variantId has an invalid format");
  return value;
}

function parsePageIndex(value: string | number): number {
  const text = typeof value === "number" ? String(value) : value;
  if (!PAGE_INDEX.test(text)) throw new InkCatalogInputError("pageIndex must be a canonical non-negative integer");
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) throw new InkCatalogInputError("pageIndex is outside the supported range");
  return parsed;
}

export async function listInkCatalogPackages(
  options: InkCatalogStoreOptions = {},
): Promise<InkCatalogEntry[]> {
  const published = new Map<string, PublishedCatalogEntry>();
  for (const job of await scanCompletedJobs(options)) {
    const candidate = await loadCompletedCatalogEntry(job);
    if (!candidate) continue;
    const current = published.get(candidate.entry.packageId);
    const preferred = !current || candidate.revision > current.revision || (
      candidate.revision === current.revision &&
      (candidate.createdAt > current.createdAt || (
        candidate.createdAt === current.createdAt && candidate.archiveSha256 > current.archiveSha256
      ))
    );
    if (preferred) published.set(candidate.entry.packageId, candidate);
  }
  return [...published.values()]
    .map((candidate) => candidate.entry)
    .sort((left, right) => left.packageId.localeCompare(right.packageId));
}

export async function getInkCatalogPackage(
  rawPackageId: string,
  options: InkCatalogStoreOptions = {},
): Promise<LoadedInkCatalogPackage | undefined> {
  const packageId = parsePackageId(rawPackageId);
  if (packageId === PAPERS3_HOME_PACKAGE_ID) {
    await ensurePaperS3HomePackage({ dataDir: options.dataDir });
  }
  let selected: LoadedInkCatalogPackage | undefined;
  for (const job of await scanCompletedJobs(options)) {
    if (job.package.packageId !== packageId) continue;
    const loaded = await loadCompletedPackage(job);
    if (loaded) selected = preferPackage(selected, loaded);
  }
  return selected;
}

export function getInkManifestArtifact(loaded: LoadedInkCatalogPackage): InkCatalogArtifact {
  return {
    bytes: loaded.contents.files.get(MANIFEST_PATH)!,
    contentType: "application/json; charset=utf-8",
    sha256: loaded.manifestSha256,
    cacheControl: "public, max-age=60, must-revalidate",
  };
}

export function getInkDocumentArtifact(
  loaded: LoadedInkCatalogPackage,
  rawDocumentUuid: string,
): InkCatalogArtifact | undefined {
  const documentUuid = parseDocumentUuid(rawDocumentUuid);
  const document = loaded.manifest.documents.find((candidate) => candidate.uuid === documentUuid);
  if (!document) return undefined;
  return {
    bytes: loaded.contents.files.get(document.documentPath)!,
    contentType: "application/json; charset=utf-8",
    sha256: document.documentSha256,
    // v1 packageId URLs resolve the newest revision in a lineage. They are
    // strongly validated by ETag but cannot be immutable until revision is
    // included in the resource URL.
    cacheControl: "public, max-age=60, must-revalidate",
  };
}

function findPage(
  loaded: LoadedInkCatalogPackage,
  rawVariantId: string,
  rawDocumentUuid: string,
  rawPageIndex: string | number,
) {
  const variantId = parseVariantId(rawVariantId);
  const documentUuid = parseDocumentUuid(rawDocumentUuid);
  const pageIndex = parsePageIndex(rawPageIndex);
  if (!loaded.manifest.variants.some((variant) => variant.id === variantId)) return undefined;
  const document = loaded.manifest.documents.find((candidate) => candidate.uuid === documentUuid);
  const frames = document?.variants.find((candidate) => candidate.variantId === variantId);
  return frames?.pages.find((candidate) => candidate.pageIndex === pageIndex);
}

export function getInkFrameArtifact(
  loaded: LoadedInkCatalogPackage,
  rawVariantId: string,
  rawDocumentUuid: string,
  rawPageIndex: string | number,
): InkCatalogArtifact | undefined {
  const page = findPage(loaded, rawVariantId, rawDocumentUuid, rawPageIndex);
  if (!page) return undefined;
  return {
    bytes: loaded.contents.files.get(page.imagePath)!,
    // The versioned frame endpoint remains the renderer-owned PNG fallback.
    // Source JPEGs are package artifacts consumed from a verified .ink archive.
    contentType: "image/png",
    sha256: page.imageSha256,
    cacheControl: "public, max-age=60, must-revalidate",
  };
}

export function getInkSidecarArtifact(
  loaded: LoadedInkCatalogPackage,
  rawVariantId: string,
  rawDocumentUuid: string,
  rawPageIndex: string | number,
): InkCatalogArtifact | undefined {
  const page = findPage(loaded, rawVariantId, rawDocumentUuid, rawPageIndex);
  if (!page) return undefined;
  return {
    bytes: loaded.contents.files.get(page.sidecarPath)!,
    contentType: "application/json; charset=utf-8",
    sha256: page.sidecarSha256,
    cacheControl: "public, max-age=60, must-revalidate",
  };
}

export function getInkDownloadArtifact(loaded: LoadedInkCatalogPackage): InkCatalogArtifact {
  return {
    bytes: loaded.archive,
    contentType: "application/vnd.inkos.package+zip",
    sha256: loaded.archiveSha256,
    cacheControl: "public, max-age=60, must-revalidate",
    fileName: loaded.fileName,
  };
}
