import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  inkFrameSidecarSchema,
  packagedDocumentSchema,
} from "./contracts";
import { createInkDisplayVariant } from "./package-builder";
import { frameSidecar } from "./sidecar";
import { renderEngine } from "../rendering/engine";

const DOCUMENT_UUID = "30000000-0000-4000-8000-000000000001";
const PACKAGE_UUID = "30000000-0000-4000-8000-000000000002";
const RELATED_UUID = "30000000-0000-4000-8000-000000000003";

function clockDocument(): z.input<typeof packagedDocumentSchema> {
  return {
    schemaVersion: "inkos.document/v1",
    uuid: DOCUMENT_UUID,
    source: { title: "时钟" },
    localWidgets: [{
      id: "clock-main",
      kind: "clock",
      contentPath: "page.title",
    }],
    content: {
      schemaVersion: "inkos.content/v2",
      id: DOCUMENT_UUID,
      revision: 1,
      locale: "zh-CN",
      page: {
        kind: "detail",
        layout: "postcard",
        title: "88:88:88",
        content: [{ type: "paragraph", text: "静态后备" }],
      },
    },
  };
}

function sidecar(): z.input<typeof inkFrameSidecarSchema> {
  return {
    schemaVersion: "inkos.frame-sidecar/v1",
    packageId: PACKAGE_UUID,
    documentUuid: DOCUMENT_UUID,
    variantId: "m5stack-paper-s3-portrait.portrait.normal.font-p0",
    pageIndex: 0,
    pageCount: 1,
    imagePath: "frames/clock.png",
    imageSha256: "a".repeat(64),
    logicalSize: { width: 540, height: 960 },
    interactions: [],
    dynamicRegions: [{
      id: "clock-main",
      kind: "clock",
      bounds: { x: 20, y: 100, width: 500, height: 43 },
      format: "HH:mm:ss",
      timezone: "Asia/Shanghai",
      refreshMs: 1_000,
      fullRefreshEvery: 60,
      style: {
        fontFamily: "monospace",
        fontSize: 36,
        fontWeight: 700,
        textAlign: "center",
        verticalAlign: "top",
        foreground: "black",
        background: "white",
      },
    }],
  };
}

