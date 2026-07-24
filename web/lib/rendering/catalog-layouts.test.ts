import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  imageSourceKey,
  resolveDocumentImages,
  type AssetResolver,
  type ImageResolution,
} from "./asset-resolver";
import {
  contentDocumentSchema,
  renderRequestSchema,
  screenProfileSchema,
  type ContentDocument,
  type ContentImage,
  type RenderRequestInput,
  type ScreenProfile,
} from "./contracts";
import { RenderEngine } from "./engine";
import { getScreenProfile, orientScreenProfile } from "./profiles";
import { layoutSemanticDocument, type SemanticLayoutResult } from "./semantic-layout";

type Orientation = "portrait" | "landscape";
type CatalogLayout = "list" | "grid" | "cardboard" | "postcard" | "reader";

const DEVICE_CASES = [
  {
    label: "PaperS3",
    profileId: "m5stack-paper-s3-portrait",
    nativeSize: { width: 960, height: 540 },
    portrait: { logicalSize: { width: 540, height: 960 }, displayRotation: 90 },
    landscape: { logicalSize: { width: 960, height: 540 }, displayRotation: 0 },
  },
  {
    label: "Xiaozhi Card Kit",
    profileId: "m5stack-xiaozhi-card",
    nativeSize: { width: 176, height: 264 },
    portrait: { logicalSize: { width: 176, height: 264 }, displayRotation: 0 },
    landscape: { logicalSize: { width: 264, height: 176 }, displayRotation: 90 },
  },
  {
    label: "PaperColor",
    profileId: "m5stack-paper-color",
    nativeSize: { width: 400, height: 600 },
    portrait: { logicalSize: { width: 400, height: 600 }, displayRotation: 0 },
    landscape: { logicalSize: { width: 600, height: 400 }, displayRotation: 90 },
  },
] as const;

const ORIENTATIONS = ["portrait", "landscape"] as const;

const FIXTURE_JPEG = sharp({
  create: {
    width: 240,
    height: 160,
    channels: 3,
    background: { r: 52, g: 114, b: 168 },
  },
}).jpeg({ quality: 90 }).toBuffer();

class FixtureAssetResolver implements AssetResolver {
  readonly resolvedKeys: string[] = [];

  async resolve(image: ContentImage): Promise<ImageResolution> {
    this.resolvedKeys.push(imageSourceKey(image));
    const payload = await FIXTURE_JPEG;
    return {
      status: "resolved",
      image: {
        dataUri: `data:image/jpeg;base64,${payload.toString("base64")}`,
        width: 240,
        height: 160,
        mimeType: "image/jpeg",
      },
    };
  }
}

function pngSize(payload: Buffer): { width: number; height: number } {
  return {
    width: payload.readUInt32BE(16),
    height: payload.readUInt32BE(20),
  };
}

function image(index: number) {
  return {
    source: {
      kind: "remote",
      url: `https://picsum.photos/id/${1020 + index}/720/480`,
    },
    alt: `第 ${index + 1} 张演示图片`,
  };
}

function linkedItem(index: number) {
  return {
    id: `catalog-item-${index + 1}`,
    eyebrow: index % 2 === 0 ? "日程" : "资讯",
    title: `第 ${index + 1} 项语义内容`,
    summary: `这是第 ${index + 1} 项摘要，渲染器应自行决定卡片尺寸和排列方式。`,
    image: image(index),
    metadata: [
      { label: "时间", value: `0${(index % 8) + 1}:30` },
      { label: "状态", value: index % 2 === 0 ? "进行中" : "待处理" },
    ],
    link: {
      label: `打开第 ${index + 1} 项`,
      target: { kind: "document", documentId: `catalog/detail-${index + 1}` },
    },
  };
}

function listDocument(layout: "list" | "grid" | "cardboard"): ContentDocument {
  return contentDocumentSchema.parse({
    schemaVersion: "inkos.content/v2",
    id: `catalog/${layout}`,
    revision: 1,
    locale: "zh-CN",
    page: {
      kind: "list",
      layout,
      title: layout === "grid" ? "网格内容" : layout === "cardboard" ? "状态看板" : "顺序列表",
      description: "内容只有语义，行列数、间距和分页均由目标屏幕决定。",
      items: Array.from({ length: 10 }, (_value, index) => linkedItem(index)),
    },
  });
}

