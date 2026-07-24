import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LoadedInkCatalogPackage } from "../catalog-store";
import { generatorJobSchema } from "./contracts";
import { readGeneratorRequest } from "./job-store";
import {
  generatorRequestForSource,
  normalizeResolvableSourceUrl,
  resolveSource,
  sourceResolutionIdempotencyKey,
} from "./source-resolver";
import { sourceDocumentUuid, sourcePackageUuid } from "./transform";
import { INKOS_WEB_GENERATOR_VERSION, INKOS_WEB_PACKAGE_REVISION } from "./runner";

const NOOK_URL = "https://zh.wikipedia.org/wiki/Nook#电子墨水屏系列";
const NOOK_PACKAGE_ID = "2d71313b-85ea-5285-9071-67149c4b4b67";
const NOOK_ENTRY_UUID = "7264a430-7665-5a92-a917-9187af94755c";

let temporaryDataRoot = "";
let previousDataRoot: string | undefined;

function loadedPackage(packageId: string, entryUuid: string, title = "Cached source") {
  return {
    manifest: {
      packageId,
      entryUuid,
      revision: INKOS_WEB_PACKAGE_REVISION,
      title,
      generator: { name: "inkos-web-generator", version: INKOS_WEB_GENERATOR_VERSION },
    },
  } as LoadedInkCatalogPackage;
}

beforeEach(async () => {
  previousDataRoot = process.env.INKOS_DATA_DIR;
  temporaryDataRoot = await mkdtemp(path.join(os.tmpdir(), "inkos-source-resolver-"));
  process.env.INKOS_DATA_DIR = temporaryDataRoot;
});

afterEach(async () => {
  if (previousDataRoot === undefined) delete process.env.INKOS_DATA_DIR;
  else process.env.INKOS_DATA_DIR = previousDataRoot;
  await rm(temporaryDataRoot, { recursive: true, force: true });
});

