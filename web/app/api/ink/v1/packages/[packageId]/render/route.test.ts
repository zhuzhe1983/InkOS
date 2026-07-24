import { describe, expect, it, vi } from "vitest";

import type { LoadedInkCatalogPackage } from "@/lib/ink/catalog-store";
import { packagedDocument, type InkFrameSidecar } from "@/lib/ink/contracts";
import { expandImagePreviewDocuments } from "@/lib/ink/image-previews";
import { InkPackageRenderRuntime } from "@/lib/ink/package-renderer";
import { createInkDisplayVariant } from "@/lib/ink/package-builder";
import { RenderEngine } from "@/lib/rendering/engine";
import type { FrameManifest } from "@/lib/rendering/contracts";

import { handlePackageRender } from "./route";

const PACKAGE_ID = "60000000-0000-4000-8000-000000000099";
const ROOT = "60000000-0000-4000-8000-000000000001";
const CHILD = "60000000-0000-4000-8000-000000000002";
const MANIFEST_SHA256 = "b".repeat(64);

function loadedPackage(maximumPreviews = Number.POSITIVE_INFINITY): LoadedInkCatalogPackage {
  const root = packagedDocument({
    uuid: ROOT,
    source: { url: "https://example.com/feed", title: "48 item feed" },
    content: {
      schemaVersion: "inkos.content/v2",
      id: ROOT,
      revision: 1,
      locale: "en",
      page: {
        kind: "list",
        layout: "feed",
        title: "48 item feed",
        items: Array.from({ length: 48 }, (_value, index) => ({
          id: `item-${index}`,
          title: `Item ${index + 1}`,
          summary: `Summary ${index + 1}`,
          image: {
            source: { kind: "asset" as const, assetId: `feed/image-${index}` },
            alt: `Image ${index + 1}`,
          },
          link: {
            label: `Open item ${index + 1}`,
            target: { kind: "url" as const, url: `https://example.com/item/${index + 1}` },
          },
        })),
      },
    },
  });
  const expanded = expandImagePreviewDocuments([root], 256, maximumPreviews);
  const variant = createInkDisplayVariant("m5stack-paper-s3-portrait", {
    orientation: "portrait",
    fontLevel: 0,
    invert: false,
  });
  const manifest = {
    packageId: PACKAGE_ID,
    revision: 6,
    entryUuid: ROOT,
    variants: [variant],
    documents: expanded.documents.map((document) => ({
      uuid: document.uuid,
      ...(document.parentUuid ? { parentUuid: document.parentUuid } : {}),
    })),
  };
  return {
    manifest,
    contents: {
      manifest,
      documents: new Map(expanded.documents.map((document) => [document.uuid, document])),
      sidecars: new Map(),
      files: new Map(),
    },
    archive: new Uint8Array([1]),
    archiveSha256: "a".repeat(64),
    fileName: "feed.ink",
    manifestSha256: MANIFEST_SHA256,
  } as unknown as LoadedInkCatalogPackage;
}

function request(body: unknown): Request {
  return new Request(`http://localhost/api/ink/v1/packages/${PACKAGE_ID}/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ manifestSha256: MANIFEST_SHA256, ...(body as object) }),
  });
}

function unboundRequest(body: unknown, ifMatch?: string): Request {
  return new Request(`http://localhost/api/ink/v1/packages/${PACKAGE_ID}/render`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(ifMatch ? { "If-Match": ifMatch } : {}),
    },
    body: JSON.stringify(body),
  });
}

function context(packageId = PACKAGE_ID) {
  return { params: Promise.resolve({ packageId }) };
}

function headerJson<T>(response: Response, name: string): T {
  const encoded = response.headers.get(name);
  if (!encoded) throw new Error(`Missing ${name}`);
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as T;
}