function postcardDocument(): ContentDocument {
  return contentDocumentSchema.parse({
    schemaVersion: "inkos.content/v2",
    id: "catalog/postcard",
    revision: 1,
    locale: "zh-CN",
    page: {
      kind: "detail",
      layout: "postcard",
      eyebrow: "今日卡片",
      title: "一张图，一段值得停留的话",
      summary: "明信片适合重点消息、票券和带主图的单页信息；二维码本身仍然只是图片。",
      heroImage: image(20),
      content: [
        { type: "paragraph", text: "风从湖面经过，今天也适合把注意力留给真正重要的事情。" },
        { type: "quote", text: "少一点噪声，多一点清晰。", attribution: "InkOS" },
      ],
      links: [{
        label: "查看详情",
        target: { kind: "document", documentId: "catalog/postcard-detail" },
      }],
    },
  });
}

const READER_BLOCKS = [
  { type: "heading", level: 2, text: "第一章：语义内容" },
  {
    type: "paragraph",
    text: "阅读页没有页面标题栏，只承载连续正文。字号变化后，服务端应该重新换行和分页。",
  },
  {
    type: "list",
    ordered: true,
    items: ["内容不包含坐标", "内容不指定字号", "设备档案决定最终画面"],
  },
  { type: "quote", text: "同一份文字，在每块屏幕上重新编排。", attribution: "渲染原则" },
] as const;

function readerDocument(long = false): ContentDocument {
  const longParagraph =
    "墨水屏阅读强调稳定、清晰和低干扰。结构化内容只描述文字的层次，渲染器结合可用宽度、字号档位和安全区域决定每行长度与分页位置。";
  return contentDocumentSchema.parse({
    schemaVersion: "inkos.content/v2",
    id: long ? "catalog/reader-long" : "catalog/reader",
    revision: 1,
    locale: "zh-CN",
    page: {
      kind: "reader",
      content: long
        ? Array.from({ length: 18 }, (_value, index) => ({
            type: "paragraph",
            text: `第 ${index + 1} 段。${longParagraph.repeat(4)}`,
          }))
        : READER_BLOCKS,
    },
  });
}

const LEGACY_DETAIL_INPUT = {
  schemaVersion: "inkos.content/v2",
  id: "catalog/orientation-baseline",
  revision: 1,
  locale: "zh-CN",
  page: {
    kind: "detail",
    layout: "article",
    title: "方向兼容性基线",
    content: [{
      type: "paragraph",
      text: "未指定方向的旧请求必须继续按竖屏渲染。",
    }],
  },
} as const;

function legacyDetailDocument(): ContentDocument {
  return contentDocumentSchema.parse(LEGACY_DETAIL_INPUT);
}

function renderInput(value: unknown): RenderRequestInput {
  return value as RenderRequestInput;
}

function orientedProfile(profileId: string, orientation: Orientation): ScreenProfile {
  const profile = getScreenProfile(profileId);
  if (orientation === "portrait") return profile;

  const nativeIsLandscape = profile.nativeSize.width > profile.nativeSize.height;
  return screenProfileSchema.parse({
    ...profile,
    logicalSize: nativeIsLandscape
      ? profile.nativeSize
      : { width: profile.nativeSize.height, height: profile.nativeSize.width },
    displayRotation: nativeIsLandscape ? 0 : 90,
  });
}

async function semanticLayout(
  document: ContentDocument,
  profileId: string,
  orientation: Orientation,
  fontLevel: -2 | -1 | 0 | 1 | 2 = 0,
): Promise<SemanticLayoutResult> {
  const resolver = new FixtureAssetResolver();
  const resolvedImages = await resolveDocumentImages(document, resolver);
  const parsedRequest = renderRequestSchema.parse({
    profileId,
    document,
    displayMeta: { orientation, invert: false, fontLevel },
  });
  return layoutSemanticDocument(document, orientedProfile(profileId, orientation), {
    resolvedImages,
    displayMeta: parsedRequest.displayMeta,
  });
}

function expectInteractionsInside(
  layout: SemanticLayoutResult,
  logicalSize: { width: number; height: number },
): void {
  for (const interaction of layout.pages.flatMap((page) => page.interactions)) {
    expect(interaction.bounds.x).toBeGreaterThanOrEqual(0);
    expect(interaction.bounds.y).toBeGreaterThanOrEqual(0);
    expect(interaction.bounds.width).toBeGreaterThan(0);
    expect(interaction.bounds.height).toBeGreaterThan(0);
    expect(interaction.bounds.x + interaction.bounds.width).toBeLessThanOrEqual(logicalSize.width);
    expect(interaction.bounds.y + interaction.bounds.height).toBeLessThanOrEqual(logicalSize.height);
  }
}