describe("declarative local widgets", () => {
  it("defaults the bounded clock behavior without adding renderer-owned fields", () => {
    const parsed = packagedDocumentSchema.parse(clockDocument());
    expect(parsed.localWidgets).toEqual([{
      id: "clock-main",
      kind: "clock",
      contentPath: "page.title",
      format: "HH:mm:ss",
      timezone: "Asia/Shanghai",
      refreshMs: 1_000,
      fullRefreshEvery: 60,
    }]);
    expect(parsed.localWidgets?.[0]).not.toHaveProperty("bounds");
    expect(parsed.localWidgets?.[0]).not.toHaveProperty("style");
  });

  it("rejects executable or out-of-bounds widget declarations", () => {
    const executable = structuredClone(clockDocument()) as Record<string, unknown>;
    const widgets = executable.localWidgets as Array<Record<string, unknown>>;
    widgets[0].script = "setInterval(() => {}, 1000)";
    expect(packagedDocumentSchema.safeParse(executable).success).toBe(false);

    const tooFast = structuredClone(clockDocument());
    tooFast.localWidgets![0].refreshMs = 999;
    expect(packagedDocumentSchema.safeParse(tooFast).success).toBe(false);

    const tooMany = structuredClone(clockDocument());
    tooMany.localWidgets = Array.from({ length: 9 }, (_value, index) => ({
      ...tooMany.localWidgets![0],
      id: `clock-${index}`,
    }));
    expect(packagedDocumentSchema.safeParse(tooMany).success).toBe(false);

    const duplicate = structuredClone(clockDocument());
    duplicate.localWidgets!.push({ ...duplicate.localWidgets![0] });
    expect(packagedDocumentSchema.safeParse(duplicate).success).toBe(false);
  });

  it("keeps old sidecars valid and strictly bounds optional dynamic regions", () => {
    const valid = sidecar();
    expect(inkFrameSidecarSchema.parse(valid).dynamicRegions).toHaveLength(1);
    const legacy = structuredClone(valid);
    delete legacy.dynamicRegions;
    expect(inkFrameSidecarSchema.parse(legacy).dynamicRegions).toBeUndefined();

    const outside = structuredClone(valid);
    outside.dynamicRegions![0].bounds.x = 500;
    expect(inkFrameSidecarSchema.safeParse(outside).success).toBe(false);

    const invisible = structuredClone(valid);
    invisible.dynamicRegions![0].style.foreground = "white";
    expect(inkFrameSidecarSchema.safeParse(invisible).success).toBe(false);
  });

  it("rejects dynamic regions that cover a touch interaction", () => {
    const overlapping = structuredClone(sidecar());
    overlapping.interactions.push({
      id: "open",
      contentPath: "page.links[0]",
      label: "打开",
      bounds: { x: 100, y: 110, width: 100, height: 30 },
      targetUuid: DOCUMENT_UUID,
    });
    expect(inkFrameSidecarSchema.safeParse(overlapping).success).toBe(false);
  });

  it("emits fixed normal-polarity colors for a renderer-owned placeholder", async () => {
    const document = packagedDocumentSchema.parse(clockDocument());
    const displayMeta = { orientation: "portrait", fontLevel: 0, invert: false } as const;
    const variant = createInkDisplayVariant("m5stack-paper-s3-portrait", displayMeta);
    const frame = await renderEngine.render({
      profileId: variant.profileId,
      document: document.content,
      localWidgets: document.localWidgets,
      displayMeta,
    });
    const result = frameSidecar({
      packageId: PACKAGE_UUID,
      document,
      variant,
      frame,
      imagePath: "frames/clock.png",
    });

    expect(frame.textRegions?.find((region) => region.contentPath === "page.title")?.style.fontFamily)
      .toBe("monospace");
    expect(result.dynamicRegions).toEqual([
      expect.objectContaining({
        bounds: frame.textRegions?.find((region) => region.contentPath === "page.title")?.bounds,
        style: expect.objectContaining({
          foreground: "black",
          background: "white",
        }),
      }),
    ]);
  });

  it("keeps a canonical fallback for packaged detail navigation", async () => {
    const document = packagedDocumentSchema.parse({
      schemaVersion: "inkos.document/v1",
      uuid: DOCUMENT_UUID,
      source: { title: "RSS 详情", url: "https://example.com/posts/42" },
      content: {
        schemaVersion: "inkos.content/v2",
        id: DOCUMENT_UUID,
        revision: 1,
        locale: "zh-CN",
        page: {
          kind: "detail",
          layout: "article",
          title: "RSS 详情",
          navigation: [{
            label: "下一篇",
            target: { kind: "document", documentId: RELATED_UUID },
          }],
          content: [{ type: "paragraph", text: "正文" }],
        },
      },
    });
    const displayMeta = { orientation: "portrait", fontLevel: 0, invert: false } as const;
    const variant = createInkDisplayVariant("m5stack-paper-s3-portrait", displayMeta);
    const frame = await renderEngine.render({
      profileId: variant.profileId,
      document: document.content,
      displayMeta,
    });
    const result = frameSidecar({
      packageId: PACKAGE_UUID,
      document,
      variant,
      frame,
      imagePath: "frames/rss-detail.png",
      packagedUuids: new Set([DOCUMENT_UUID, RELATED_UUID]),
      feedDetailFallbackUrls: new Map([
        [RELATED_UUID, "https://example.com/posts/43"],
      ]),
    });

    expect(result.interactions).toContainEqual(expect.objectContaining({
      contentPath: "page.navigation[0]",
      label: "下一篇",
      targetUuid: RELATED_UUID,
      fallbackUrl: "https://example.com/posts/43",
    }));
  });
});
