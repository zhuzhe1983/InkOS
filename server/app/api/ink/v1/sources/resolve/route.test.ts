import { describe, expect, it, vi } from "vitest";

import type { LoadedInkCatalogPackage } from "@/lib/ink/catalog-store";
import {
  INKOS_WEB_GENERATOR_VERSION,
  INKOS_WEB_PACKAGE_REVISION,
} from "@/lib/ink/generator/runner";
import { generatorJobSchema } from "@/lib/ink/generator/contracts";
import { generatorRequestForSource } from "@/lib/ink/generator/source-resolver";

import { handleSourceResolve } from "./route";

function request(body: unknown): Request {
  return new Request("http://localhost/api/ink/v1/sources/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/ink/v1/sources/resolve", () => {
  it.each([
    ["HTTP URL", "http://example.com/article"],
    ["credentialed URL", "https://user:secret@example.com/article"],
  ])("rejects %s before catalog or generator access", async (_label, url) => {
    const getPackage = vi.fn();
    const createJob = vi.fn();
    const response = await handleSourceResolve(request({ url }), { getPackage, createJob });

    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Type")).toContain("application/problem+json");
    expect(await response.json()).toMatchObject({ code: "INVALID_REQUEST" });
    expect(getPackage).not.toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();
  });

  it("returns 202 and the persistent job URLs while generation is pending", async () => {
    const jobId = "50000000-0000-4000-8000-000000000001";
    const now = "2026-07-16T08:00:00.000Z";
    const job = generatorJobSchema.parse({
      schemaVersion: "inkos.generator-job/v1",
      jobId,
      status: "queued",
      phase: "queued",
      progress: { completed: 0, total: 1, message: "queued" },
      createdAt: now,
      updatedAt: now,
      statusUrl: `/api/ink/v1/generator/jobs/${jobId}`,
      eventsUrl: `/api/ink/v1/generator/jobs/${jobId}/events`,
    });
    const createJob = vi.fn(async (rawRequest: unknown) => ({
      job,
      request: generatorRequestForSource((rawRequest as { seedUrl: string }).seedUrl),
      created: true,
    }));
    const enqueueJob = vi.fn();
    const response = await handleSourceResolve(request({
      url: "https://example.com/article",
      displayMeta: { orientation: "landscape", fontLevel: 2, invert: false },
    }), {
      getPackage: async () => undefined,
      createJob,
      enqueueJob,
    });

    expect(response.status).toBe(202);
    expect(response.headers.get("Location")).toBe(job.statusUrl);
    expect(await response.json()).toMatchObject({
      schemaVersion: "inkos.source-resolution/v1",
      cached: false,
      status: "queued",
      jobId,
      statusUrl: job.statusUrl,
      eventsUrl: job.eventsUrl,
    });
    expect(enqueueJob).toHaveBeenCalledWith(jobId);
    expect(createJob).toHaveBeenCalledWith(expect.objectContaining({
      orientations: ["landscape"],
      fontLevels: [2],
    }), expect.any(String));
  });

  it("rejects inverse display metadata before catalog or generator access", async () => {
    const getPackage = vi.fn();
    const createJob = vi.fn();
    const response = await handleSourceResolve(request({
      url: "https://example.com/article",
      displayMeta: { orientation: "portrait", fontLevel: 0, invert: true },
    }), { getPackage, createJob });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_REQUEST" });
    expect(getPackage).not.toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();
  });

  it("returns 200 with the completed package identity", async () => {
    const packageId = "50000000-0000-4000-8000-000000000099";
    const entryUuid = "50000000-0000-4000-8000-000000000002";
    const getPackage = vi.fn(async () => ({
      manifest: {
        packageId,
        entryUuid,
        revision: INKOS_WEB_PACKAGE_REVISION,
        title: "Cached article",
        generator: { name: "inkos-web-generator", version: INKOS_WEB_GENERATOR_VERSION },
      },
    }) as LoadedInkCatalogPackage);
    const response = await handleSourceResolve(request({ url: "https://example.com/article" }), {
      getPackage,
      createJob: vi.fn(),
      enqueueJob: vi.fn(),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      cached: true,
      status: "complete",
      packageId,
      entryUuid,
    });
  });
});
