import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { GET as getDocumentRoute } from "@/app/api/ink/v1/packages/[packageId]/documents/[uuid]/route";
import { GET as getDownloadRoute } from "@/app/api/ink/v1/packages/[packageId]/download/route";
import { GET as getFrameRoute } from "@/app/api/ink/v1/packages/[packageId]/frames/[variantId]/[uuid]/[pageIndex]/route";
import { GET as getSidecarRoute } from "@/app/api/ink/v1/packages/[packageId]/frames/[variantId]/[uuid]/[pageIndex]/sidecar/route";
import { GET as getManifestRoute } from "@/app/api/ink/v1/packages/[packageId]/manifest/route";
import { POST as renderPackageRoute } from "@/app/api/ink/v1/packages/[packageId]/render/route";
import { GET as listPackagesRoute } from "@/app/api/ink/v1/packages/route";

import { packagedDocument } from "./contracts";
import {
  PAPERS3_HOME_ENTRY_UUID,
  PAPERS3_HOME_PACKAGE_ID,
} from "./builtin/papers3-home";
import {
  getInkCatalogPackage,
  getInkDocumentArtifact,
  getInkDownloadArtifact,
  getInkFrameArtifact,
  getInkManifestArtifact,
  getInkSidecarArtifact,
  inkCatalogValidationCacheStatsForTests,
  InkCatalogInputError,
  listInkCatalogPackages,
  resetInkCatalogValidationCacheForTests,
} from "./catalog-store";
import { buildRenderedInkPackage, createInkDisplayVariant, type BuiltInkPackage } from "./package-builder";
import { sha256Hex } from "./archive";

const PACKAGE_ID = "30000000-0000-4000-8000-000000000099";
const DOCUMENT_UUID = "30000000-0000-4000-8000-000000000001";
const MISSING_UUID = "30000000-0000-4000-8000-000000000002";
const CREATED_AT = "2026-07-16T17:00:00+08:00";
const FILE_NAME = "catalog-fixture.ink";
const temporaryDirectories: string[] = [];
let built: BuiltInkPackage;

async function buildFixture(
  revision = 3,
  title = "目录服务测试",
  createdAt = CREATED_AT,
): Promise<BuiltInkPackage> {
  const document = packagedDocument({
    uuid: DOCUMENT_UUID,
    source: { title },
    content: {
      schemaVersion: "inkos.content/v2",
      id: DOCUMENT_UUID,
      revision,
      locale: "zh-CN",
      page: {
        kind: "reader",
        content: [{ type: "paragraph", text: "服务器返回归档中的原始字节。" }],
      },
    },
  });
  return buildRenderedInkPackage({
    packageId: PACKAGE_ID,
    slug: "catalog-fixture",
    revision,
    title,
    entryUuid: DOCUMENT_UUID,
    createdAt,
    generator: { name: "inkos-test", version: "1.0.0" },
    provenance: {
      seeds: [{ url: "https://example.com/catalog", title, retrievedAt: createdAt }],
      crawl: { maxDepth: 0, maxDocuments: 1 },
    },
    variants: [createInkDisplayVariant("m5stack-paper-s3-portrait", {
      orientation: "portrait",
      invert: false,
      fontLevel: 0,
    })],
    documents: [document],
  });
}

async function temporaryDataDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "inkos-catalog-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function publish(
  dataDirectory: string,
  jobId = "complete-job",
  archive = built.archive,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const jobDirectory = path.join(dataDirectory, "jobs", jobId);
  await mkdir(jobDirectory, { recursive: true });
  const summary = {
    packageId: PACKAGE_ID,
    fileName: FILE_NAME,
    bytes: archive.byteLength,
    sha256: await sha256Hex(archive),
  };
  await writeFile(path.join(jobDirectory, "artifact.ink"), archive);
  await writeFile(
    path.join(jobDirectory, "job.json"),
    `${JSON.stringify({ status: "complete", package: summary, ...overrides })}\n`,
  );
}

