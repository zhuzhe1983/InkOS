import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readInkArchive } from "../archive";
import { packagedDocument } from "../contracts";
import type { InkPackageBuildInput } from "../package-builder";
import {
  cancelGeneratorJob,
  createGeneratorJob,
  generatorArtifactPath,
  GeneratorStoreError,
  readGeneratorJob,
} from "./job-store";
import {
  INKOS_WEB_ARCHIVE_REVISION,
  INKOS_WEB_GENERATOR_VERSION,
  INKOS_WEB_PACKAGE_REVISION,
  remoteImageHosts,
  runGeneratorJob,
} from "./runner";
import type { SourceIngestionResult } from "./source";

let temporaryDataRoot = "";
let previousDataRoot: string | undefined;

const request = {
  seedUrl: "https://example.com/guide",
  title: "Example guide",
  maxDepth: 0,
  maxDocuments: 1,
  profileIds: ["m5stack-paper-s3-portrait"],
  orientations: ["portrait"],
  fontLevels: [0],
};

function ingestion(): SourceIngestionResult {
  return {
    seedUrl: request.seedUrl,
    entryCanonicalUrl: request.seedUrl,
    limits: { maxDepth: 0, maxDocuments: 1 },
    pages: [{
      canonicalUrl: request.seedUrl,
      depth: 0,
      title: "Example guide",
      locale: "en",
      blocks: [
        { type: "heading", level: 2, text: "Introduction" },
        { type: "paragraph", text: "A deterministic offline reading fixture." },
      ],
      childLinks: [],
      provenance: {
        provider: "web",
        sourceUrl: request.seedUrl,
        canonicalUrl: request.seedUrl,
        retrievedAt: "2026-07-16T08:00:00.000Z",
      },
      revision: { id: "7", timestamp: "2026-07-01T00:00:00Z" },
      license: null,
      attribution: { name: "example.com", url: request.seedUrl },
    }],
  };
}

describe("job-scoped remote image hosts", () => {
  it("pins the current capture, foreground-draft, and archive revisions", () => {
    expect(INKOS_WEB_GENERATOR_VERSION).toBe("2.4.11");
    expect(INKOS_WEB_PACKAGE_REVISION).toBe(17);
    expect(INKOS_WEB_ARCHIVE_REVISION).toBe(18);
  });

  it("collects and deduplicates HTTPS hosts from every image-bearing page kind", () => {
    const uuids = [
      "00000000-0000-5000-8000-000000000001",
      "00000000-0000-5000-8000-000000000002",
      "00000000-0000-5000-8000-000000000003",
      "00000000-0000-5000-8000-000000000004",
    ];
    const documents: InkPackageBuildInput["documents"] = [
      packagedDocument({
        uuid: uuids[0],
        source: { title: "Detail" },
        content: {
          schemaVersion: "inkos.content/v2",
          id: uuids[0],
          revision: 1,
          locale: "en",
          page: {
            kind: "detail",
            layout: "article",
            title: "Detail",
            heroImage: {
              source: { kind: "remote", url: "https://hero.example/hero.jpg" },
              alt: "Hero",
            },
            content: [
              {
                type: "image",
                image: {
                  source: { kind: "remote", url: "https://shared.example/detail.png" },
                  alt: "Detail image",
                },
              },
            ],
          },
        },
      }),
      packagedDocument({
        uuid: uuids[1],
        source: { title: "Feed" },
        content: {
          schemaVersion: "inkos.content/v2",
          id: uuids[1],
          revision: 1,
          locale: "en",
          page: {
            kind: "list",
            layout: "feed",
            title: "Feed",
            items: [
              {
                id: "first",
                title: "First",
                image: {
                  source: { kind: "remote", url: "https://FEED.example/first.jpg" },
                  alt: "First",
                },
              },
              {
                id: "second",
                title: "Second",
                image: {
                  source: { kind: "remote", url: "https://feed.example./second.jpg" },
                  alt: "Second",
                },
              },
              {
                id: "asset",
                title: "Bundled asset",
                image: { source: { kind: "asset", assetId: "feed/bundled" }, alt: "Bundled" },
              },
            ],
          },
        },
      }),
      packagedDocument({
        uuid: uuids[2],
        source: { title: "Full screen" },
        content: {
          schemaVersion: "inkos.content/v2",
          id: uuids[2],
          revision: 1,
          locale: "en",
          page: {
            kind: "image",
            layout: "contain",
            image: {
              source: { kind: "remote", url: "https://full.example/image.png" },
              alt: "Full screen",
            },
          },
        },
      }),
      packagedDocument({
        uuid: uuids[3],
        source: { title: "Reader" },
        content: {
          schemaVersion: "inkos.content/v2",
          id: uuids[3],
          revision: 1,
          locale: "en",
          page: { kind: "reader", content: [{ type: "paragraph", text: "Text only." }] },
        },
      }),
    ];
    const unsafe = [
      "http://insecure.example/image.jpg",
      "https://user:secret@credential.example/image.jpg",
      "https://wrong-port.example:444/image.jpg",
      "not a URL",
    ].map((url) => ({
      content: { page: { kind: "image", image: { source: { kind: "remote", url } } } },
    })) as unknown as InkPackageBuildInput["documents"];

    expect(remoteImageHosts([...documents, ...unsafe])).toEqual([
      "feed.example",
      "full.example",
      "hero.example",
      "shared.example",
    ]);
  });
});