function listItemPaths(layout: SemanticLayoutResult): string[] {
  return layout.pages
    .flatMap((page) => page.contentPaths)
    .filter((path) => /^page\.items\[\d+\]$/u.test(path));
}

function firstImageAttributes(svg: string): Record<string, string> {
  const tag = svg.match(/<image\b[^>]*>/u)?.[0];
  if (!tag) throw new Error("Expected postcard output to contain an SVG image");
  return Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)="([^"]*)"/gu)].map((match) => [match[1], match[2]]),
  );
}

describe("display orientation contract", () => {
  it("defaults old requests to portrait without changing their other display defaults", () => {
    const request = renderRequestSchema.parse({
      profileId: DEVICE_CASES[0].profileId,
      document: legacyDetailDocument(),
    });

    expect(request.displayMeta).toEqual({
      orientation: "portrait",
      invert: false,
      fontLevel: 0,
    });
  });

  it.each(ORIENTATIONS)("accepts the %s orientation", (orientation) => {
    const result = renderRequestSchema.safeParse({
      profileId: DEVICE_CASES[0].profileId,
      document: legacyDetailDocument(),
      displayMeta: { orientation, invert: false, fontLevel: 0 },
    });

    expect(result.success).toBe(true);
  });

  it("rotates asymmetric safe areas and partial-refresh alignment with logical axes", () => {
    const base = screenProfileSchema.parse({
      ...getScreenProfile("m5stack-paper-s3-portrait"),
      safeArea: { top: 1, right: 2, bottom: 3, left: 4 },
      refresh: { supportsPartial: true, xAlignment: 8, yAlignment: 2 },
    });
    const landscape = orientScreenProfile(base, "landscape");

    expect(landscape.nativeSize).toEqual(base.nativeSize);
    expect(landscape.logicalSize).toEqual({ width: 960, height: 540 });
    expect(landscape.displayRotation).toBe(0);
    expect(landscape.safeArea).toEqual({ top: 2, right: 3, bottom: 4, left: 1 });
    expect(landscape.refresh).toEqual({
      supportsPartial: true,
      xAlignment: 2,
      yAlignment: 8,
    });
  });

  it("defaults missing orientation and retained normal polarity metadata", () => {
    const request = renderRequestSchema.parse({
      profileId: DEVICE_CASES[0].profileId,
      document: legacyDetailDocument(),
      displayMeta: { fontLevel: 1 },
    });

    expect(request.displayMeta).toEqual({
      orientation: "portrait",
      invert: false,
      fontLevel: 1,
    });
  });

  it("rejects retired inverse display metadata", () => {
    expect(renderRequestSchema.safeParse({
      profileId: DEVICE_CASES[0].profileId,
      document: legacyDetailDocument(),
      displayMeta: { invert: true, fontLevel: 1 },
    }).success).toBe(false);
  });

  it.each(["auto", "horizontal", "vertical", "PORTRAIT", 90, null])(
    "rejects the invalid orientation %j",
    (orientation) => {
      const result = renderRequestSchema.safeParse({
        profileId: DEVICE_CASES[0].profileId,
        document: legacyDetailDocument(),
        displayMeta: { orientation, invert: false, fontLevel: 0 },
      });

      expect(result.success).toBe(false);
    },
  );

  it.each(DEVICE_CASES)(
    "keeps the implicit portrait request byte-compatible on $label",
    async ({ profileId, portrait }) => {
      const engine = new RenderEngine();
      const document = legacyDetailDocument();
      const implicit = await engine.render({ profileId, document });
      const explicit = await engine.render(renderInput({
        profileId,
        document,
        displayMeta: { orientation: "portrait", invert: false, fontLevel: 0 },
      }));

      expect(implicit.payload.equals(explicit.payload)).toBe(true);
      expect(implicit.manifest.sha256).toBe(explicit.manifest.sha256);
      expect(implicit.manifest.logicalSize).toEqual(portrait.logicalSize);
      expect(implicit.manifest.displayRotation).toBe(portrait.displayRotation);
      expect(implicit.manifest.displayMeta).toEqual(explicit.manifest.displayMeta);
    },
  );

  it.each(DEVICE_CASES.flatMap((device) => ORIENTATIONS.map((orientation) => ({
    ...device,
    orientation,
    expected: device[orientation],
  }))))(
    "renders $label in $orientation with matching PNG and manifest geometry",
    async ({ profileId, nativeSize, orientation, expected }) => {
      const engine = new RenderEngine();
      const frame = await engine.render(renderInput({
        profileId,
        document: legacyDetailDocument(),
        displayMeta: { orientation, invert: false, fontLevel: 0 },
      }));

      expect(pngSize(frame.payload)).toEqual(expected.logicalSize);
      expect(frame.manifest).toMatchObject({
        nativeSize,
        logicalSize: expected.logicalSize,
        displayRotation: expected.displayRotation,
        displayMeta: { orientation, invert: false, fontLevel: 0 },
        update: {
          kind: "full",
          region: { x: 0, y: 0, ...expected.logicalSize },
        },
      });
    },
  );
});

