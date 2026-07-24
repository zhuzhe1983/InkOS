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
  listItemSchema,
  renderRequestSchema,
  type ContentDocument,
  type ContentImage,
} from "./contracts";
import { RenderEngine } from "./engine";
import { getScreenProfile } from "./profiles";
import {
  DETAIL_SAMPLE_CONTENT,
  EBOOK_HOME_SAMPLE_CONTENT,
  GALLERY_SAMPLE_CONTENT,
  IMAGE_DETAIL_SAMPLE_CONTENT,
  LIST_SAMPLE_CONTENT,
  SAMPLE_CONTENT,
} from "./sample-content";
import { layoutSemanticDocument } from "./semantic-layout";

const FIXTURE_JPEG_DATA_URI = "data:image/jpeg;base64,/9j/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCACgAHgDAREAAhEBAxEB/8QAGAABAQEBAQAAAAAAAAAAAAAAAAkICgf/xAAYEAEAAwEAAAAAAAAAAAAAAAAACUeFxP/EABoBAQACAwEAAAAAAAAAAAAAAAAICQUHCgb/xAAcEQEAAAcBAAAAAAAAAAAAAAAABQdCRYGDwcP/2gAMAwEAAhEDEQA/AM6NGLUwAAAGxmknMeAAAAl46M05QAAAHvqjlcWAAAA2M0k5jwAAAEvHRmnKAAAA99UcriwAAAGxmknMeAAAAl46M05QAAAHvqjlcWAAAA2M0k5jwAAAEvHRmnKAAAA99UcriwAAAGxmknMeAAAAl46M05QAAAHvqjlcWAAAA2M0k5jwAAAEvHRmnKAAAA99UcriwAAAGxmknMeAAAAl46M05QAAAHvqjlcWAAAA2M0k5jwAAAEvHRmnKAAAA99UcriwAAAGxmknMeAAAAl46M05QAAAHvqjlcWAAAA2M0k5jwAAAEvHRmnKAAAA99UcriwAAAGxmknMeAAAAl46M05QAAAHvqjlcWAAAA2M0k5jwAAAEvHRmnKAAAA6DXKu3gAAAAAAmlM1T+xwpVSLuWr1YOJ0Z4mklWwYAAAAADpaVVPcAAAAAAJpTNU/scKVUi7lq9WDidGeJpJVsGAAAAAA6WlVT3AAAAAACaUzVP7HClVIu5avVg4nRniaSVbBgAAAAAOlpVU9wAAAAAAmlM1T+xwpVSLuWr1YOJ0Z4mklWwYAAAAADpaVVPcAAAAAAJpTNU/scKVUi7lq9WDidGeJpJVsGAAAAAA6WlVT3AAAAAACaUzVP7HClVIu5avVg4nRniaSVbBgAAAAAOlpVU9wAAAAAAmlM1T+xwpVSLuWr1YOJ0Z4mklWwYAAAAADpaVVPcAAAAAAJpTNU/scKVUi7lq9WDidGeJpJVsGAAAAAA6WlVT3AAAAAACaUzVP7HClVIu5avVg4nRniaSVbBgAAAAAOlpVU9wAAAAAAmlM1T+xwpVSLuWr1YOJ0Z4mklWwYAAAAAD/9k=";

class FixtureAssetResolver implements AssetResolver {
  readonly resolvedKeys: string[] = [];

  async resolve(image: ContentImage): Promise<ImageResolution> {
    if (image.source.kind !== "remote") {
      return { status: "unavailable", reason: "the bundled asset is not registered" };
    }

    const host = new URL(image.source.url).hostname;
    if (host !== "picsum.photos" && host !== "covers.openlibrary.org") {
      return { status: "unavailable", reason: `host '${host}' is not allowlisted` };
    }

    this.resolvedKeys.push(imageSourceKey(image));
    return {
      status: "resolved",
      image: {
        dataUri: FIXTURE_JPEG_DATA_URI,
        width: host === "covers.openlibrary.org" ? 120 : 160,
        height: host === "covers.openlibrary.org" ? 180 : 120,
        mimeType: "image/jpeg",
      },
    };
  }
}

function fixtureEngine(): { engine: RenderEngine; resolver: FixtureAssetResolver } {
  const resolver = new FixtureAssetResolver();
  return { engine: new RenderEngine({ assetResolver: resolver }), resolver };
}

function pngHeader(payload: Buffer) {
  return {
    width: payload.readUInt32BE(16),
    height: payload.readUInt32BE(20),
    bitDepth: payload[24],
    colorType: payload[25],
  };
}

function objectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(objectKeys);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...objectKeys(child)]);
}

function documentImages(document: ContentDocument): ContentImage[] {
  const page = document.page as unknown as {
    kind: string;
    image?: ContentImage;
    items?: Array<{ image?: ContentImage }>;
    heroImage?: ContentImage;
    content?: Array<{ type: string; image?: ContentImage }>;
  };
  if (page.kind === "list") {
    return page.items?.flatMap((item) => item.image ? [item.image] : []) ?? [];
  }
  if (page.kind === "image") return page.image ? [page.image] : [];
  return [
    ...(page.heroImage ? [page.heroImage] : []),
    ...(page.content?.flatMap((block) =>
      block.type === "image" && block.image ? [block.image] : []
    ) ?? []),
  ];
}

function svgImageXCoordinates(svg: string): number[] {
  return [...svg.matchAll(/<image\b[^>]*\bx="([\d.]+)"/gu)].map((match) => Number(match[1]));
}

function firstSvgImageAttributes(svg: string): Record<string, string> {
  const tag = svg.match(/<image\b[^>]*>/u)?.[0];
  if (!tag) throw new Error("Expected the layout SVG to contain an image element");
  return Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)="([^"]*)"/gu)].map((match) => [match[1], match[2]]),
  );
}

const FULL_SCREEN_IMAGE_INPUT = {
  schemaVersion: "inkos.content/v2",
  id: "photo/full-screen-mountain",
  revision: 1,
  locale: "zh-CN",
  page: {
    kind: "image",
    layout: "contain",
    image: {
      source: { kind: "remote", url: "https://picsum.photos/id/1015/800/1100" },
      alt: "山谷与湖泊的竖幅照片",
    },
    link: {
      label: "查看图片详情",
      target: { kind: "document", documentId: "photo/mountain-detail" },
    },
  },
} as const;