beforeEach(async () => {
  previousDataRoot = process.env.INKOS_DATA_DIR;
  temporaryDataRoot = await mkdtemp(path.join(os.tmpdir(), "inkos-generator-"));
  process.env.INKOS_DATA_DIR = temporaryDataRoot;
});

afterEach(async () => {
  if (previousDataRoot === undefined) delete process.env.INKOS_DATA_DIR;
  else process.env.INKOS_DATA_DIR = previousDataRoot;
  await rm(temporaryDataRoot, { recursive: true, force: true });
});

describe.sequential("persisted generator jobs", () => {
  it("runs through ingestion, rendering, packaging and artifact publication", async () => {
    const created = await createGeneratorJob({
      ...request,
      outputTuning: { contrast: 1.25, quantization: "uniform-16" },
    }, "example-job");
    await runGeneratorJob(created.job.jobId, { ingest: async () => ingestion() });
    const complete = await readGeneratorJob(created.job.jobId);
    const archive = new Uint8Array(await readFile(generatorArtifactPath(created.job.jobId)));
    const unpacked = await readInkArchive(archive);

    expect(complete).toMatchObject({
      status: "complete",
      phase: "complete",
      package: {
        packageId: unpacked.manifest.packageId,
        bytes: archive.byteLength,
      },
    });
    expect(unpacked.manifest.title).toBe(request.title);
    expect(unpacked.manifest.documents).toHaveLength(1);
    expect(unpacked.manifest.variants).toHaveLength(1);
    expect(unpacked.manifest.variants[0].displayMeta.outputTuning).toEqual({
      contrast: 1.25,
      quantization: "uniform-16",
    });
  });

  it("deduplicates identical idempotent requests and rejects key reuse", async () => {
    const first = await createGeneratorJob(request, "same-key");
    const second = await createGeneratorJob({
      ...request,
      fontLevels: [0],
    }, "same-key");
    expect(second.created).toBe(false);
    expect(second.job.jobId).toBe(first.job.jobId);

    await expect(createGeneratorJob({ ...request, title: "Changed" }, "same-key"))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" } satisfies Partial<GeneratorStoreError>);

    const afterConflict = await createGeneratorJob(request, "same-key");
    expect(afterConflict.created).toBe(false);
    expect(afterConflict.job.jobId).toBe(first.job.jobId);
  });

  it("creates exactly one job for concurrent calls with the same idempotency key", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => createGeneratorJob(request, "concurrent-key")),
    );

    expect(new Set(results.map((result) => result.job.jobId)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
  });

  it("does not publish a job cancelled before execution", async () => {
    const created = await createGeneratorJob(request);
    await cancelGeneratorJob(created.job.jobId);
    await runGeneratorJob(created.job.jobId, { ingest: async () => ingestion() });
    expect(await readGeneratorJob(created.job.jobId)).toMatchObject({ status: "cancelled" });
    await expect(readFile(generatorArtifactPath(created.job.jobId))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects the retired invertModes generator matrix", async () => {
    await expect(createGeneratorJob({ ...request, invertModes: [false, true] }, "retired-invert"))
      .rejects.toThrow(/invertModes/u);
  });
});