describe("merged semantic layout contract", () => {
  it.each(["list", "grid", "cardboard"] as const)(
    "accepts %s as a list composition intent",
    (layout) => {
      const document = listDocument(layout);
      expect(document.page).toMatchObject({ kind: "list", layout });
    },
  );

  it("accepts postcard as a detail composition intent", () => {
    expect(postcardDocument().page).toMatchObject({ kind: "detail", layout: "postcard" });
  });

  it("accepts a title-free reader made only of text blocks", () => {
    const document = readerDocument();
    expect(document.page.kind).toBe("reader");
    expect(Object.keys(document.page)).not.toContain("title");
  });

  it.each([
    {
      label: "page title",
      page: { kind: "reader", title: "不允许的标题", content: [{ type: "paragraph", text: "正文" }] },
    },
    {
      label: "page summary",
      page: { kind: "reader", summary: "不允许的摘要", content: [{ type: "paragraph", text: "正文" }] },
    },
    {
      label: "image block",
      page: { kind: "reader", content: [{ type: "image", image: image(0) }] },
    },
    {
      label: "link block",
      page: {
        kind: "reader",
        content: [{
          type: "link",
          link: { label: "链接", target: { kind: "url", url: "https://example.com" } },
        }],
      },
    },
    {
      label: "page coordinates",
      page: { kind: "reader", x: 12, content: [{ type: "paragraph", text: "正文" }] },
    },
    {
      label: "block coordinates",
      page: { kind: "reader", content: [{ type: "paragraph", text: "正文", y: 24 }] },
    },
    {
      label: "font styling",
      page: { kind: "reader", content: [{ type: "paragraph", text: "正文", fontSize: 18 }] },
    },
    {
      label: "unknown page option",
      page: { kind: "reader", theme: "newspaper", content: [{ type: "paragraph", text: "正文" }] },
    },
  ])("strictly rejects reader $label", ({ page }) => {
    const result = contentDocumentSchema.safeParse({
      schemaVersion: "inkos.content/v2",
      id: "catalog/invalid-reader",
      revision: 1,
      page,
    });

    expect(result.success).toBe(false);
  });
});

const CATALOG_CASES: Array<{
  label: CatalogLayout;
  document: () => ContentDocument;
  expectedPaths: () => string[];
}> = [
  ...(["list", "grid", "cardboard"] as const).map((layout) => ({
    label: layout,
    document: () => listDocument(layout),
    expectedPaths: () => Array.from({ length: 10 }, (_value, index) => `page.items[${index}]`),
  })),
  {
    label: "postcard",
    document: postcardDocument,
    expectedPaths: () => [
      "page.title",
      "page.heroImage",
      "page.content[0]",
      "page.content[1]",
      "page.links[0]",
    ],
  },
  {
    label: "reader",
    document: readerDocument,
    expectedPaths: () => [
      "page.content[0]",
      "page.content[1]",
      "page.content[2].items[0]",
      "page.content[2].items[1]",
      "page.content[2].items[2]",
      "page.content[3]",
    ],
  },
];