const detailDocument = contentDocumentSchema.parse(DETAIL_SAMPLE_CONTENT);
const listDocument = contentDocumentSchema.parse(LIST_SAMPLE_CONTENT);
const galleryDocument = contentDocumentSchema.parse(GALLERY_SAMPLE_CONTENT);
const imageDetailDocument = contentDocumentSchema.parse(IMAGE_DETAIL_SAMPLE_CONTENT);
const ebookHomeDocument = contentDocumentSchema.parse(EBOOK_HOME_SAMPLE_CONTENT);

const imageRichDocuments = [
  {
    label: "gallery",
    document: galleryDocument,
    expectedImageCount: 8,
  },
  {
    label: "image detail",
    document: imageDetailDocument,
    expectedImageCount: 3,
  },
  {
    label: "ebook home",
    document: ebookHomeDocument,
    expectedImageCount: 6,
  },
] as const;

const deviceCases = [
  {
    label: "PaperS3",
    profileId: "m5stack-paper-s3-portrait",
    logicalSize: { width: 540, height: 960 },
    bitDepth: 4,
    pixelFormat: "gray4",
  },
  {
    label: "Xiaozhi Card Kit",
    profileId: "m5stack-xiaozhi-card",
    logicalSize: { width: 176, height: 264 },
    bitDepth: 1,
    pixelFormat: "mono1",
  },
  {
    label: "M5Stack PaperColor",
    profileId: "m5stack-paper-color",
    logicalSize: { width: 400, height: 600 },
    bitDepth: 4,
    pixelFormat: "spectra6",
  },
] as const;

interface RenderCase {
  label: string;
  document: ContentDocument;
  contentType: "detail" | "list";
  profileId: string;
  logicalSize: { width: number; height: number };
  nativeSize: { width: number; height: number };
  bitDepth: number;
  pixelFormat: "mono1" | "gray4";
  rotation: 0 | 90 | 180 | 270;
}

const renderCases: RenderCase[] = [
  {
    label: "detail on PaperS3",
    document: detailDocument,
    contentType: "detail",
    profileId: "m5stack-paper-s3-portrait",
    logicalSize: { width: 540, height: 960 },
    nativeSize: { width: 960, height: 540 },
    bitDepth: 4,
    pixelFormat: "gray4",
    rotation: 90,
  },
  {
    label: "list on PaperS3",
    document: listDocument,
    contentType: "list",
    profileId: "m5stack-paper-s3-portrait",
    logicalSize: { width: 540, height: 960 },
    nativeSize: { width: 960, height: 540 },
    bitDepth: 4,
    pixelFormat: "gray4",
    rotation: 90,
  },
  {
    label: "detail on Xiaozhi Card Kit",
    document: detailDocument,
    contentType: "detail",
    profileId: "m5stack-xiaozhi-card",
    logicalSize: { width: 176, height: 264 },
    nativeSize: { width: 176, height: 264 },
    bitDepth: 1,
    pixelFormat: "mono1",
    rotation: 0,
  },
  {
    label: "list on Xiaozhi Card Kit",
    document: listDocument,
    contentType: "list",
    profileId: "m5stack-xiaozhi-card",
    logicalSize: { width: 176, height: 264 },
    nativeSize: { width: 176, height: 264 },
    bitDepth: 1,
    pixelFormat: "mono1",
    rotation: 0,
  },
];

