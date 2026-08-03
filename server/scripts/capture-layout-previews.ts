import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp, { type OverlayOptions } from "sharp";

import {
  imageSourceKey,
  type AssetResolver,
  type ImageResolution,
} from "../lib/rendering/asset-resolver";
import {
  contentDocumentSchema,
  type ContentDocument,
  type ContentImage,
} from "../lib/rendering/contracts";
import { RenderEngine } from "../lib/rendering/engine";
import {
  CARDBOARD_SAMPLE_CONTENT,
  DETAIL_SAMPLE_CONTENT,
  EBOOK_HOME_SAMPLE_CONTENT,
  FULLSCREEN_IMAGE_CONTAIN_SAMPLE_CONTENT,
  FULLSCREEN_IMAGE_COVER_SAMPLE_CONTENT,
  GALLERY_SAMPLE_CONTENT,
  GRID_SAMPLE_CONTENT,
  IMAGE_DETAIL_SAMPLE_CONTENT,
  LIST_SAMPLE_CONTENT,
  POSTCARD_SAMPLE_CONTENT,
  READER_SAMPLE_CONTENT,
  SEMANTIC_LIST_SAMPLE_CONTENT,
} from "../lib/rendering/sample-content";

const OUTPUT_DIRECTORY = fileURLToPath(
  new URL("../../docs/assets/render-layout-previews/", import.meta.url),
);

interface PreviewCase {
  readonly order: number;
  readonly layout: string;
  readonly family: "核心版式" | "兼容版式";
  readonly description: string;
  readonly document: unknown;
}

const PREVIEW_CASES: readonly PreviewCase[] = [
  {
    order: 1,
    layout: "grid",
    family: "核心版式",
    description: "规则网格 / 月历",
    document: GRID_SAMPLE_CONTENT,
  },
  {
    order: 2,
    layout: "reader",
    family: "核心版式",
    description: "无标题沉浸阅读",
    document: READER_SAMPLE_CONTENT,
  },
  {
    order: 3,
    layout: "list",
    family: "核心版式",
    description: "线性菜单 / 时间线",
    document: SEMANTIC_LIST_SAMPLE_CONTENT,
  },
  {
    order: 4,
    layout: "postcard",
    family: "核心版式",
    description: "单张视觉信息卡",
    document: POSTCARD_SAMPLE_CONTENT,
  },
  {
    order: 5,
    layout: "cardboard",
    family: "核心版式",
    description: "多卡片状态看板",
    document: CARDBOARD_SAMPLE_CONTENT,
  },
  {
    order: 6,
    layout: "article",
    family: "兼容版式",
    description: "图文文章详情",
    document: DETAIL_SAMPLE_CONTENT,
  },
  {
    order: 7,
    layout: "image-story",
    family: "兼容版式",
    description: "图片主导的故事",
    document: IMAGE_DETAIL_SAMPLE_CONTENT,
  },
  {
    order: 8,
    layout: "feed",
    family: "兼容版式",
    description: "资讯流列表",
    document: LIST_SAMPLE_CONTENT,
  },
  {
    order: 9,
    layout: "masonry",
    family: "兼容版式",
    description: "瀑布流图库",
    document: GALLERY_SAMPLE_CONTENT,
  },
  {
    order: 10,
    layout: "bookshelf",
    family: "兼容版式",
    description: "电子书架",
    document: EBOOK_HOME_SAMPLE_CONTENT,
  },
  {
    order: 11,
    layout: "contain",
    family: "兼容版式",
    description: "完整适配图片",
    document: FULLSCREEN_IMAGE_CONTAIN_SAMPLE_CONTENT,
  },
  {
    order: 12,
    layout: "cover",
    family: "兼容版式",
    description: "满屏裁剪图片",
    document: FULLSCREEN_IMAGE_COVER_SAMPLE_CONTENT,
  },
] as const;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function imageDimensions(key: string): { width: number; height: number } {
  if (key.includes("covers.openlibrary.org")) return { width: 480, height: 720 };
  if (key.includes("/1025/")) return { width: 900, height: 600 };
  if (key.includes("/1068/")) return { width: 560, height: 820 };
  if (key.includes("/1080/")) return { width: 900, height: 560 };

  const selector = createHash("sha256").update(key).digest()[0] % 4;
  return [
    { width: 900, height: 580 },
    { width: 580, height: 860 },
    { width: 720, height: 720 },
    { width: 960, height: 520 },
  ][selector];
}