describe("catalog layout behavior", () => {
  it.each(CATALOG_CASES.flatMap((layoutCase) => DEVICE_CASES.flatMap((device) =>
    ORIENTATIONS.map((orientation) => ({ layoutCase, device, orientation })),
  )))(
    "$layoutCase.label renders on $device.label in $orientation without losing semantic paths",
    async ({ layoutCase, device, orientation }) => {
      const document = layoutCase.document();
      const layout = await semanticLayout(document, device.profileId, orientation);
      const profile = orientedProfile(device.profileId, orientation);
      const allPaths = layout.pages.flatMap((page) => page.contentPaths);

      expect(layout.pages.length).toBeGreaterThanOrEqual(1);
      expect(layoutCase.expectedPaths().every((path) => allPaths.includes(path))).toBe(true);
      expectInteractionsInside(layout, profile.logicalSize);

      if (document.page.kind === "list") {
        expect(listItemPaths(layout)).toEqual(
          document.page.items.map((_item, index) => `page.items[${index}]`),
        );
      }
    },
  );

  it.each(DEVICE_CASES.flatMap((device) => (["grid", "cardboard"] as const).map((layout) => ({
    ...device,
    layout,
  }))))("uses multiple columns for $layout on a landscape $label", async ({ profileId, layout }) => {
    const result = await semanticLayout(listDocument(layout), profileId, "landscape");
    const hasMultipleColumns = result.pages.some((page) => {
      const itemHitAreas = page.interactions.filter((interaction) =>
        /^page\.items\[\d+\]\.link$/u.test(interaction.contentPath),
      );
      return new Set(itemHitAreas.map((interaction) => interaction.bounds.x)).size >= 2;
    });

    expect(hasMultipleColumns).toBe(true);
  });

  it.each(DEVICE_CASES.flatMap((device) => ORIENTATIONS.map((orientation) => ({
    ...device,
    orientation,
  }))))("keeps list input order on $label in $orientation", async ({ profileId, orientation }) => {
    const document = listDocument("list");
    const result = await semanticLayout(document, profileId, orientation);

    expect(listItemPaths(result)).toEqual(
      document.page.kind === "list"
        ? document.page.items.map((_item, index) => `page.items[${index}]`)
        : [],
    );
  });

  it("reflows and repaginates reader text when the global font level changes", async () => {
    const document = readerDocument(true);
    const small = await semanticLayout(document, "m5stack-xiaozhi-card", "portrait", -2);
    const large = await semanticLayout(document, "m5stack-xiaozhi-card", "portrait", 2);

    expect(large.pages.length).toBeGreaterThan(small.pages.length);
    expect(large.pages.map((page) => page.svg)).not.toEqual(small.pages.map((page) => page.svg));
    expect(new Set(large.pages.flatMap((page) => page.contentPaths))).toEqual(
      new Set(small.pages.flatMap((page) => page.contentPaths)),
    );
  });

  it.each(DEVICE_CASES.flatMap((device) => ORIENTATIONS.map((orientation) => ({
    ...device,
    orientation,
  }))))("preserves the postcard image aspect ratio on $label in $orientation", async ({
    profileId,
    orientation,
  }) => {
    const result = await semanticLayout(postcardDocument(), profileId, orientation);
    const imageAttributes = firstImageAttributes(result.pages[0].svg);
    const preserveAspectRatio = imageAttributes.preserveAspectRatio;

    if (preserveAspectRatio) {
      expect(preserveAspectRatio).not.toBe("none");
      expect(preserveAspectRatio).toMatch(/^(?:xMin|xMid|xMax)Y(?:Min|Mid|Max) (?:meet|slice)$/u);
    } else {
      expect(Number(imageAttributes.width) / Number(imageAttributes.height)).toBeCloseTo(240 / 160, 4);
    }
  });
});

describe("combined display metadata", () => {
  it.each(DEVICE_CASES)(
    "combines landscape output and a larger font on $label",
    async ({ profileId, landscape }) => {
      const engine = new RenderEngine();
      const document = legacyDetailDocument();
      const baseline = await engine.render(renderInput({
        profileId,
        document,
        displayMeta: { orientation: "landscape", invert: false, fontLevel: 0 },
      }));
      const combined = await engine.render(renderInput({
        profileId,
        document,
        displayMeta: { orientation: "landscape", invert: false, fontLevel: 2 },
      }));
      const decoded = await sharp(combined.payload)
        .removeAlpha()
        .toColourspace("srgb")
        .raw()
        .toBuffer();

      expect(pngSize(combined.payload)).toEqual(landscape.logicalSize);
      expect(combined.manifest).toMatchObject({
        logicalSize: landscape.logicalSize,
        displayRotation: landscape.displayRotation,
        displayMeta: { orientation: "landscape", invert: false, fontLevel: 2 },
      });
      expect(combined.manifest.sha256).not.toBe(baseline.manifest.sha256);
      expect(combined.payload.equals(baseline.payload)).toBe(false);
      expect(decoded.subarray(0, 3).toString("hex")).toBe(
        profileId === "m5stack-paper-s3-portrait" ? "f8f8f8" : "ffffff",
      );
    },
  );
});