describe("semantic content contract", () => {
  it("exports a detail sample as the default sample", () => {
    expect(SAMPLE_CONTENT).toBe(DETAIL_SAMPLE_CONTENT);
    expect(detailDocument.page.kind).toBe("detail");
    expect(listDocument.page.kind).toBe("list");
    expect(galleryDocument.page.kind).toBe("list");
    expect(imageDetailDocument.page.kind).toBe("detail");
    expect(ebookHomeDocument.page.kind).toBe("list");
  });

  it.each([
    ["detail", DETAIL_SAMPLE_CONTENT],
    ["list", LIST_SAMPLE_CONTENT],
    ["gallery", GALLERY_SAMPLE_CONTENT],
    ["image detail", IMAGE_DETAIL_SAMPLE_CONTENT],
    ["ebook home", EBOOK_HOME_SAMPLE_CONTENT],
  ])("keeps the %s sample free of presentation and device keys", (_label, sample) => {
    const forbiddenKeys = new Set([
      "designViewport",
      "frame",
      "x",
      "y",
      "width",
      "height",
      "fontSize",
      "fontWeight",
      "lineHeight",
      "color",
      "background",
      "deviceType",
      "profileId",
      "screen",
      "style",
      "variant",
      "columns",
      "aspectRatio",
      "objectFit",
      "crop",
      "renderStrategy",
      "orientation",
    ]);

    expect(objectKeys(sample).filter((key) => forbiddenKeys.has(key))).toEqual([]);
  });

  it("uses semantic page layouts without exposing layout measurements", () => {
    expect(galleryDocument.page).toMatchObject({ kind: "list", layout: "masonry" });
    expect(ebookHomeDocument.page).toMatchObject({ kind: "list", layout: "bookshelf" });
    expect(listDocument.page).toMatchObject({ kind: "list", layout: "feed" });
    expect(imageDetailDocument.page).toMatchObject({ kind: "detail", layout: "image-story" });
    expect(detailDocument.page).toMatchObject({ kind: "detail", layout: "article" });
  });

  it("renders PaperS3 feed navigation below the title without dropping feed items", () => {
    const menuLabels = ["首页", "问答", "树洞", "女装", "随手拍", "无聊图", "鱼塘", "热榜", "大吐槽"];
    const document = contentDocumentSchema.parse({
      schemaVersion: "inkos.content/v2",
      id: "source/jandan-feed",
      revision: 1,
      locale: "zh-CN",
      page: {
        kind: "list",
        layout: "feed",
        title: "新鲜事",
        navigation: menuLabels.map((label, index) => ({
          label,
          target: index === 0
            ? { kind: "document", documentId: "source/jandan-feed" }
            : { kind: "url", url: `https://jandan.net/menu/${index}` },
        })),
        items: Array.from({ length: 48 }, (_, index) => ({
          id: `story-${index + 1}`,
          title: `第 ${index + 1} 条新鲜事`,
          summary: `这是第 ${index + 1} 条内容摘要。`,
          link: {
            label: "阅读详情",
            target: { kind: "url", url: `https://jandan.net/p/${index + 1}` },
          },
        })),
        sourcePageInfo: { totalItems: 48 },
      },
    });

    expect(JSON.stringify(document.page)).not.toMatch(/"(?:x|y|width|height)"\s*:/u);
    const layout = layoutSemanticDocument(
      document,
      getScreenProfile("m5stack-paper-s3-portrait"),
    );
    const interactions = layout.pages.flatMap((page) => page.interactions);
    const menuInteractions = interactions.filter((interaction) =>
      /^page\.navigation\[\d+\]$/u.test(interaction.contentPath)
    );
    const feedInteractions = interactions.filter((interaction) =>
      /^page\.items\[\d+\]\.link$/u.test(interaction.contentPath)
    );

    expect(layout.pages.length).toBeGreaterThan(1);
    expect(layout.pages[0].svg.indexOf("新鲜事")).toBeLessThan(
      layout.pages[0].svg.indexOf("首页"),
    );
    expect(menuInteractions).toHaveLength(9);
    expect(menuInteractions.map((interaction) => interaction.label)).toEqual(menuLabels);
    expect(menuInteractions[0].action).toEqual({
      type: "open-document",
      documentId: "source/jandan-feed",
    });
    expect(menuInteractions[1].action).toEqual({
      type: "open-url",
      url: "https://jandan.net/menu/1",
    });
    expect(feedInteractions).toHaveLength(48);
    expect(new Set(layout.pages.flatMap((page) => page.contentPaths)).size).toBeGreaterThanOrEqual(58);
  });

  it("renders detail navigation as bordered actions before RSS body text", () => {
    const document = contentDocumentSchema.parse({
      schemaVersion: "inkos.content/v2",
      id: "source/rss-detail",
      revision: 1,
      locale: "zh-CN",
      page: {
        kind: "detail",
        layout: "article",
        title: "RSS 文章",
        eyebrow: "RSS",
        navigation: [
          {
            label: "查看原文",
            target: { kind: "url", url: "https://example.com/posts/42" },
          },
          {
            label: "下一篇",
            target: { kind: "url", url: "https://example.com/posts/43" },
          },
          {
            label: "栏目：效率工具",
            target: { kind: "url", url: "https://example.com/categories/tools" },
          },
        ],
        content: [{ type: "paragraph", text: "这里是文章正文。" }],
      },
    });
    const layout = layoutSemanticDocument(
      document,
      getScreenProfile("m5stack-paper-s3-portrait"),
    );
    const navigationInteractions = layout.pages.flatMap((page) => page.interactions)
      .filter((interaction) => interaction.contentPath.startsWith("page.navigation["));

    expect(navigationInteractions.map((interaction) => interaction.label)).toEqual([
      "查看原文",
      "下一篇",
      "栏目：效率工具",
    ]);
    expect(navigationInteractions[0].action).toEqual({
      type: "open-url",
      url: "https://example.com/posts/42",
    });
    expect(layout.pages[0].svg.indexOf("查看原文")).toBeLessThan(
      layout.pages[0].svg.indexOf("这里是文章正文"),
    );
    expect(layout.pages[0].svg).toContain("<rect");
  });

  it("paginates an oversized PaperS3 navigation before continuing with its feed", () => {
    const document = contentDocumentSchema.parse({
      schemaVersion: "inkos.content/v2",
      id: "source/large-menu",
      revision: 1,
      locale: "zh-CN",
      page: {
        kind: "list",
        layout: "feed",
        title: "入口很多的网站",
        navigation: Array.from({ length: 32 }, (_, index) => ({
          label: `导航入口 ${index + 1}：这是一个需要截断的较长栏目名称`,
          target: { kind: "url", url: `https://example.com/menu/${index + 1}` },
        })),
        items: [{
          id: "feed-item",
          title: "正文仍然保留",
          link: {
            label: "阅读正文",
            target: { kind: "url", url: "https://example.com/article" },
          },
        }],
      },
    });
    const layout = layoutSemanticDocument(
      document,
      getScreenProfile("m5stack-paper-s3-portrait"),
    );
    const navigationPages = layout.pages.filter((page) =>
      page.interactions.some((interaction) => interaction.contentPath.startsWith("page.navigation["))
    );
    const interactions = layout.pages.flatMap((page) => page.interactions);

    expect(navigationPages.length).toBeGreaterThan(1);
    expect(interactions.filter((interaction) =>
      interaction.contentPath.startsWith("page.navigation[")
    )).toHaveLength(32);
    expect(interactions).toContainEqual(expect.objectContaining({
      contentPath: "page.items[0].link",
      label: "阅读正文",
    }));
  });

  it.each(["feed", "masonry", "bookshelf"] as const)(
    "accepts the strict %s list layout",
    (layout) => {
      expect(contentDocumentSchema.safeParse({
        ...LIST_SAMPLE_CONTENT,
        page: { ...LIST_SAMPLE_CONTENT.page, layout },
      }).success).toBe(true);
    },
  );

  it.each(["article", "image-story"] as const)(
    "accepts the strict %s detail layout",
    (layout) => {
      expect(contentDocumentSchema.safeParse({
        ...DETAIL_SAMPLE_CONTENT,
        page: { ...DETAIL_SAMPLE_CONTENT.page, layout },
      }).success).toBe(true);
    },
  );

  it("rejects unknown and cross-page layouts", () => {
    expect(contentDocumentSchema.safeParse({
      ...LIST_SAMPLE_CONTENT,
      page: { ...LIST_SAMPLE_CONTENT.page, layout: "dashboard" },
    }).success).toBe(false);
    expect(contentDocumentSchema.safeParse({
      ...IMAGE_DETAIL_SAMPLE_CONTENT,
      page: { ...IMAGE_DETAIL_SAMPLE_CONTENT.page, layout: "masonry" },
    }).success).toBe(false);
    expect(contentDocumentSchema.safeParse({
      ...GALLERY_SAMPLE_CONTENT,
      page: { ...GALLERY_SAMPLE_CONTENT.page, layout: "image-story" },
    }).success).toBe(false);
  });

  it("rejects PaperS3 gray4 tuning on a non-gray4 profile", async () => {
    const { engine } = fixtureEngine();
    await expect(engine.render({
      profileId: "m5stack-xiaozhi-card",
      document: contentDocumentSchema.parse(DETAIL_SAMPLE_CONTENT),
      displayMeta: { outputTuning: { contrast: 1.2 } },
    })).rejects.toThrow("does not support PaperS3 gray4 output tuning");
  });

  it.each(["contain", "cover"] as const)(
    "accepts the strict %s full-screen image layout",
    (layout) => {
      const result = contentDocumentSchema.safeParse({
        ...FULL_SCREEN_IMAGE_INPUT,
        page: { ...FULL_SCREEN_IMAGE_INPUT.page, layout },
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.page).toMatchObject({
        kind: "image",
        layout,
        link: FULL_SCREEN_IMAGE_INPUT.page.link,
      });
    },
  );

  it("keeps a full-screen image page semantic and strict", () => {
    expect(contentDocumentSchema.safeParse({
      ...FULL_SCREEN_IMAGE_INPUT,
      page: {
        kind: "image",
        layout: "contain",
        image: FULL_SCREEN_IMAGE_INPUT.page.image,
      },
    }).success).toBe(true);
    expect(contentDocumentSchema.safeParse({
      ...FULL_SCREEN_IMAGE_INPUT,
      page: { ...FULL_SCREEN_IMAGE_INPUT.page, layout: "stretch" },
    }).success).toBe(false);
    expect(contentDocumentSchema.safeParse({
      ...FULL_SCREEN_IMAGE_INPUT,
      page: { ...FULL_SCREEN_IMAGE_INPUT.page, x: 0 },
    }).success).toBe(false);
    expect(contentDocumentSchema.safeParse({
      ...FULL_SCREEN_IMAGE_INPUT,
      page: { ...FULL_SCREEN_IMAGE_INPUT.page, title: "全屏图片标题" },
    }).success).toBe(false);
    expect(contentDocumentSchema.safeParse({
      ...FULL_SCREEN_IMAGE_INPUT,
      page: { ...FULL_SCREEN_IMAGE_INPUT.page, caption: "全屏图片说明" },
    }).success).toBe(false);
    expect(contentDocumentSchema.safeParse({
      ...FULL_SCREEN_IMAGE_INPUT,
      page: {
        ...FULL_SCREEN_IMAGE_INPUT.page,
        image: { ...FULL_SCREEN_IMAGE_INPUT.page.image, caption: "嵌套图片说明" },
      },
    }).success).toBe(false);
    expect(contentDocumentSchema.safeParse({
      ...FULL_SCREEN_IMAGE_INPUT,
      page: { kind: "image", layout: "contain" },
    }).success).toBe(false);
    expect(contentDocumentSchema.safeParse({
      ...FULL_SCREEN_IMAGE_INPUT,
      page: {
        ...FULL_SCREEN_IMAGE_INPUT.page,
        link: { ...FULL_SCREEN_IMAGE_INPUT.page.link, bounds: { x: 0, y: 0 } },
      },
    }).success).toBe(false);
    expect(contentDocumentSchema.safeParse({
      ...FULL_SCREEN_IMAGE_INPUT,
      page: {
        ...FULL_SCREEN_IMAGE_INPUT.page,
        link: { ...FULL_SCREEN_IMAGE_INPUT.page.link, description: "不会显示的链接说明" },
      },
    }).success).toBe(false);
  });

  it("defaults request display metadata without putting it in content", () => {
    const implicit = renderRequestSchema.parse({
      profileId: "m5stack-xiaozhi-card",
      document: DETAIL_SAMPLE_CONTENT,
    });
    const empty = renderRequestSchema.parse({
      profileId: "m5stack-xiaozhi-card",
      document: DETAIL_SAMPLE_CONTENT,
      displayMeta: {},
    });

    expect(implicit).toHaveProperty("displayMeta", {
      invert: false,
      fontLevel: 0,
      orientation: "portrait",
    });
    expect(empty).toHaveProperty("displayMeta", {
      invert: false,
      fontLevel: 0,
      orientation: "portrait",
    });
    expect(contentDocumentSchema.safeParse({
      ...DETAIL_SAMPLE_CONTENT,
      displayMeta: { invert: true, fontLevel: 1 },
    }).success).toBe(false);
  });

  it.each([
    { displayMeta: { invert: "yes", fontLevel: 0 } },
    { displayMeta: { invert: false, fontLevel: -3 } },
    { displayMeta: { invert: false, fontLevel: 3 } },
    { displayMeta: { invert: false, fontLevel: 0.5 } },
    { displayMeta: { invert: false, fontLevel: 0, contrast: 2 } },
  ])("strictly rejects invalid display metadata: $displayMeta", ({ displayMeta }) => {
    expect(renderRequestSchema.safeParse({
      profileId: "m5stack-xiaozhi-card",
      document: DETAIL_SAMPLE_CONTENT,
      displayMeta,
    }).success).toBe(false);
  });

  it.each([-2, -1, 0, 1, 2] as const)("accepts font level %s", (fontLevel) => {
    expect(renderRequestSchema.safeParse({
      profileId: "m5stack-xiaozhi-card",
      document: DETAIL_SAMPLE_CONTENT,
      displayMeta: { invert: false, fontLevel },
    }).success).toBe(true);
  });

  it("accepts bounded PaperS3 output tuning inside display metadata", () => {
    const parsed = renderRequestSchema.parse({
      profileId: "m5stack-paper-s3-portrait",
      document: DETAIL_SAMPLE_CONTENT,
      displayMeta: {
        outputTuning: {
          gamma: 1.05,
          contrast: 1.25,
          blackPoint: 10,
          whitePoint: 244,
          sharpen: 0.5,
          photoContrast: 1.3,
          quantization: "photo-ordered-16",
          supersampling: 2,
        },
      },
    });

    expect(parsed.displayMeta).toMatchObject({
      orientation: "portrait",
      invert: false,
      fontLevel: 0,
      outputTuning: { gamma: 1.05, quantization: "photo-ordered-16" },
    });
  });

  it.each([
    { gamma: 0.1 },
    { contrast: 3 },
    { blackPoint: 97 },
    { whitePoint: 120 },
    { blackPoint: 96, whitePoint: 159 },
    { sharpen: -1 },
    { quantization: "adaptive" },
    { supersampling: 4 },
  ])("rejects unsafe PaperS3 output tuning: $outputTuning", (outputTuning) => {
    expect(renderRequestSchema.safeParse({
      profileId: "m5stack-paper-s3-portrait",
      document: DETAIL_SAMPLE_CONTENT,
      displayMeta: { outputTuning },
    }).success).toBe(false);
  });

  it("uses allowlisted real remote image sources in image-heavy samples", () => {
    const expectedHosts = new Map([
      [galleryDocument.id, "picsum.photos"],
      [imageDetailDocument.id, "picsum.photos"],
      [ebookHomeDocument.id, "covers.openlibrary.org"],
    ]);

    for (const { document, expectedImageCount } of imageRichDocuments) {
      const images = documentImages(document);
      expect(images).toHaveLength(expectedImageCount);
      for (const image of images) {
        expect(image.source.kind).toBe("remote");
        if (image.source.kind !== "remote") continue;
        const url = new URL(image.source.url);
        expect(url.protocol).toBe("https:");
        expect(url.hostname).toBe(expectedHosts.get(document.id));
      }
    }
  });

  it.each([
    {
      field: "designViewport",
      value: {
        ...DETAIL_SAMPLE_CONTENT,
        designViewport: { width: 540, height: 960 },
      },
    },
    {
      field: "frame",
      value: {
        ...DETAIL_SAMPLE_CONTENT,
        page: { ...DETAIL_SAMPLE_CONTENT.page, frame: { x: 0, y: 0, width: 100, height: 100 } },
      },
    },
    {
      field: "fontSize",
      value: {
        ...DETAIL_SAMPLE_CONTENT,
        page: {
          ...DETAIL_SAMPLE_CONTENT.page,
          content: [
            { ...DETAIL_SAMPLE_CONTENT.page.content[0], fontSize: 18 },
            ...DETAIL_SAMPLE_CONTENT.page.content.slice(1),
          ],
        },
      },
    },
    {
      field: "color",
      value: {
        ...DETAIL_SAMPLE_CONTENT,
        page: { ...DETAIL_SAMPLE_CONTENT.page, color: "#111111" },
      },
    },
  ])("strictly rejects the presentation field $field", ({ value }) => {
    expect(contentDocumentSchema.safeParse(value).success).toBe(false);
  });

  it("requires every list item to have a title or an image", () => {
    expect(listItemSchema.safeParse({ id: "empty-item" }).success).toBe(false);
    expect(listItemSchema.safeParse({ id: "title-item", title: "只有标题也有效" }).success).toBe(
      true,
    );
    expect(
      listItemSchema.safeParse({
        id: "image-item",
        image: {
          source: { kind: "asset", assetId: "list/image-only-item" },
          alt: "没有标题的图片条目",
        },
      }).success,
    ).toBe(true);
  });
});

describe("image-heavy semantic samples", () => {
  const imageRenderCases = imageRichDocuments.flatMap((sample) =>
    deviceCases.map((device) => ({
      sampleLabel: sample.label,
      document: sample.document,
      expectedImageCount: sample.expectedImageCount,
      deviceLabel: device.label,
      profileId: device.profileId,
      logicalSize: device.logicalSize,
      bitDepth: device.bitDepth,
    })),
  );

  it.each(imageRenderCases)(
    "renders allowlisted remote images for $sampleLabel on $deviceLabel",
    async ({ document, expectedImageCount, profileId, logicalSize, bitDepth }) => {
      expect(documentImages(document)).toHaveLength(expectedImageCount);
      const { engine, resolver } = fixtureEngine();
      const frame = await engine.render({ profileId, document });
      const stats = await sharp(frame.payload).stats();

      expect(new Set(resolver.resolvedKeys).size).toBe(expectedImageCount);
      expect(pngHeader(frame.payload)).toMatchObject({ ...logicalSize, bitDepth, colorType: 3 });
      expect(stats.entropy).toBeGreaterThan(0.1);
      expect(frame.warnings.filter((warning) => /allow|block|reject|resolve|placeholder/iu.test(warning))).toEqual(
        [],
      );
    },
  );

  it.each(imageRichDocuments)(
    "renders the same $label document for every screen with screen-native pagination and pixels",
    async ({ document }) => {
      const serializedBeforeRender = JSON.stringify(document);
      const { engine } = fixtureEngine();
      const frames = await Promise.all(deviceCases.map(async (device) => {
        const frame = await engine.render({
          profileId: device.profileId,
          document,
        });
        return { device, frame };
      }));

      for (const { device, frame } of frames) {
        expect(pngHeader(frame.payload)).toMatchObject({
          ...device.logicalSize,
          bitDepth: device.bitDepth,
          colorType: 3,
        });
        expect(frame.manifest).toMatchObject({
          documentId: document.id,
          documentRevision: document.revision,
          contentType: document.page.kind,
          screenProfileId: device.profileId,
          pixelFormat: device.pixelFormat,
          pagination: { pageIndex: 0 },
        });
        expect(frame.manifest.pagination.pageCount).toBeGreaterThan(0);
        expect(frame.warnings.filter((warning) => /AssetResolver|placeholder/iu.test(warning))).toEqual(
          [],
        );
      }

      const paperFrame = frames.find(({ device }) => device.label === "PaperS3")?.frame;
      const cardFrame = frames.find(({ device }) => device.label === "Xiaozhi Card Kit")?.frame;
      expect(paperFrame).toBeDefined();
      expect(cardFrame).toBeDefined();
      expect(cardFrame!.manifest.pagination.pageCount).toBeGreaterThanOrEqual(
        paperFrame!.manifest.pagination.pageCount,
      );
      expect(JSON.stringify(document)).toBe(serializedBeforeRender);
    },
  );

  it("quantizes PaperColor output to the fixed Spectra 6 palette", async () => {
    const allowedColors = new Set([
      "000000",
      "ffffff",
      "ff0000",
      "ffff00",
      "0000ff",
      "00ff00",
    ]);
    const { engine } = fixtureEngine();
    const frame = await engine.render({
      profileId: "m5stack-paper-color",
      document: galleryDocument,
    });
    const { data, info } = await sharp(frame.payload)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const colors = new Set<string>();

    expect(info.channels).toBe(3);
    for (let offset = 0; offset < data.length; offset += info.channels) {
      colors.add(data.subarray(offset, offset + 3).toString("hex"));
    }

    expect(colors.size).toBeGreaterThan(2);
    expect(colors.size).toBeLessThanOrEqual(6);
    expect([...colors].filter((color) => !allowedColors.has(color))).toEqual([]);
    expect(frame.manifest).toMatchObject({
      screenProfileId: "m5stack-paper-color",
      logicalSize: { width: 400, height: 600 },
      pixelFormat: "spectra6",
      layoutStrategy: "paper-color-semantic-v1",
      rasterStrategy: "eink-spectra6-photo-dither-png-v2",
    });
  });

  it.each([
    ["gallery", galleryDocument, "feed"],
    ["ebook home", ebookHomeDocument, "feed"],
    ["image detail", imageDetailDocument, "article"],
  ] as const)("lets the semantic layout intent change the %s composition", async (
    _label,
    document,
    fallbackLayout,
  ) => {
    const fallbackDocument = contentDocumentSchema.parse({
      ...document,
      page: { ...document.page, layout: fallbackLayout },
    });
    const { engine } = fixtureEngine();
    const selected = await engine.render({
      profileId: "m5stack-paper-s3-portrait",
      document,
    });
    const fallback = await engine.render({
      profileId: "m5stack-paper-s3-portrait",
      document: fallbackDocument,
    });

    expect(selected.manifest.sha256).not.toBe(fallback.manifest.sha256);
  });

  it("adapts masonry column density to wide and compact screens", async () => {
    const resolver = new FixtureAssetResolver();
    const resolvedImages = await resolveDocumentImages(galleryDocument, resolver);
    const wideProfiles = ["m5stack-paper-s3-portrait", "m5stack-paper-color"];

    for (const profileId of wideProfiles) {
      const layout = await layoutSemanticDocument(
        galleryDocument,
        getScreenProfile(profileId),
        { resolvedImages },
      );
      const xCoordinates = svgImageXCoordinates(layout.pages.map((page) => page.svg).join("\n"));
      expect(new Set(xCoordinates).size).toBeGreaterThan(1);
    }

    const compact = await layoutSemanticDocument(
      galleryDocument,
      getScreenProfile("m5stack-xiaozhi-card"),
      { resolvedImages },
    );
    const compactXCoordinates = svgImageXCoordinates(
      compact.pages.map((page) => page.svg).join("\n"),
    );
    expect(new Set(compactXCoordinates).size).toBeGreaterThanOrEqual(1);
    expect(new Set(compactXCoordinates).size).toBeLessThanOrEqual(2);
  });

  it("composes the ebook home as a multi-column bookshelf on PaperS3", async () => {
    const resolver = new FixtureAssetResolver();
    const resolvedImages = await resolveDocumentImages(ebookHomeDocument, resolver);
    const layout = await layoutSemanticDocument(
      ebookHomeDocument,
      getScreenProfile("m5stack-paper-s3-portrait"),
      { resolvedImages },
    );
    const xCoordinates = svgImageXCoordinates(layout.pages.map((page) => page.svg).join("\n"));

    expect(new Set(xCoordinates).size).toBeGreaterThan(1);
  });

  it("keeps unused Xiaozhi canvas white after 1-bit palette encoding", async () => {
    const { engine } = fixtureEngine();
    const frame = await engine.render({
      profileId: "m5stack-xiaozhi-card",
      document: ebookHomeDocument,
    });
    const { data, info } = await sharp(frame.payload)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const offset = (230 * info.width + 100) * info.channels;

    expect([...data.subarray(offset, offset + 3)]).toEqual([255, 255, 255]);
  });

  it.each([
    ["gallery", galleryDocument],
    ["ebook home", ebookHomeDocument],
  ] as const)("preserves every %s item exactly once on every screen", async (_label, document) => {
    expect(document.page.kind).toBe("list");
    if (document.page.kind !== "list") throw new Error("Expected a list sample");
    const expectedPaths = document.page.items.map((_item, index) => `page.items[${index}]`);

    for (const device of deviceCases) {
      const layout = await layoutSemanticDocument(document, getScreenProfile(device.profileId));
      const itemPaths = layout.pages
        .flatMap((page) => page.contentPaths)
        .filter((path) => /^page\.items\[\d+\]$/u.test(path));

      expect(itemPaths).toEqual(expectedPaths);
      expect(new Set(itemPaths).size).toBe(expectedPaths.length);
    }
  });

  it("preserves the hero and every inline image in the image detail layout", async () => {
    expect(imageDetailDocument.page.kind).toBe("detail");
    if (imageDetailDocument.page.kind !== "detail") throw new Error("Expected a detail sample");
    const expectedPaths = [
      ...(imageDetailDocument.page.heroImage ? ["page.heroImage"] : []),
      ...imageDetailDocument.page.content.flatMap((block, index) =>
        block.type === "image" ? [`page.content[${index}].image`] : []),
    ];

    for (const device of deviceCases) {
      const layout = await layoutSemanticDocument(
        imageDetailDocument,
        getScreenProfile(device.profileId),
      );
      const renderedPaths = new Set(layout.pages.flatMap((page) => page.contentPaths));
      expect(expectedPaths.every((path) => renderedPaths.has(path))).toBe(true);
    }
  });

  it("renders a disallowed remote image as a placeholder with an explicit warning", async () => {
    const disallowedUrl = "https://example.com/not-allowlisted/image.jpg";
    const input = {
      ...IMAGE_DETAIL_SAMPLE_CONTENT,
      page: {
        ...IMAGE_DETAIL_SAMPLE_CONTENT.page,
        heroImage: {
          ...IMAGE_DETAIL_SAMPLE_CONTENT.page.heroImage,
          source: { kind: "remote", url: disallowedUrl },
        },
      },
    } as const;
    const document = contentDocumentSchema.parse(input);

    for (const device of deviceCases) {
      const { engine } = fixtureEngine();
      const frame = await engine.render({
        profileId: device.profileId,
        document,
      });
      expect(frame.warnings.some((warning) =>
        warning.includes("page.heroImage") &&
        warning.includes("example.com") &&
        /allow|block|reject|resolve|placeholder/iu.test(warning)
      )).toBe(true);
    }
  });
});

describe("request display metadata", () => {
  it("keeps omitted display metadata identical to explicit defaults", async () => {
    const { engine } = fixtureEngine();
    const implicit = await engine.render({
      profileId: "m5stack-xiaozhi-card",
      document: detailDocument,
    });
    const explicit = await engine.render({
      profileId: "m5stack-xiaozhi-card",
      document: detailDocument,
      displayMeta: { invert: false, fontLevel: 0 },
    } as Parameters<RenderEngine["render"]>[0]);

    expect(explicit.payload.equals(implicit.payload)).toBe(true);
    expect(explicit.manifest.sha256).toBe(implicit.manifest.sha256);
    expect(explicit.manifest.pagination).toEqual(implicit.manifest.pagination);
    expect(implicit.manifest).toMatchObject({
      displayMeta: { invert: false, fontLevel: 0 },
    });
  });

  it("uses all five font levels to change layout pixels without changing the document", async () => {
    const serializedDocument = JSON.stringify(detailDocument);
    const { engine } = fixtureEngine();
    const frames = await Promise.all(([-2, -1, 0, 1, 2] as const).map(async (fontLevel) => ({
      fontLevel,
      frame: await engine.render({
        profileId: "m5stack-xiaozhi-card",
        document: detailDocument,
        displayMeta: { invert: false, fontLevel },
      } as Parameters<RenderEngine["render"]>[0]),
    })));

    expect(new Set(frames.map(({ frame }) => frame.manifest.sha256)).size).toBe(5);
    expect(frames[0].frame.manifest.pagination.pageCount).toBeLessThanOrEqual(
      frames[4].frame.manifest.pagination.pageCount,
    );
    for (const { frame, fontLevel } of frames) {
      expect(frame.manifest).toMatchObject({
        documentId: detailDocument.id,
        contentType: "detail",
        screenProfileId: "m5stack-xiaozhi-card",
        logicalSize: { width: 176, height: 264 },
        displayMeta: { invert: false, fontLevel },
      });
    }
    expect(JSON.stringify(detailDocument)).toBe(serializedDocument);
  });

  it.each(deviceCases)("rejects inverse output on $label", async ({ profileId }) => {
    const { engine } = fixtureEngine();
    await expect(engine.render({
      profileId,
      document: imageDetailDocument,
      displayMeta: { invert: true, fontLevel: 0 },
    } as Parameters<RenderEngine["render"]>[0])).rejects.toThrow(
      /invert is no longer supported/u,
    );
  });
});

describe("full-screen image page", () => {
  it.each(["contain", "cover"] as const)(
    "uses an undistorted full-screen %s composition on every device",
    async (imageLayout) => {
      const document = contentDocumentSchema.parse({
        ...FULL_SCREEN_IMAGE_INPUT,
        page: { ...FULL_SCREEN_IMAGE_INPUT.page, layout: imageLayout },
      });
      const resolver = new FixtureAssetResolver();
      const resolvedImages = await resolveDocumentImages(document, resolver);

      for (const device of deviceCases) {
        const layout = await layoutSemanticDocument(
          document,
          getScreenProfile(device.profileId),
          { resolvedImages },
        );
        const attributes = firstSvgImageAttributes(layout.pages[0].svg);

        expect(layout.pages).toHaveLength(1);
        expect(Number(attributes.x)).toBe(0);
        expect(Number(attributes.y)).toBe(0);
        expect(Number(attributes.width)).toBe(device.logicalSize.width);
        expect(Number(attributes.height)).toBe(device.logicalSize.height);
        expect(attributes.preserveAspectRatio).toBe(
          imageLayout === "contain" ? "xMidYMid meet" : "xMidYMid slice",
        );

        // The fixture is 4:3 while all three screens are portrait. `meet` therefore
        // leaves a border; `slice` fills the viewport by cropping the long edge.
        const sourceWidth = 160;
        const sourceHeight = 120;
        const containScale = Math.min(
          device.logicalSize.width / sourceWidth,
          device.logicalSize.height / sourceHeight,
        );
        const coverScale = Math.max(
          device.logicalSize.width / sourceWidth,
          device.logicalSize.height / sourceHeight,
        );
        if (imageLayout === "contain") {
          expect(sourceHeight * containScale).toBeLessThan(device.logicalSize.height);
        } else {
          expect(sourceWidth * coverScale).toBeGreaterThan(device.logicalSize.width);
        }
      }

      expect(new Set(resolver.resolvedKeys)).toEqual(
        new Set([imageSourceKey(documentImages(document)[0])]),
      );
    },
  );

  it.each(deviceCases)(
    "renders a single-page linked image frame and manifest on $label",
    async ({ profileId, logicalSize, bitDepth, pixelFormat }) => {
      const document = contentDocumentSchema.parse(FULL_SCREEN_IMAGE_INPUT);
      const { engine, resolver } = fixtureEngine();
      const frame = await engine.render({ profileId, document });
      const interaction = frame.manifest.interactions.find(
        (candidate) => candidate.contentPath === "page.link",
      );

      expect(new Set(resolver.resolvedKeys)).toEqual(
        new Set([imageSourceKey(documentImages(document)[0])]),
      );
      expect(pngHeader(frame.payload)).toMatchObject({
        ...logicalSize,
        bitDepth,
        colorType: 3,
      });
      expect(frame.manifest).toMatchObject({
        documentId: FULL_SCREEN_IMAGE_INPUT.id,
        documentRevision: FULL_SCREEN_IMAGE_INPUT.revision,
        contentType: "image",
        screenProfileId: profileId,
        pixelFormat,
        displayMeta: { invert: false, fontLevel: 0 },
        pagination: {
          pageIndex: 0,
          pageCount: 1,
          hasPrevious: false,
          hasNext: false,
        },
      });
      expect(interaction).toMatchObject({
        action: { type: "open-document", documentId: "photo/mountain-detail" },
      });
      expect(interaction?.bounds.x).toBeGreaterThanOrEqual(0);
      expect(interaction?.bounds.y).toBeGreaterThanOrEqual(0);
      expect((interaction?.bounds.x ?? 0) + (interaction?.bounds.width ?? 0)).toBeLessThanOrEqual(
        logicalSize.width,
      );
      expect((interaction?.bounds.y ?? 0) + (interaction?.bounds.height ?? 0)).toBeLessThanOrEqual(
        logicalSize.height,
      );
    },
  );

  it.each(deviceCases)(
    "produces different contain and cover pixels on $label without extra pages",
    async ({ profileId }) => {
      const containDocument = contentDocumentSchema.parse(FULL_SCREEN_IMAGE_INPUT);
      const coverDocument = contentDocumentSchema.parse({
        ...FULL_SCREEN_IMAGE_INPUT,
        page: { ...FULL_SCREEN_IMAGE_INPUT.page, layout: "cover" },
      });
      const { engine } = fixtureEngine();
      const contain = await engine.render({ profileId, document: containDocument });
      const cover = await engine.render({ profileId, document: coverDocument });

      expect(contain.manifest.pagination.pageCount).toBe(1);
      expect(cover.manifest.pagination.pageCount).toBe(1);
      expect(contain.manifest.sha256).not.toBe(cover.manifest.sha256);
    },
  );
});

describe("RenderEngine", () => {
  const engine = new RenderEngine();

  it.each(renderCases)("renders $label with device-native output metadata", async (renderCase) => {
    const frame = await engine.render({
      profileId: renderCase.profileId,
      document: renderCase.document,
    });
    const metadata = await sharp(frame.payload).metadata();

    expect(pngHeader(frame.payload)).toEqual({
      ...renderCase.logicalSize,
      bitDepth: renderCase.bitDepth,
      colorType: 3,
    });
    expect(metadata.isPalette).toBe(true);
    expect(metadata.bitsPerSample).toBe(renderCase.bitDepth);
    expect(frame.manifest).toMatchObject({
      schemaVersion: "inkos.frame/v2",
      documentId: renderCase.document.id,
      documentRevision: renderCase.document.revision,
      contentType: renderCase.contentType,
      screenProfileId: renderCase.profileId,
      nativeSize: renderCase.nativeSize,
      logicalSize: renderCase.logicalSize,
      displayRotation: renderCase.rotation,
      pixelFormat: renderCase.pixelFormat,
      layoutStrategy: renderCase.profileId.includes("paper")
        ? "paper-s3-semantic-v1"
        : "xiaozhi-card-semantic-v1",
      rasterStrategy: renderCase.pixelFormat === "gray4"
        ? "eink-gray4-png-v1"
        : "eink-mono1-png-v1",
      codec: "png",
      pagination: {
        pageIndex: 0,
        hasPrevious: false,
      },
    });
    expect(frame.manifest.payloadBytes).toBe(frame.payload.byteLength);
    expect(frame.manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(frame.manifest.crc32).toMatch(/^[a-f0-9]{8}$/);
    expect(frame.manifest.warnings).toEqual(frame.warnings);
  });

  it.each([
    "m5stack-paper-s3-portrait",
    "m5stack-xiaozhi-card",
    "m5stack-paper-color",
  ])("preserves every ordered list item in the %s layout", async (profileId) => {
    const layout = await layoutSemanticDocument(listDocument, getScreenProfile(profileId));
    const itemPaths = layout.pages
      .flatMap((page) => page.contentPaths)
      .filter((path) => /^page\.items\[\d+\]$/u.test(path));

    expect(itemPaths).toEqual(listDocument.page.kind === "list"
      ? listDocument.page.items.map((_item, index) => `page.items[${index}]`)
      : []);
    expect(layout.warnings).toContain(
      "page.items[0].image: image 'asset:reading/semantic-rendering' needs an AssetResolver; rendered as a placeholder.",
    );
  });

  it("turns semantic links into output-only logical hit areas", async () => {
    const frame = await engine.render({
      profileId: "m5stack-xiaozhi-card",
      document: listDocument,
    });
    const interaction = frame.manifest.interactions[0];

    expect(interaction).toMatchObject({
      contentPath: "page.items[0].link",
      action: { type: "open-document", documentId: "field-notes-epaper" },
    });
    expect(interaction.bounds.x).toBeGreaterThanOrEqual(0);
    expect(interaction.bounds.y).toBeGreaterThanOrEqual(0);
    expect(interaction.bounds.x + interaction.bounds.width).toBeLessThanOrEqual(176);
    expect(interaction.bounds.y + interaction.bounds.height).toBeLessThanOrEqual(264);
  });

  it.each([
    ["detail", detailDocument],
    ["list", listDocument],
  ] as const)("paginates %s content and renders a selected page", async (_label, document) => {
    const first = await engine.render({ profileId: "m5stack-xiaozhi-card", document });

    expect(first.manifest.pagination.pageCount).toBeGreaterThan(1);
    expect(first.manifest.pagination.hasNext).toBe(true);

    const second = await engine.render({
      profileId: "m5stack-xiaozhi-card",
      document,
      pageIndex: 1,
    });

    expect(second.manifest.pagination).toMatchObject({
      pageIndex: 1,
      pageCount: first.manifest.pagination.pageCount,
      hasPrevious: true,
    });
    expect(second.manifest.sha256).not.toBe(first.manifest.sha256);
  });

  it("rejects a pageIndex outside the rendered page count", async () => {
    const first = await engine.render({
      profileId: "m5stack-xiaozhi-card",
      document: detailDocument,
    });

    await expect(
      engine.render({
        profileId: "m5stack-xiaozhi-card",
        document: detailDocument,
        pageIndex: first.manifest.pagination.pageCount,
      }),
    ).rejects.toThrow(`outside rendered page count ${first.manifest.pagination.pageCount}`);
  });

  it("renders an aligned partial frame", async () => {
    const frame = await engine.render({
      profileId: "m5stack-xiaozhi-card",
      document: detailDocument,
      region: { x: 0, y: 32, width: 176, height: 64 },
    });

    expect(pngHeader(frame.payload)).toMatchObject({ width: 176, height: 64, bitDepth: 1 });
    expect(frame.manifest.update).toEqual({
      kind: "partial",
      region: { x: 0, y: 32, width: 176, height: 64 },
    });
  });

  it("rejects a partial frame that violates profile alignment", async () => {
    await expect(
      engine.render({
        profileId: "m5stack-xiaozhi-card",
        document: detailDocument,
        region: { x: 1, y: 0, width: 80, height: 64 },
      }),
    ).rejects.toThrow("align to 8x1 pixels");
  });

  it("rejects a partial frame outside the logical screen bounds", async () => {
    await expect(
      engine.render({
        profileId: "m5stack-xiaozhi-card",
        document: detailDocument,
        region: { x: 0, y: 240, width: 176, height: 32 },
      }),
    ).rejects.toThrow("outside 176x264 logical screen bounds");
  });
});