function placeholderSvg(key: string, width: number, height: number): string {
  const digest = createHash("sha256").update(key).digest();
  const sky = 180 + (digest[1] % 50);
  const ground = 45 + (digest[2] % 70);
  const middle = Math.round((sky + ground) / 2);
  const horizon = Math.round(height * (0.47 + (digest[3] % 18) / 100));
  const sunX = Math.round(width * (0.2 + (digest[4] % 60) / 100));
  const sunY = Math.round(height * (0.12 + (digest[5] % 23) / 100));
  const sunRadius = Math.round(Math.min(width, height) * (0.06 + (digest[6] % 5) / 100));

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="rgb(${sky},${sky},${sky})"/>
          <stop offset="1" stop-color="rgb(${middle},${middle},${middle})"/>
        </linearGradient>
        <linearGradient id="ground" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="rgb(${ground},${ground},${ground})"/>
          <stop offset="1" stop-color="rgb(${middle},${middle},${middle})"/>
        </linearGradient>
        <pattern id="grain" width="24" height="24" patternUnits="userSpaceOnUse">
          <circle cx="4" cy="7" r="1.5" fill="#fff" opacity=".18"/>
          <circle cx="17" cy="18" r="1" fill="#000" opacity=".14"/>
        </pattern>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#sky)"/>
      <circle cx="${sunX}" cy="${sunY}" r="${sunRadius}" fill="#f4f4f4" opacity=".9"/>
      <path d="M0 ${horizon} L${Math.round(width * 0.22)} ${Math.round(horizon * 0.68)} L${Math.round(width * 0.43)} ${Math.round(horizon * 0.92)} L${Math.round(width * 0.66)} ${Math.round(horizon * 0.58)} L${width} ${Math.round(horizon * 0.9)} L${width} ${height} L0 ${height} Z" fill="rgb(${middle},${middle},${middle})"/>
      <path d="M0 ${Math.round(horizon * 1.08)} Q${Math.round(width * 0.28)} ${Math.round(horizon * 0.88)} ${Math.round(width * 0.52)} ${Math.round(horizon * 1.1)} T${width} ${Math.round(horizon * 1.02)} L${width} ${height} L0 ${height} Z" fill="url(#ground)"/>
      <rect width="${width}" height="${height}" fill="url(#grain)"/>
    </svg>
  `;
}

class PreviewAssetResolver implements AssetResolver {
  private readonly cache = new Map<string, Promise<ImageResolution>>();

  resolve(image: ContentImage): Promise<ImageResolution> {
    const key = imageSourceKey(image);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const pending = this.makeImage(key);
    this.cache.set(key, pending);
    return pending;
  }

  private async makeImage(key: string): Promise<ImageResolution> {
    const { width, height } = imageDimensions(key);
    const png = await sharp(Buffer.from(placeholderSvg(key, width, height)))
      .png({ compressionLevel: 9 })
      .toBuffer();
    return {
      status: "resolved",
      image: {
        dataUri: `data:image/png;base64,${png.toString("base64")}`,
        width,
        height,
        mimeType: "image/png",
      },
    };
  }
}

function fileStem(previewCase: PreviewCase): string {
  return `${String(previewCase.order).padStart(2, "0")}-${previewCase.layout}`;
}

async function renderPreview(
  engine: RenderEngine,
  previewCase: PreviewCase,
): Promise<{
  fileName: string;
  frame: Buffer;
  pageCount: number;
  document: ContentDocument;
}> {
  const document = contentDocumentSchema.parse(previewCase.document);
  const rendered = await engine.render({
    profileId: "m5stack-paper-s3-portrait",
    pageIndex: 0,
    displayMeta: { invert: false, fontLevel: 0, orientation: "portrait" },
    navigationContext: { imageTargets: [] },
    document,
  });
  const fileName = `${fileStem(previewCase)}.png`;
  await writeFile(path.join(OUTPUT_DIRECTORY, fileName), rendered.payload);
  return {
    fileName,
    frame: rendered.payload,
    pageCount: rendered.manifest.pagination.pageCount,
    document,
  };
}

async function makeContactSheet(
  results: readonly Awaited<ReturnType<typeof renderPreview>>[],
): Promise<void> {
  const columns = 3;
  const rows = Math.ceil(results.length / columns);
  const cardWidth = 280;
  const cardHeight = 480;
  const previewWidth = 216;
  const previewHeight = 384;
  const outerPadding = 24;
  const headerHeight = 104;
  const canvasWidth = outerPadding * 2 + columns * cardWidth;
  const canvasHeight = headerHeight + outerPadding + rows * cardHeight;

  const composites: OverlayOptions[] = [];
  for (const [index, result] of results.entries()) {
    const previewCase = PREVIEW_CASES[index];
    const column = index % columns;
    const row = Math.floor(index / columns);
    const left = outerPadding + column * cardWidth + Math.round((cardWidth - previewWidth) / 2);
    const top = headerHeight + row * cardHeight + 66;
    const resized = await sharp(result.frame)
      .resize(previewWidth, previewHeight, { fit: "fill" })
      .png()
      .toBuffer();
    composites.push({ input: resized, left, top });

    const label = Buffer.from(`
      <svg xmlns="http://www.w3.org/2000/svg" width="${cardWidth}" height="62">
        <text x="14" y="23" font-family="Arial, 'Noto Sans CJK SC', sans-serif" font-size="18" font-weight="700" fill="#111">${String(previewCase.order).padStart(2, "0")} · ${escapeXml(previewCase.layout)}</text>
        <text x="14" y="47" font-family="Arial, 'Noto Sans CJK SC', sans-serif" font-size="13" fill="#555">${escapeXml(previewCase.description)} · ${result.pageCount} 页</text>
      </svg>
    `);
    composites.push({
      input: label,
      left: outerPadding + column * cardWidth,
      top: headerHeight + row * cardHeight,
    });
  }

  const header = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${headerHeight}">
      <text x="${outerPadding}" y="42" font-family="Arial, 'Noto Sans CJK SC', sans-serif" font-size="28" font-weight="700" fill="#111">InkOS 服务端渲染版式总览</text>
      <text x="${outerPadding}" y="71" font-family="Arial, 'Noto Sans CJK SC', sans-serif" font-size="14" fill="#555">PaperS3 · 540×960 · 竖屏 · 默认字号 · 第 1 页</text>
      <line x1="${outerPadding}" y1="91" x2="${canvasWidth - outerPadding}" y2="91" stroke="#bbb" stroke-width="1"/>
    </svg>
  `);
  composites.unshift({ input: header, left: 0, top: 0 });

  await sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 3,
      background: "#eceae4",
    },
  })
    .composite(composites)
    .png({ compressionLevel: 9 })
    .toFile(path.join(OUTPUT_DIRECTORY, "layout-overview.png"));
}