describe.sequential("PaperS3 URL source resolver", () => {
  it("normalizes equivalent URLs into one persistent job with one default display variant", async () => {
    const enqueueJob = vi.fn();
    const getPackage = vi.fn(async () => undefined);
    const first = await resolveSource({
      url: "HTTPS://Example.COM:443/articles/Guide?z=2&a=1",
    }, { getPackage, enqueueJob });
    const second = await resolveSource({
      url: "https://example.com/articles/Guide?a=1&z=2",
    }, { getPackage, enqueueJob });

    expect(first.normalizedUrl).toBe("https://example.com/articles/Guide?a=1&z=2");
    expect(second.normalizedUrl).toBe(first.normalizedUrl);
    expect(second.jobId).toBe(first.jobId);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(await readGeneratorRequest(first.jobId!)).toEqual({
      seedUrl: first.normalizedUrl,
      title: "Guide",
      sourceMode: "chromium",
      deliveryMode: "realtime",
      maxDepth: 0,
      maxDocuments: 1,
      profileIds: ["m5stack-paper-s3-portrait"],
      orientations: ["portrait"],
      fontLevels: [0],
    });
    expect(first.expectedEntryUuid).toBe(sourceDocumentUuid(first.normalizedUrl));
    expect(first.expectedPackageId).toBe(sourcePackageUuid(first.normalizedUrl));
  });

  it("uses the exact orientation/font tuple for the first job and its idempotency identity", async () => {
    const normalizedUrl = "https://example.com/articles/exact-display";
    const landscape = { orientation: "landscape" as const, fontLevel: 2 as const, invert: false };
    const portrait = { orientation: "portrait" as const, fontLevel: 2 as const, invert: false };
    const enqueueJob = vi.fn();
    const resolution = await resolveSource({
      url: normalizedUrl,
      displayMeta: landscape,
    }, {
      getPackage: async () => undefined,
      enqueueJob,
    });

    expect(await readGeneratorRequest(resolution.jobId!)).toMatchObject({
      profileIds: ["m5stack-paper-s3-portrait"],
      orientations: ["landscape"],
      fontLevels: [2],
    });
    expect(sourceResolutionIdempotencyKey(normalizedUrl, landscape))
      .not.toBe(sourceResolutionIdempotencyKey(normalizedUrl, portrait));
    expect(sourceResolutionIdempotencyKey(normalizedUrl, landscape))
      .toBe(sourceResolutionIdempotencyKey(normalizedUrl, { ...landscape }));
  });

  it("includes custom output tuning in both the first render plan and idempotency identity", async () => {
    const normalizedUrl = "https://example.com/articles/tuned-output";
    const base = { orientation: "portrait" as const, fontLevel: 0 as const, invert: false };
    const tuned = {
      ...base,
      outputTuning: { contrast: 1.3, photoContrast: 1.4, supersampling: 2 as const },
    };
    const resolution = await resolveSource({ url: normalizedUrl, displayMeta: tuned }, {
      getPackage: async () => undefined,
      enqueueJob: vi.fn(),
    });

    expect(await readGeneratorRequest(resolution.jobId!)).toMatchObject({
      outputTuning: tuned.outputTuning,
    });
    expect(sourceResolutionIdempotencyKey(normalizedUrl, tuned)).not.toBe(
      sourceResolutionIdempotencyKey(normalizedUrl, base),
    );
  });

  it("reuses one job and enqueues once across concurrent equivalent URL resolutions", async () => {
    const enqueueJob = vi.fn();
    const getPackage = vi.fn(async () => undefined);
    const resolutions = await Promise.all(
      Array.from({ length: 8 }, (_, index) => resolveSource({
        url: index % 2 === 0
          ? "HTTPS://Example.COM:443/articles/Concurrent?z=2&a=1"
          : "https://example.com/articles/Concurrent?a=1&z=2",
      }, { getPackage, enqueueJob })),
    );

    expect(new Set(resolutions.map((resolution) => resolution.jobId)).size).toBe(1);
    expect(resolutions.filter((resolution) => !resolution.cached)).toHaveLength(1);
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(enqueueJob).toHaveBeenCalledWith(resolutions[0].jobId);
  });

  it("returns the published Nook package directly without creating or enqueuing a job", async () => {
    const normalizedUrl = normalizeResolvableSourceUrl(NOOK_URL);
    expect(sourcePackageUuid(normalizedUrl)).toBe(NOOK_PACKAGE_ID);
    expect(sourceDocumentUuid(normalizedUrl)).toBe(NOOK_ENTRY_UUID);

    const createJob = vi.fn();
    const enqueueJob = vi.fn();
    const getPackage = vi.fn(async (packageId: string) =>
      packageId === NOOK_PACKAGE_ID
        ? loadedPackage(NOOK_PACKAGE_ID, NOOK_ENTRY_UUID, "Nook 电子墨水屏系列")
        : undefined
    );
    const resolution = await resolveSource({
      url: NOOK_URL,
      // A current semantic package is reusable even when this tuple was not
      // pre-rendered; the package render endpoint handles it on demand.
      displayMeta: { orientation: "landscape", fontLevel: -2, invert: false },
    }, {
      getPackage,
      createJob,
      enqueueJob,
    });

    expect(resolution).toMatchObject({
      schemaVersion: "inkos.source-resolution/v1",
      cached: true,
      status: "complete",
      job: null,
      expectedPackageId: NOOK_PACKAGE_ID,
      expectedEntryUuid: NOOK_ENTRY_UUID,
      packageId: NOOK_PACKAGE_ID,
      entryUuid: NOOK_ENTRY_UUID,
      manifestUrl: `/api/ink/v1/packages/${NOOK_PACKAGE_ID}/manifest`,
      downloadUrl: `/api/ink/v1/packages/${NOOK_PACKAGE_ID}/download`,
    });
    expect(createJob).not.toHaveBeenCalled();
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("returns a stale verified package immediately while enqueueing Chromium revalidation", async () => {
    const normalizedUrl = normalizeResolvableSourceUrl(NOOK_URL);
    const stale = loadedPackage(NOOK_PACKAGE_ID, NOOK_ENTRY_UUID, "Stale source");
    stale.manifest.provenance = {
      seeds: [{
        url: normalizedUrl,
        title: "Stale source",
        retrievedAt: "2026-07-16T00:00:00.000Z",
      }],
      crawl: { maxDepth: 0, maxDocuments: 1 },
    };
    const enqueueJob = vi.fn();
    const resolution = await resolveSource({ url: NOOK_URL }, {
      getPackage: async () => stale,
      enqueueJob,
      now: () => new Date("2026-07-16T08:00:00.000Z"),
    });

    expect(resolution).toMatchObject({
      status: "complete",
      cached: true,
      stale: true,
      packageId: NOOK_PACKAGE_ID,
      entryUuid: NOOK_ENTRY_UUID,
    });
    expect(resolution.revalidatingJobId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(enqueueJob).toHaveBeenCalledWith(resolution.revalidatingJobId);
    expect(await readGeneratorRequest(resolution.revalidatingJobId!)).toMatchObject({
      sourceMode: "chromium",
      deliveryMode: "realtime",
      maxDepth: 0,
      maxDocuments: 1,
    });
  });

  it("does not reuse a 20-variant generator 1.3 revision 5 package", async () => {
    const stale = loadedPackage(NOOK_PACKAGE_ID, NOOK_ENTRY_UUID);
    stale.manifest.generator.version = "1.3.0";
    stale.manifest.revision = 5;
    const enqueueJob = vi.fn();
    const resolution = await resolveSource({
      url: NOOK_URL,
      displayMeta: { orientation: "landscape", fontLevel: 1, invert: false },
    }, {
      getPackage: async () => stale,
      enqueueJob,
    });

    expect(resolution.cached).toBe(false);
    expect(resolution.status).toBe("queued");
    expect(enqueueJob).toHaveBeenCalledWith(resolution.jobId);
    expect(await readGeneratorRequest(resolution.jobId!)).toMatchObject({
      orientations: ["landscape"],
      fontLevels: [1],
    });
  });

  it("rejects inverse source requests before catalog or generator access", async () => {
    const getPackage = vi.fn();
    const createJob = vi.fn();
    await expect(resolveSource({
      url: "https://example.com/articles/inverse",
      displayMeta: { orientation: "portrait", fontLevel: 0, invert: true },
    }, { getPackage, createJob })).rejects.toThrow(/invert is no longer supported/u);
    expect(getPackage).not.toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();
  });

  it("uses the completed job package after a canonical redirect changes the predicted identity", async () => {
    const actualPackageId = "40000000-0000-4000-8000-000000000099";
    const actualEntryUuid = "40000000-0000-4000-8000-000000000001";
    const jobId = "40000000-0000-4000-8000-000000000002";
    const now = "2026-07-16T08:00:00.000Z";
    const job = generatorJobSchema.parse({
      schemaVersion: "inkos.generator-job/v1",
      jobId,
      status: "complete",
      phase: "complete",
      progress: { completed: 1, total: 1, message: "complete" },
      createdAt: now,
      updatedAt: now,
      statusUrl: `/api/ink/v1/generator/jobs/${jobId}`,
      eventsUrl: `/api/ink/v1/generator/jobs/${jobId}/events`,
      artifactUrl: `/api/ink/v1/generator/jobs/${jobId}/artifact`,
      package: {
        packageId: actualPackageId,
        fileName: "redirected-r1.ink",
        bytes: 123,
        sha256: "a".repeat(64),
      },
    });
    const getPackage = vi.fn(async (packageId: string) =>
      packageId === actualPackageId
        ? loadedPackage(actualPackageId, actualEntryUuid, "Redirected canonical source")
        : undefined
    );
    const createJob = vi.fn(async () => ({
      job,
      request: generatorRequestForSource("https://example.com/alias"),
      created: false,
    }));

    const resolution = await resolveSource({ url: "https://example.com/alias" }, {
      getPackage,
      createJob,
      enqueueJob: vi.fn(),
    });

    expect(resolution.status).toBe("complete");
    expect(resolution.cached).toBe(true);
    expect(resolution.packageId).toBe(actualPackageId);
    expect(resolution.entryUuid).toBe(actualEntryUuid);
    expect(resolution.expectedPackageId).not.toBe(actualPackageId);
  });
});
