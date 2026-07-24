import { describe, expect, it } from "vitest";

import { readInkArchive } from "./archive";
import { inkHitboxSchema, packagedDocument } from "./contracts";
import { imagePreviewDocumentUuid } from "./image-previews";
import { hitTest } from "./navigation";
import { buildRenderedInkPackage, createInkDisplayVariant } from "./package-builder";

const PACKAGE = "10000000-0000-4000-8000-000000000099";
const ROOT = "10000000-0000-4000-8000-000000000001";
const CHILD = "10000000-0000-4000-8000-000000000002";
const createdAt = "2026-07-16T15:00:00+08:00";

function documents() {
  const root = packagedDocument({
    uuid: ROOT,
    source: { title: "Nook 电子墨水屏系列" },
    content: {
      schemaVersion: "inkos.content/v2",
      id: ROOT,
      revision: 1,
      locale: "zh-CN",
      page: {
        kind: "list",
        layout: "feed",
        title: "Nook 电子墨水屏系列",
        items: [
          {
            id: "simple-touch",
            title: "Nook Simple Touch",
            link: {
              label: "阅读详情",
              target: { kind: "document", documentId: CHILD },
            },
          },
          {
            id: "remote-story",
            title: "尚未打包的网页",
            link: {
              label: "服务端抓取并打开",
              target: { kind: "url", url: "https://example.com/remote-story" },
            },
          },
        ],
      },
    },
  });
  const child = packagedDocument({
    uuid: CHILD,
    parentUuid: ROOT,
    source: {
      title: "Nook Simple Touch",
      url: "https://example.com/articles/nook-simple-touch",
    },
    content: {
      schemaVersion: "inkos.content/v2",
      id: CHILD,
      revision: 1,
      locale: "zh-CN",
      page: {
        kind: "detail",
        layout: "article",
        title: "Nook Simple Touch",
        content: [{ type: "paragraph", text: "Nook Simple Touch 是采用电子墨水屏的阅读器。" }],
      },
    },
  });
  return [root, child];
}