function makeReadme(
  results: readonly Awaited<ReturnType<typeof renderPreview>>[],
): string {
  const rows = results.map((result, index) => {
    const previewCase = PREVIEW_CASES[index];
    return `| \`${previewCase.layout}\` | ${previewCase.family} | ${previewCase.description} | ${result.pageCount} | [${result.fileName}](./${result.fileName}) |`;
  });
  return `# InkOS 服务端渲染版式预览

统一使用 \`m5stack-paper-s3-portrait\`、540×960 竖屏、默认字号生成。每张图都是服务端渲染器输出的第一页，图片素材使用确定性的本地灰度占位图，便于离线重复生成和比较排版。

总览：[layout-overview.png](./layout-overview.png)

| layout | 分类 | 用途 | 总页数 | 预览 |
| --- | --- | --- | ---: | --- |
${rows.join("\n")}

重新生成：

\`\`\`bash
cd server
npx tsx scripts/capture-layout-previews.ts
\`\`\`
`;
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  const engine = new RenderEngine({ assetResolver: new PreviewAssetResolver() });
  const results = [];
  for (const previewCase of PREVIEW_CASES) {
    results.push(await renderPreview(engine, previewCase));
  }
  await makeContactSheet(results);
  await writeFile(path.join(OUTPUT_DIRECTORY, "README.md"), makeReadme(results));

  console.log(`Generated ${results.length} layout previews in ${OUTPUT_DIRECTORY}`);
  for (const [index, result] of results.entries()) {
    console.log(`${PREVIEW_CASES[index].layout}: ${result.fileName} (${result.pageCount} pages)`);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