describe("POST /api/ink/v1/packages/{packageId}/render", () => {
  it("renders an unbundled normal-polarity display variant with verified PNG metadata", async () => {
    const loaded = loadedPackage();
    const response = await handlePackageRender(request({
      documentUuid: ROOT,
      displayMeta: { orientation: "landscape", fontLevel: 2, invert: false },
      pageIndex: 0,
    }), context(), {
      getPackage: async () => loaded,
      renderRuntime: new InkPackageRenderRuntime(),
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const manifest = headerJson<FrameManifest>(response, "X-Ink-Frame-Manifest");
    const sidecar = headerJson<InkFrameSidecar>(response, "X-Ink-Sidecar");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Content-Length")).toBe(String(bytes.byteLength));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Ink-SHA256")).toBe(manifest.sha256);
    expect(response.headers.get("X-Ink-Manifest-SHA256")).toBe(MANIFEST_SHA256);
    expect(response.headers.get("ETag")).toBe(`"${manifest.sha256}"`);
    expect(response.headers.get("X-Ink-Refresh-Hint")).toBeNull();
    expect(manifest.refreshHint).toBeUndefined();
    expect(bytes.subarray(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(manifest).toMatchObject({
      documentId: ROOT,
      displayMeta: { orientation: "landscape", fontLevel: 2, invert: false },
      pagination: { pageIndex: 0 },
    });
    expect(sidecar).toMatchObject({
      packageId: PACKAGE_ID,
      documentUuid: ROOT,
      variantId: "m5stack-paper-s3-portrait.landscape.normal.font-p2",
      pageIndex: 0,
    });
  });

  it("declares binary-text only when both semantic content and final gray4 pixels are safe", async () => {
    const loaded = loadedPackage();
    const root = loaded.contents.documents.get(ROOT)!;
    if (root.content.page.kind !== "list") throw new Error("Expected list fixture");
    for (const item of root.content.page.items) delete item.image;

    const response = await handlePackageRender(request({
      documentUuid: ROOT,
      displayMeta: { orientation: "portrait", fontLevel: 0, invert: false },
      pageIndex: 0,
    }), context(), {
      getPackage: async () => loaded,
      renderRuntime: new InkPackageRenderRuntime(),
    });
    const manifest = headerJson<FrameManifest>(response, "X-Ink-Frame-Manifest");

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Ink-Refresh-Hint")).toBe("binary-text");
    expect(response.headers.get("Access-Control-Expose-Headers"))
      .toContain("X-Ink-Refresh-Hint");
    expect(manifest.refreshHint).toBe("binary-text");
  });

  it("keeps UUID-first RSS recovery metadata on an on-demand variant", async () => {
    const loaded = loadedPackage(0);
    const root = loaded.contents.documents.get(ROOT)!;
    if (root.content.page.kind !== "list") throw new Error("Expected feed fixture");
    root.content.page.items[0].link = {
      label: "阅读详情",
      target: { kind: "document", documentId: CHILD },
    };
    const child = packagedDocument({
      uuid: CHILD,
      parentUuid: ROOT,
      source: {
        title: "Packaged article",
        url: "https://example.com/articles/packaged",
      },
      content: {
        schemaVersion: "inkos.content/v2",
        id: CHILD,
        revision: 1,
        locale: "en",
        page: {
          kind: "detail",
          layout: "article",
          title: "Packaged article",
          content: [{ type: "paragraph", text: "Article body." }],
        },
      },
    });
    (loaded.contents.documents as unknown as Map<string, typeof child>).set(CHILD, child);
    (loaded.manifest.documents as unknown as Array<{
      uuid: string;
      parentUuid?: string;
    }>).push({ uuid: CHILD, parentUuid: ROOT });

    const response = await handlePackageRender(request({
      documentUuid: ROOT,
      displayMeta: { orientation: "landscape", fontLevel: 2, invert: false },
      pageIndex: 0,
    }), context(), {
      getPackage: async () => loaded,
      renderRuntime: new InkPackageRenderRuntime(),
    });
    const sidecar = headerJson<InkFrameSidecar>(response, "X-Ink-Sidecar");
    const articleLink = sidecar.interactions.find(
      ({ contentPath }) => contentPath === "page.items[0].link",
    );

    expect(response.status).toBe(200);
    expect(articleLink).toMatchObject({
      targetUuid: CHILD,
      fallbackUrl: "https://example.com/articles/packaged",
    });
    expect(articleLink).not.toHaveProperty("targetUrl");
  });

  it("rejects inverse display metadata before loading a package", async () => {
    const getPackage = vi.fn();
    const response = await handlePackageRender(request({
      documentUuid: ROOT,
      displayMeta: { orientation: "portrait", fontLevel: 0, invert: true },
      pageIndex: 0,
    }), context(), { getPackage });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_REQUEST" });
    expect(getPackage).not.toHaveBeenCalled();
  });

  it("preserves all 48 links and 48 image hitboxes across on-demand pages", async () => {
    const loaded = loadedPackage();
    const runtime = new InkPackageRenderRuntime();
    const getPackage = async () => loaded;
    const displayMeta = { orientation: "portrait" as const, fontLevel: 0 as const, invert: false };
    const first = await handlePackageRender(request({ documentUuid: ROOT, displayMeta, pageIndex: 0 }), context(), {
      getPackage,
      renderRuntime: runtime,
    });
    const firstManifest = headerJson<FrameManifest>(first, "X-Ink-Frame-Manifest");
    const pageCount = firstManifest.pagination.pageCount;
    const sidecars = [headerJson<InkFrameSidecar>(first, "X-Ink-Sidecar")];

    for (let pageIndex = 1; pageIndex < pageCount; pageIndex += 1) {
      const response = await handlePackageRender(
        request({ documentUuid: ROOT, displayMeta, pageIndex }),
        context(),
        { getPackage, renderRuntime: runtime },
      );
      expect(response.status).toBe(200);
      sidecars.push(headerJson<InkFrameSidecar>(response, "X-Ink-Sidecar"));
    }
    const interactions = sidecars.flatMap((sidecar) => sidecar.interactions);

    expect(interactions.filter(({ contentPath }) => contentPath.endsWith(".link")))
      .toHaveLength(48);
    expect(interactions.filter(({ contentPath }) => contentPath.endsWith(".image.fullscreen")))
      .toHaveLength(48);
    expect(interactions.filter(({ targetUrl }) => targetUrl !== undefined)).toHaveLength(48);
    for (const imageHitbox of interactions.filter(
      ({ contentPath }) => contentPath.endsWith(".image.fullscreen"),
    )) {
      expect(loaded.contents.documents.has(imageHitbox.targetUuid)).toBe(true);
    }
  });

  it("renders a capped realtime draft and only links materialized image previews", async () => {
    const loaded = loadedPackage(6);
    const response = await handlePackageRender(request({
      documentUuid: ROOT,
      displayMeta: { orientation: "portrait", fontLevel: 0, invert: false },
      pageIndex: 2,
    }), context(), {
      getPackage: async () => loaded,
      renderRuntime: new InkPackageRenderRuntime(),
    });
    const sidecar = headerJson<InkFrameSidecar>(response, "X-Ink-Sidecar");

    expect(response.status).toBe(200);
    expect(loaded.contents.documents).toHaveLength(7);
    for (const interaction of sidecar.interactions.filter(
      ({ contentPath }) => contentPath.endsWith(".image.fullscreen"),
    )) {
      expect(loaded.contents.documents.has(interaction.targetUuid)).toBe(true);
    }
  });

  it("clamps page indexes after display-specific reflow and reports the actual page", async () => {
    const loaded = loadedPackage();
    const response = await handlePackageRender(request({
      documentUuid: ROOT,
      displayMeta: { orientation: "landscape", fontLevel: -2, invert: false },
      pageIndex: 999_999,
    }), context(), {
      getPackage: async () => loaded,
      renderRuntime: new InkPackageRenderRuntime(),
    });
    const manifest = headerJson<FrameManifest>(response, "X-Ink-Frame-Manifest");
    const sidecar = headerJson<InkFrameSidecar>(response, "X-Ink-Sidecar");

    expect(response.status).toBe(200);
    expect(Number(response.headers.get("X-Ink-Actual-Page-Index")))
      .toBe(manifest.pagination.pageCount - 1);
    expect(response.headers.get("X-Ink-Requested-Page-Index")).toBe("999999");
    expect(manifest.pagination.pageIndex).toBe(manifest.pagination.pageCount - 1);
    expect(sidecar.pageIndex).toBe(manifest.pagination.pageIndex);
  });

  it("uses a bounded frame LRU and reuses an exact frame before eviction", async () => {
    const loaded = loadedPackage();
    const runtime = new InkPackageRenderRuntime({
      maximumFrameEntries: 1,
      maximumFrameBytes: 16 * 1024 * 1024,
    });
    const engine = new RenderEngine();
    const render = vi.spyOn(engine, "render");
    const portrait = {
      documentUuid: ROOT,
      displayMeta: { orientation: "portrait" as const, fontLevel: 0 as const, invert: false },
      pageIndex: 0,
    };
    const landscape = {
      ...portrait,
      displayMeta: { ...portrait.displayMeta, orientation: "landscape" as const },
    };

    await runtime.render(loaded, portrait, engine);
    await runtime.render(loaded, portrait, engine);
    expect(render).toHaveBeenCalledTimes(1);
    await runtime.render(loaded, landscape, engine);
    await runtime.render(loaded, portrait, engine);
    expect(render).toHaveBeenCalledTimes(3);
  });

  it("deduplicates concurrent frames and always selects the PaperS3 profile", async () => {
    const loaded = loadedPackage();
    loaded.manifest.variants[0] = createInkDisplayVariant("m5stack-xiaozhi-card", {
      orientation: "portrait",
      fontLevel: 0,
      invert: false,
    });
    const runtime = new InkPackageRenderRuntime();
    const engine = new RenderEngine();
    const render = vi.spyOn(engine, "render");
    const input = {
      documentUuid: ROOT,
      displayMeta: { orientation: "portrait" as const, fontLevel: 0 as const, invert: false },
      pageIndex: 0,
    };
    const results = await Promise.all([
      runtime.render(loaded, input, engine),
      runtime.render(loaded, input, engine),
    ]);

    expect(render).toHaveBeenCalledTimes(1);
    expect(results[0].frame.manifest.screenProfileId).toBe("m5stack-paper-s3-portrait");
    expect(results[0].variant.profileId).toBe("m5stack-paper-s3-portrait");
    expect(results[1].frame.payload).toEqual(results[0].frame.payload);
  });

  it("returns problem responses for invalid, missing and inconsistent package input", async () => {
    const loaded = loadedPackage();
    const dependencies = {
      getPackage: async () => loaded,
      renderRuntime: new InkPackageRenderRuntime(),
    };
    const invalid = await handlePackageRender(
      request({ documentUuid: ROOT, displayMeta: { orientation: "diagonal" } }),
      context(),
      dependencies,
    );
    const missingDocument = await handlePackageRender(
      request({ documentUuid: "60000000-0000-4000-8000-000000000002" }),
      context(),
      dependencies,
    );
    const missingPackage = await handlePackageRender(
      request({ documentUuid: ROOT }),
      context(),
      { getPackage: async () => undefined },
    );
    const missingPrecondition = await handlePackageRender(
      unboundRequest({ documentUuid: ROOT }),
      context(),
      dependencies,
    );
    const staleManifest = await handlePackageRender(
      request({ documentUuid: ROOT, manifestSha256: "c".repeat(64) }),
      context(),
      dependencies,
    );
    const ifMatch = await handlePackageRender(
      unboundRequest({ documentUuid: ROOT }, `"${MANIFEST_SHA256}"`),
      context(),
      dependencies,
    );

    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "INVALID_REQUEST" });
    expect(missingDocument.status).toBe(404);
    expect(await missingDocument.json()).toMatchObject({ code: "DOCUMENT_NOT_FOUND" });
    expect(missingPackage.status).toBe(404);
    expect(await missingPackage.json()).toMatchObject({ code: "PACKAGE_NOT_FOUND" });
    expect(missingPrecondition.status).toBe(428);
    expect(await missingPrecondition.json()).toMatchObject({ code: "MANIFEST_PRECONDITION_REQUIRED" });
    expect(staleManifest.status).toBe(412);
    expect(staleManifest.headers.get("Cache-Control")).toBe("no-store");
    expect(await staleManifest.json()).toMatchObject({ code: "PACKAGE_REVISION_CHANGED" });
    expect(ifMatch.status).toBe(200);
  });
});