describe("rendered .ink package builder", () => {
  it("renders all pages and emits verified UUID hitbox sidecars", async () => {
    const built = await buildRenderedInkPackage({
      packageId: PACKAGE,
      slug: "nook-eink-zh",
      revision: 1,
      title: "Nook 电子墨水屏系列",
      entryUuid: ROOT,
      createdAt,
      generator: { name: "inkos-test", version: "1.0.0" },
      provenance: {
        seeds: [{
          url: "https://zh.wikipedia.org/wiki/Nook#电子墨水屏系列",
          title: "Nook",
          retrievedAt: createdAt,
          license: "CC BY-SA 4.0",
        }],
        crawl: { maxDepth: 1, maxDocuments: 2 },
      },
      variants: [createInkDisplayVariant("m5stack-paper-s3-portrait", {
        orientation: "portrait",
        invert: false,
        fontLevel: 0,
      })],
      documents: documents(),
    });
    const unpacked = await readInkArchive(built.archive);
    const rootIndex = unpacked.manifest.documents.find((document) => document.uuid === ROOT)!;
    const firstPage = rootIndex.variants[0].pages[0];
    const sidecar = unpacked.sidecars.get(firstPage.sidecarPath)!;

    expect(unpacked.manifest.documents).toHaveLength(2);
    expect(unpacked.manifest.compatibility.requiredCapabilities).toContain("device.settings-v1");
    expect(unpacked.manifest.compatibility.requiredCapabilities).not.toContain("display.invert-v1");
    expect(built.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(sidecar.documentUuid).toBe(ROOT);
    expect(sidecar.interactions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        targetUuid: CHILD,
        fallbackUrl: "https://example.com/articles/nook-simple-touch",
      }),
      expect.objectContaining({
        label: "服务端抓取并打开",
        targetUuid: ROOT,
        targetUrl: "https://example.com/remote-story",
      }),
    ]));
    expect(unpacked.files.get(firstPage.imagePath)?.subarray(0, 8)).toEqual(
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    );
  });

  it("keeps ordinary packaged links offline and rejects unsafe recovery URLs", async () => {
    const ordinaryDocuments = documents();
    const rootPage = ordinaryDocuments[0].content.page;
    if (rootPage.kind !== "list") throw new Error("Expected the root list fixture");
    rootPage.layout = "list";
    const built = await buildRenderedInkPackage({
      packageId: PACKAGE,
      slug: "ordinary-packaged-link",
      revision: 1,
      title: "Ordinary packaged link",
      entryUuid: ROOT,
      createdAt,
      generator: { name: "inkos-test", version: "1.0.0" },
      provenance: {
        seeds: [{ url: "https://example.com", title: "Example", retrievedAt: createdAt }],
        crawl: { maxDepth: 1, maxDocuments: 2 },
      },
      variants: [createInkDisplayVariant("m5stack-paper-s3-portrait", {
        orientation: "portrait",
        invert: false,
        fontLevel: 0,
      })],
      documents: ordinaryDocuments,
    });
    const unpacked = await readInkArchive(built.archive);
    const rootIndex = unpacked.manifest.documents.find((document) => document.uuid === ROOT)!;
    const firstPage = rootIndex.variants[0].pages[0];
    const childInteraction = unpacked.sidecars.get(firstPage.sidecarPath)!.interactions.find(
      ({ targetUuid }) => targetUuid === CHILD,
    )!;

    expect(childInteraction).toMatchObject({ targetUuid: CHILD });
    expect(childInteraction).not.toHaveProperty("targetUrl");
    expect(childInteraction).not.toHaveProperty("fallbackUrl");

    const baseHitbox = {
      id: "feed-item",
      contentPath: "page.items[0].link",
      label: "阅读详情",
      bounds: { x: 0, y: 0, width: 100, height: 40 },
      targetUuid: CHILD,
    };
    expect(inkHitboxSchema.safeParse({
      ...baseHitbox,
      fallbackUrl: "http://example.com/article",
    }).success).toBe(false);
    expect(inkHitboxSchema.safeParse({
      ...baseHitbox,
      fallbackUrl: "not a URL",
    }).success).toBe(false);
    expect(inkHitboxSchema.safeParse({
      ...baseHitbox,
      fallbackUrl: "https://reader:secret@example.com/article",
    }).success).toBe(false);
    expect(inkHitboxSchema.safeParse({
      ...baseHitbox,
      targetUrl: "https://example.com/action",
      fallbackUrl: "https://example.com/recovery",
    }).success).toBe(false);
  });

  it("rejects a renderer link to a document omitted from the package", async () => {
    await expect(buildRenderedInkPackage({
      packageId: PACKAGE,
      slug: "broken",
      revision: 1,
      title: "Broken",
      entryUuid: ROOT,
      createdAt,
      generator: { name: "inkos-test", version: "1.0.0" },
      provenance: {
        seeds: [{ url: "https://example.com", title: "Broken", retrievedAt: createdAt }],
        crawl: { maxDepth: 0, maxDocuments: 1 },
      },
      variants: [createInkDisplayVariant("m5stack-paper-s3-portrait", {
        orientation: "portrait",
        invert: false,
        fontLevel: 0,
      })],
      documents: documents().slice(0, 1),
    })).rejects.toThrow(/links missing UUID/u);
  });

  it("packages deterministic full-screen image children and image-specific hitboxes", async () => {
    const imageDocuments = documents();
    const rootPage = imageDocuments[0].content.page;
    if (rootPage.kind !== "list") throw new Error("Expected the root list fixture");
    rootPage.items[0].image = {
      source: { kind: "asset", assetId: "nook/simple-touch-cover" },
      alt: "Nook Simple Touch cover",
      caption: "Product cover",
    };
    const progress: Array<{ completed: number; total: number }> = [];
    const built = await buildRenderedInkPackage({
      packageId: PACKAGE,
      slug: "nook-with-image",
      revision: 1,
      title: "Nook with image",
      entryUuid: ROOT,
      createdAt,
      generator: { name: "inkos-test", version: "1.0.0" },
      provenance: {
        seeds: [{ url: "https://example.com/nook", title: "Nook", retrievedAt: createdAt }],
        crawl: { maxDepth: 1, maxDocuments: 2 },
      },
      variants: [createInkDisplayVariant("m5stack-paper-s3-portrait", {
        orientation: "portrait",
        invert: false,
        fontLevel: 0,
      })],
      documents: imageDocuments,
    }, undefined, {
      onVariantRendered: ({ completed, total }) => {
        progress.push({ completed, total });
      },
    });
    const unpacked = await readInkArchive(built.archive);
    const previewUuid = imagePreviewDocumentUuid(ROOT, "page.items[0].image");
    const preview = unpacked.documents.get(previewUuid)!;
    const previewIndex = unpacked.manifest.documents.find(({ uuid }) => uuid === previewUuid)!;
    const rootIndex = unpacked.manifest.documents.find(({ uuid }) => uuid === ROOT)!;
    const rootInteractions = rootIndex.variants[0].pages.flatMap((page) =>
      unpacked.sidecars.get(page.sidecarPath)?.interactions ?? []
    );
    const previewHitbox = rootInteractions.find(
      ({ contentPath }) => contentPath === "page.items[0].image.fullscreen",
    )!;
    const cardHitbox = rootInteractions.find(
      ({ contentPath }) => contentPath === "page.items[0].link",
    )!;
    const previewSidecar = unpacked.sidecars.get(previewIndex.variants[0].pages[0].sidecarPath)!;

    expect(unpacked.manifest.documents).toHaveLength(3);
    expect(preview).toMatchObject({
      uuid: previewUuid,
      parentUuid: ROOT,
      source: { title: "Product cover" },
      content: {
        page: {
          kind: "image",
          layout: "contain",
          image: { alt: "Nook Simple Touch cover" },
        },
      },
    });
    expect(preview.content.page).not.toHaveProperty("image.caption");
    expect(previewHitbox.targetUuid).toBe(previewUuid);
    expect(cardHitbox.targetUuid).toBe(CHILD);
    expect(previewHitbox.bounds.width * previewHitbox.bounds.height)
      .toBeLessThan(cardHitbox.bounds.width * cardHitbox.bounds.height);
    expect(hitTest(
      rootInteractions,
      previewHitbox.bounds.x + Math.floor(previewHitbox.bounds.width / 2),
      previewHitbox.bounds.y + Math.floor(previewHitbox.bounds.height / 2),
    )?.targetUuid).toBe(previewUuid);
    expect(previewSidecar).toMatchObject({
      documentUuid: previewUuid,
      parentUuid: ROOT,
      interactions: [],
    });
    expect(progress).toEqual([
      { completed: 1, total: 3 },
      { completed: 2, total: 3 },
      { completed: 3, total: 3 },
    ]);
  });
});