beforeAll(async () => {
  built = await buildFixture();
});

afterEach(async () => {
  resetInkCatalogValidationCacheForTests();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("filesystem-backed .ink package catalog", () => {
  it("lists only complete, byte-verified packages and resolves manifest-declared artifacts", async () => {
    const dataDirectory = await temporaryDataDirectory();
    await publish(dataDirectory);
    await mkdir(path.join(dataDirectory, "jobs", "queued-job"), { recursive: true });
    await writeFile(
      path.join(dataDirectory, "jobs", "queued-job", "job.json"),
      JSON.stringify({ status: "running" }),
    );
    await publish(dataDirectory, "corrupt-job", new Uint8Array([1, 2, 3]));

    const packages = await listInkCatalogPackages({ dataDir: dataDirectory });
    expect(packages).toEqual([{
      packageId: PACKAGE_ID,
      revision: 3,
      title: "目录服务测试",
      entryUuid: DOCUMENT_UUID,
      fileName: FILE_NAME,
      bytes: built.archive.byteLength,
      sha256: built.sha256,
      manifestUrl: `/api/ink/v1/packages/${PACKAGE_ID}/manifest`,
      downloadUrl: `/api/ink/v1/packages/${PACKAGE_ID}/download`,
    }]);

    const loaded = await getInkCatalogPackage(PACKAGE_ID, { dataDir: dataDirectory });
    expect(loaded).toBeDefined();
    const manifestDocument = built.manifest.documents[0];
    const variant = manifestDocument.variants[0];
    const page = variant.pages[0];

    expect(getInkManifestArtifact(loaded!).bytes).toEqual(loaded!.contents.files.get("ink-manifest.json"));
    expect(getInkDocumentArtifact(loaded!, DOCUMENT_UUID)?.bytes).toEqual(built.files.get(manifestDocument.documentPath));
    expect(getInkFrameArtifact(loaded!, variant.variantId, DOCUMENT_UUID, 0)?.bytes).toEqual(built.files.get(page.imagePath));
    expect(getInkSidecarArtifact(loaded!, variant.variantId, DOCUMENT_UUID, "0")?.bytes).toEqual(built.files.get(page.sidecarPath));
    expect(getInkDownloadArtifact(loaded!).bytes).toEqual(built.archive);
  });

  it("rejects URL/path-shaped identifiers before lookup", async () => {
    const dataDirectory = await temporaryDataDirectory();
    await publish(dataDirectory);
    const loaded = (await getInkCatalogPackage(PACKAGE_ID, { dataDir: dataDirectory }))!;

    await expect(getInkCatalogPackage("../complete-job", { dataDir: dataDirectory }))
      .rejects.toBeInstanceOf(InkCatalogInputError);
    expect(() => getInkDocumentArtifact(loaded, "%2e%2e")).toThrow(InkCatalogInputError);
    expect(() => getInkFrameArtifact(loaded, "../../artifact.ink", DOCUMENT_UUID, "0"))
      .toThrow(InkCatalogInputError);
    expect(() => getInkFrameArtifact(loaded, built.manifest.variants[0].id, DOCUMENT_UUID, "00"))
      .toThrow(InkCatalogInputError);
  });

  it("does not publish an artifact symlink even when its target is a valid package", async () => {
    const dataDirectory = await temporaryDataDirectory();
    const externalArchive = path.join(dataDirectory, "external.ink");
    await writeFile(externalArchive, built.archive);
    const jobDirectory = path.join(dataDirectory, "jobs", "symlink-job");
    await mkdir(jobDirectory, { recursive: true });
    await writeFile(path.join(jobDirectory, "job.json"), JSON.stringify({
      status: "complete",
      package: {
        packageId: PACKAGE_ID,
        fileName: FILE_NAME,
        bytes: built.archive.byteLength,
        sha256: built.sha256,
      },
    }));
    await symlink(externalArchive, path.join(jobDirectory, "artifact.ink"));

    expect(await listInkCatalogPackages({ dataDir: dataDirectory })).toEqual([]);
  });

  it("reuses only small verified catalog metadata while an unchanged job stays stable", async () => {
    const dataDirectory = await temporaryDataDirectory();
    await publish(dataDirectory);
    resetInkCatalogValidationCacheForTests();

    expect(await listInkCatalogPackages({ dataDir: dataDirectory })).toHaveLength(1);
    expect(inkCatalogValidationCacheStatsForTests()).toEqual({
      entries: 1,
      hits: 0,
      misses: 1,
      validations: 1,
    });

    expect(await listInkCatalogPackages({ dataDir: dataDirectory })).toHaveLength(1);
    expect(inkCatalogValidationCacheStatsForTests()).toEqual({
      entries: 1,
      hits: 1,
      misses: 1,
      validations: 1,
    });
  });

  it("fully revalidates a new revision at the same job path", async () => {
    const dataDirectory = await temporaryDataDirectory();
    const revisionFour = await buildFixture(
      4,
      "目录服务测试 · 第四版",
      "2026-07-17T17:00:00+08:00",
    );
    await publish(dataDirectory);
    resetInkCatalogValidationCacheForTests();

    expect((await listInkCatalogPackages({ dataDir: dataDirectory }))[0]).toMatchObject({
      revision: 3,
      title: "目录服务测试",
    });
    await publish(dataDirectory, "complete-job", revisionFour.archive);
    expect((await listInkCatalogPackages({ dataDir: dataDirectory }))[0]).toMatchObject({
      revision: 4,
      title: "目录服务测试 · 第四版",
      sha256: revisionFour.sha256,
    });
    expect(inkCatalogValidationCacheStatsForTests().validations).toBe(2);
  });

  it("never reuses cached metadata for an artifact/job pair being atomically replaced", async () => {
    const dataDirectory = await temporaryDataDirectory();
    const revisionFour = await buildFixture(
      4,
      "目录服务测试 · 第四版",
      "2026-07-17T17:00:00+08:00",
    );
    await publish(dataDirectory);
    resetInkCatalogValidationCacheForTests();
    expect(await listInkCatalogPackages({ dataDir: dataDirectory })).toHaveLength(1);

    // Generator publication renames artifact.ink first and job.json second.
    // In that intermediate state the old summary must not make the new bytes visible.
    await writeFile(
      path.join(dataDirectory, "jobs", "complete-job", "artifact.ink"),
      revisionFour.archive,
    );
    expect(await listInkCatalogPackages({ dataDir: dataDirectory })).toEqual([]);

    await publish(dataDirectory, "complete-job", revisionFour.archive);
    expect((await listInkCatalogPackages({ dataDir: dataDirectory }))[0]).toMatchObject({
      revision: 4,
      sha256: revisionFour.sha256,
    });
  });

  it("isolates cache keys across data roots and keeps a changed corrupt archive hidden", async () => {
    const firstDirectory = await temporaryDataDirectory();
    const secondDirectory = await temporaryDataDirectory();
    await publish(firstDirectory);
    await publish(secondDirectory);
    resetInkCatalogValidationCacheForTests();

    expect(await listInkCatalogPackages({ dataDir: firstDirectory })).toHaveLength(1);
    expect(await listInkCatalogPackages({ dataDir: secondDirectory })).toHaveLength(1);
    expect(inkCatalogValidationCacheStatsForTests().validations).toBe(2);

    await publish(secondDirectory, "complete-job", new Uint8Array([1, 2, 3]));
    expect(await listInkCatalogPackages({ dataDir: secondDirectory })).toEqual([]);
    expect(await listInkCatalogPackages({ dataDir: firstDirectory })).toHaveLength(1);
    expect(inkCatalogValidationCacheStatsForTests()).toMatchObject({
      hits: 1,
      validations: 3,
    });
  });
});

describe("versioned package runtime routes", () => {
  it("serves byte-identical artifacts, strong ETags, conditional GET and problem responses", async () => {
    const dataDirectory = await temporaryDataDirectory();
    await publish(dataDirectory);
    const previousDataDirectory = process.env.INKOS_DATA_DIR;
    process.env.INKOS_DATA_DIR = dataDirectory;

    try {
      const listRequest = new Request("http://localhost/api/ink/v1/packages");
      const list = await listPackagesRoute(listRequest);
      expect(list.status).toBe(200);
      expect(list.headers.get("Content-Type")).toContain("application/json");
      const listed = await list.json() as {
        defaultPackageId: string;
        defaultEntryUuid: string;
        packages: Array<{ packageId: string; revision: number }>;
      };
      expect(listed).toMatchObject({
        schemaVersion: "inkos.package-catalog/v1",
        defaultPackageId: PAPERS3_HOME_PACKAGE_ID,
        defaultEntryUuid: PAPERS3_HOME_ENTRY_UUID,
      });
      expect(listed.packages[0]?.packageId).toBe(PAPERS3_HOME_PACKAGE_ID);
      expect(listed.packages).toContainEqual(expect.objectContaining({ packageId: PACKAGE_ID, revision: 3 }));
      const listNotModified = await listPackagesRoute(new Request(listRequest.url, {
        headers: { "If-None-Match": list.headers.get("ETag")! },
      }));
      expect(listNotModified.status).toBe(304);

      const packageContext = { params: Promise.resolve({ packageId: PACKAGE_ID }) };
      const manifest = await getManifestRoute(
        new Request(`http://localhost/api/ink/v1/packages/${PACKAGE_ID}/manifest`),
        packageContext,
      );
      const loaded = (await getInkCatalogPackage(PACKAGE_ID, { dataDir: dataDirectory }))!;
      expect(new Uint8Array(await manifest.arrayBuffer())).toEqual(
        getInkManifestArtifact(loaded).bytes,
      );
      expect(manifest.headers.get("ETag")).toMatch(/^"[a-f0-9]{64}"$/u);
      const manifestEtag = manifest.headers.get("ETag")!;

      const documentContext = { params: Promise.resolve({ packageId: PACKAGE_ID, uuid: DOCUMENT_UUID }) };
      const missingDocumentPrecondition = await getDocumentRoute(
        new Request(`http://localhost/api/ink/v1/packages/${PACKAGE_ID}/documents/${DOCUMENT_UUID}`),
        documentContext,
      );
      expect(missingDocumentPrecondition.status).toBe(428);
      expect(await missingDocumentPrecondition.json()).toMatchObject({
        code: "MANIFEST_PRECONDITION_REQUIRED",
      });
      const document = await getDocumentRoute(
        new Request(`http://localhost/api/ink/v1/packages/${PACKAGE_ID}/documents/${DOCUMENT_UUID}`, {
          headers: { "If-Match": manifestEtag },
        }),
        documentContext,
      );
      expect(document.headers.get("Content-Type")).toContain("application/json");
      expect(document.headers.get("X-Ink-Manifest-SHA256")).toBe(manifest.headers.get("X-Ink-SHA256"));
      expect(new Uint8Array(await document.arrayBuffer())).toEqual(
        built.files.get(built.manifest.documents[0].documentPath),
      );

      const rendered = await renderPackageRoute(
        new Request(`http://localhost/api/ink/v1/packages/${PACKAGE_ID}/render`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            documentUuid: DOCUMENT_UUID,
            manifestSha256: manifest.headers.get("X-Ink-SHA256"),
            displayMeta: { orientation: "landscape", fontLevel: 1, invert: false },
            pageIndex: 0,
          }),
        }),
        packageContext,
      );
      const renderedBytes = new Uint8Array(await rendered.arrayBuffer());
      expect(rendered.status).toBe(200);
      expect(rendered.headers.get("Cache-Control")).toBe("no-store");
      expect(rendered.headers.get("X-Ink-Frame-Manifest")).toBeTruthy();
      expect(rendered.headers.get("X-Ink-Sidecar")).toBeTruthy();
      expect(renderedBytes.subarray(0, 8)).toEqual(
        new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      );

      const variantId = built.manifest.variants[0].id;
      const frameContext = {
        params: Promise.resolve({ packageId: PACKAGE_ID, variantId, uuid: DOCUMENT_UUID, pageIndex: "0" }),
      };
      const frame = await getFrameRoute(
        new Request(`http://localhost/api/ink/v1/packages/${PACKAGE_ID}/frames/${variantId}/${DOCUMENT_UUID}/0`, {
          headers: { "If-Match": manifestEtag },
        }),
        frameContext,
      );
      expect(frame.headers.get("Content-Type")).toBe("image/png");
      expect(new Uint8Array(await frame.arrayBuffer())).toEqual(
        built.files.get(built.manifest.documents[0].variants[0].pages[0].imagePath),
      );

      const sidecar = await getSidecarRoute(
        new Request(`http://localhost/api/ink/v1/packages/${PACKAGE_ID}/frames/${variantId}/${DOCUMENT_UUID}/0/sidecar`, {
          headers: { "If-Match": manifestEtag },
        }),
        frameContext,
      );
      expect(sidecar.headers.get("Content-Type")).toContain("application/json");
      expect(new Uint8Array(await sidecar.arrayBuffer())).toEqual(
        built.files.get(built.manifest.documents[0].variants[0].pages[0].sidecarPath),
      );

      const download = await getDownloadRoute(
        new Request(`http://localhost/api/ink/v1/packages/${PACKAGE_ID}/download`),
        packageContext,
      );
      expect(download.headers.get("Content-Type")).toBe("application/vnd.inkos.package+zip");
      expect(download.headers.get("Content-Disposition")).toContain("catalog-fixture.ink");
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(built.archive);

      const missing = await getDocumentRoute(
        new Request(`http://localhost/api/ink/v1/packages/${PACKAGE_ID}/documents/${MISSING_UUID}`, {
          headers: { "If-Match": manifestEtag },
        }),
        { params: Promise.resolve({ packageId: PACKAGE_ID, uuid: MISSING_UUID }) },
      );
      expect(missing.status).toBe(404);
      expect(missing.headers.get("Content-Type")).toContain("application/problem+json");

      const invalid = await getManifestRoute(
        new Request("http://localhost/api/ink/v1/packages/%2e%2e/manifest"),
        { params: Promise.resolve({ packageId: ".." }) },
      );
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ code: "INVALID_REQUEST" });

      const staleManifestEtag = `"${"0".repeat(64)}"`;
      const staleResponses = await Promise.all([
        getDocumentRoute(
          new Request(`http://localhost/api/ink/v1/packages/${PACKAGE_ID}/documents/${DOCUMENT_UUID}`, {
            headers: { "If-Match": staleManifestEtag },
          }),
          documentContext,
        ),
        getFrameRoute(
          new Request(`http://localhost/api/ink/v1/packages/${PACKAGE_ID}/frames/${variantId}/${DOCUMENT_UUID}/0`, {
            headers: { "If-Match": staleManifestEtag },
          }),
          frameContext,
        ),
        getSidecarRoute(
          new Request(`http://localhost/api/ink/v1/packages/${PACKAGE_ID}/frames/${variantId}/${DOCUMENT_UUID}/0/sidecar`, {
            headers: { "If-Match": staleManifestEtag },
          }),
          frameContext,
        ),
      ]);
      for (const stale of staleResponses) {
        expect(stale.status).toBe(412);
        expect(stale.headers.get("Cache-Control")).toBe("no-store");
        expect(stale.headers.get("X-Ink-Manifest-SHA256")).toBe(manifest.headers.get("X-Ink-SHA256"));
        expect(await stale.json()).toMatchObject({ code: "PACKAGE_REVISION_CHANGED" });
      }
    } finally {
      if (previousDataDirectory === undefined) delete process.env.INKOS_DATA_DIR;
      else process.env.INKOS_DATA_DIR = previousDataDirectory;
    }
  }, 15_000);
});
