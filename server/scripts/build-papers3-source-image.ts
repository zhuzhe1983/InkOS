import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import {
  buildInkArchive,
  encodeInkJson,
  readInkArchive,
  sha256Hex,
} from "../lib/ink/archive";
import {
  inkFrameSidecarSchema,
  packagedDocument,
  type InkPackageManifest,
  type InkSourceImage,
} from "../lib/ink/contracts";
import { createInkDisplayVariant } from "../lib/ink/package-builder";
import { uuidV5 } from "../lib/ink/uuid";
import { encodeGray4Png } from "../lib/rendering/gray4-output";

const PAPER_S3_PROFILE_ID = "m5stack-paper-s3-portrait";
const CREATED_AT = "2026-07-24T01:30:00+08:00";
const REVISION = 20_260_725;
const MAX_DEVICE_ARCHIVE_BYTES = 0x440000;
const MAX_SOURCE_IMAGE_BYTES = 2 * 1024 * 1024;
const DNS_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const PACKAGE_ID = uuidV5("inkos:papers3-source-image", DNS_NAMESPACE);
const ENTRY_UUID = uuidV5("document:papers3-source-image", PACKAGE_ID);
const OUTPUT_DIRECTORY = path.resolve(process.cwd(), "..", "output");
const OUTPUT_PATH = path.join(
  OUTPUT_DIRECTORY,
  "papers3-source-image-comparison.ink",
);
const REPORT_PATH = path.join(
  OUTPUT_DIRECTORY,
  "papers3-source-image-comparison.report.json",
);

const GRAY16_REFERENCE_URL =
  "https://quickchart.io/chart?width=540&height=960&devicePixelRatio=1&format=jpg&backgroundColor=white&c=%7Btype%3A%27bar%27%2Cdata%3A%7Blabels%3AArray(16).fill(%27%27)%2Cdatasets%3A%5B%7Bdata%3AArray(16).fill(1)%2CbackgroundColor%3A%5B%27%23000000%27%2C%27%23111111%27%2C%27%23222222%27%2C%27%23333333%27%2C%27%23444444%27%2C%27%23555555%27%2C%27%23666666%27%2C%27%23777777%27%2C%27%23888888%27%2C%27%23999999%27%2C%27%23aaaaaa%27%2C%27%23bbbbbb%27%2C%27%23cccccc%27%2C%27%23dddddd%27%2C%27%23eeeeee%27%2C%27%23ffffff%27%5D%2CborderWidth%3A0%7D%5D%7D%2Coptions%3A%7Blegend%3A%7Bdisplay%3Afalse%7D%2Clayout%3A%7Bpadding%3A0%7D%2Cscales%3A%7BxAxes%3A%5B%7Bdisplay%3Afalse%2CcategoryPercentage%3A1%2CbarPercentage%3A1%7D%5D%2CyAxes%3A%5B%7Bdisplay%3Afalse%2Cticks%3A%7Bmin%3A0%2Cmax%3A1%7D%7D%5D%7D%7D%7D";

const IMAGES = [
  {
    label: "16级灰阶基准条",
    url: GRAY16_REFERENCE_URL,
  },
  {
    label: "复古相机·金属与暗纹",
    url: "https://picsum.photos/id/250/540/960?grayscale",
  },
  {
    label: "黑色幼犬·暗部与眼部高光",
    url: "https://picsum.photos/id/237/540/960?grayscale",
  },
  {
    label: "雾山公路·天空与暗山渐变",
    url: "https://picsum.photos/id/1018/540/960?grayscale",
  },
  {
    label: "毯中巴哥犬·织物中灰细节",
    url: "https://picsum.photos/id/1025/540/960?grayscale",
  },
  {
    label: "峡湾悬崖·远近与岩石层次",
    url: "https://picsum.photos/id/1015/540/960?grayscale",
  },
  {
    label: "双塔仰视·硬边与亮白",
    url: "https://picsum.photos/id/1048/540/960?grayscale",
  },
  {
    label: "狮子特写·毛发与阴影",
    url: "https://picsum.photos/id/1074/540/960?grayscale",
  },
  {
    label: "林间小鹿·暗林与轮廓",
    url: "https://picsum.photos/id/1003/540/960?grayscale",
  },
] as const;

interface SourceImage {
  label: string;
  url: string;
  original: Buffer;
  baseline: Buffer;
  originalSha256: string;
  baselineSha256: string;
  width: number;
  height: number;
  channels: number;
  wasProgressive: boolean;
}

async function downloadSource(
  image: (typeof IMAGES)[number],
): Promise<SourceImage> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(image.url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "image/jpeg",
        "User-Agent": "InkOS-Source-Image-Builder/1.0",
      },
    });
    if (!response.ok) throw new Error(`${image.label}: HTTP ${response.status}`);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0];
    if (contentType !== "image/jpeg") {
      throw new Error(`${image.label}: expected image/jpeg, received ${contentType}`);
    }
    const original = Buffer.from(await response.arrayBuffer());
    if (original.length === 0 || original.length > MAX_SOURCE_IMAGE_BYTES) {
      throw new Error(`${image.label}: source has invalid length ${original.length}`);
    }
    const originalMetadata = await sharp(original, {
      animated: false,
      failOn: "warning",
    }).metadata();
    if (
      !originalMetadata.width
      || !originalMetadata.height
      || !originalMetadata.channels
      || (originalMetadata.orientation !== undefined
        && originalMetadata.orientation !== 1)
    ) {
      throw new Error(`${image.label}: unsupported source dimensions/orientation`);
    }

    // M5GFX's embedded TJpgDec accepts baseline SOF0 JPEG, while Picsum's
    // fixed images are progressive. jpegtran changes only scan/Huffman
    // organization: DCT coefficients and therefore decoded pixels remain
    // identical. It does not resize, tone-map, sharpen, dither or requantize.
    const baseline = execFileSync(
      "jpegtran",
      ["-copy", "all", "-optimize"],
      {
        input: original,
        maxBuffer: MAX_SOURCE_IMAGE_BYTES,
      },
    );
    if (baseline.length === 0 || baseline.length > MAX_SOURCE_IMAGE_BYTES) {
      throw new Error(`${image.label}: baseline JPEG exceeds device limit`);
    }
    const baselineMetadata = await sharp(baseline, {
      animated: false,
      failOn: "warning",
    }).metadata();
    if (
      baselineMetadata.isProgressive
      || baselineMetadata.width !== originalMetadata.width
      || baselineMetadata.height !== originalMetadata.height
      || baselineMetadata.channels !== originalMetadata.channels
    ) {
      throw new Error(`${image.label}: lossless baseline conversion changed metadata`);
    }
    const [originalPixels, baselinePixels] = await Promise.all([
      sharp(original).raw().toBuffer(),
      sharp(baseline).raw().toBuffer(),
    ]);
    if (!originalPixels.equals(baselinePixels)) {
      throw new Error(`${image.label}: baseline conversion changed decoded pixels`);
    }
    return {
      ...image,
      original,
      baseline,
      originalSha256: await sha256Hex(original),
      baselineSha256: await sha256Hex(baseline),
      width: originalMetadata.width,
      height: originalMetadata.height,
      channels: originalMetadata.channels,
      wasProgressive: originalMetadata.isProgressive ?? false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function pagePath(pageIndex: number): string {
  return pageIndex.toString().padStart(4, "0");
}

async function main(): Promise<void> {
  console.log(`Downloading ${IMAGES.length} fixed JPEG sources...`);
  const sources = await Promise.all(IMAGES.map(downloadSource));
  for (const [index, source] of sources.entries()) {
    console.log(
      `${index + 1}/${sources.length} ${source.label} `
      + `${source.width}x${source.height} c${source.channels} `
      + `${source.wasProgressive ? "progressive" : "baseline"} `
      + `${source.original.length}->${source.baseline.length} bytes `
      + `pixels=identical`,
    );
  }

  const variants = (["portrait", "landscape"] as const).map((orientation) =>
    createInkDisplayVariant(PAPER_S3_PROFILE_ID, {
      orientation,
      fontLevel: 0,
      invert: false,
    })
  );
  const document = packagedDocument({
    uuid: ENTRY_UUID,
    source: {
      url: IMAGES[0].url,
      title: "PaperS3 原始 JPEG 设备端解码测试",
      retrievedAt: CREATED_AT,
    },
    content: {
      schemaVersion: "inkos.content/v2",
      id: ENTRY_UUID,
      revision: REVISION,
      locale: "zh-CN",
      updatedAt: CREATED_AT,
      page: {
        kind: "image",
        layout: "contain",
        image: {
          source: { kind: "remote", url: IMAGES[0].url },
          alt: IMAGES[0].label,
          renderIntent: "photo",
        },
      },
    },
  });

  const files = new Map<string, Uint8Array>();
  const documentPath = `documents/${ENTRY_UUID}.json`;
  const documentBytes = encodeInkJson(document);
  files.set(documentPath, documentBytes);

  const manifestVariants: InkPackageManifest["documents"][number]["variants"] = [];
  const reportFrames: Array<{
    variantId: string;
    orientation: "portrait" | "landscape";
    page: number;
    label: string;
    fallbackPngBytes: number;
    sourceJpegBytes: number;
    sourceJpegSha256: string;
  }> = [];

  for (const variant of variants) {
    const whiteIndexes = new Uint8Array(
      variant.logicalSize.width * variant.logicalSize.height,
    ).fill(15);
    const fallbackPng = encodeGray4Png(
      whiteIndexes,
      variant.logicalSize.width,
      variant.logicalSize.height,
    );
    const fallbackSha256 = await sha256Hex(fallbackPng);
    const pages: InkPackageManifest["documents"][number]["variants"][number]["pages"] = [];

    for (const [pageIndex, source] of sources.entries()) {
      const prefix =
        `frames/${variant.id}/${ENTRY_UUID}/${pagePath(pageIndex)}`;
      const imagePath = `${prefix}.png`;
      const sidecarPath = `${prefix}.json`;
      const sourceImagePath =
        `source-images/${variant.id}/${ENTRY_UUID}/${pagePath(pageIndex)}.jpg`;
      const sourceImage: InkSourceImage = {
        path: sourceImagePath,
        bytes: source.baseline.length,
        sha256: source.baselineSha256,
        mediaType: "image/jpeg",
        pixelSize: {
          width: source.width,
          height: source.height,
        },
        fit: "contain",
      };
      files.set(imagePath, fallbackPng);
      files.set(sourceImagePath, source.baseline);

      const sidecar = inkFrameSidecarSchema.parse({
        schemaVersion: "inkos.frame-sidecar/v1",
        packageId: PACKAGE_ID,
        documentUuid: ENTRY_UUID,
        variantId: variant.id,
        pageIndex,
        pageCount: sources.length,
        imagePath,
        imageSha256: fallbackSha256,
        sourceImage,
        logicalSize: variant.logicalSize,
        interactions: [],
      });
      const sidecarBytes = encodeInkJson(sidecar);
      files.set(sidecarPath, sidecarBytes);
      pages.push({
        pageIndex,
        imagePath,
        imageBytes: fallbackPng.length,
        imageSha256: fallbackSha256,
        sourceImage,
        sidecarPath,
        sidecarBytes: sidecarBytes.length,
        sidecarSha256: await sha256Hex(sidecarBytes),
      });
      reportFrames.push({
        variantId: variant.id,
        orientation: variant.displayMeta.orientation,
        page: pageIndex + 1,
        label: source.label,
        fallbackPngBytes: fallbackPng.length,
        sourceJpegBytes: source.baseline.length,
        sourceJpegSha256: source.baselineSha256,
      });
    }
    manifestVariants.push({
      variantId: variant.id,
      pageCount: sources.length,
      pages,
    });
  }

  const manifest: InkPackageManifest = {
    schemaVersion: "inkos.package/v1",
    packageId: PACKAGE_ID,
    slug: "papers3-source-image-comparison",
    revision: REVISION,
    title: "PaperS3 原始 JPEG 设备端解码测试",
    entryUuid: ENTRY_UUID,
    createdAt: CREATED_AT,
    generator: {
      name: "inkos-papers3-source-image-builder",
      version: "1.0.0",
    },
    compatibility: {
      formatMajor: 1,
      minimumClientVersions: {
        web: "1.0.0",
        paperS3: "1.0.0",
      },
      requiredCapabilities: [
        "navigation.parent-v1",
        "navigation.hitbox-v1",
        "display.font-level-v1",
        "device.settings-v1",
        "content-ota.atomic-v1",
        "frame.source-image-jpeg-v1",
      ],
    },
    provenance: {
      seeds: sources.map((source) => ({
        url: source.url,
        title: source.label,
        retrievedAt: CREATED_AT,
      })),
      crawl: {
        maxDepth: 0,
        maxDocuments: 1,
      },
    },
    variants,
    documents: [{
      uuid: ENTRY_UUID,
      title: document.source.title,
      kind: "image",
      sourceUrl: document.source.url,
      documentPath,
      documentBytes: documentBytes.length,
      documentSha256: await sha256Hex(documentBytes),
      variants: manifestVariants,
    }],
  };

  const archive = await buildInkArchive(manifest, files);
  if (archive.length > MAX_DEVICE_ARCHIVE_BYTES) {
    throw new Error(
      `Archive ${archive.length} exceeds PaperS3 upload limit `
      + `${MAX_DEVICE_ARCHIVE_BYTES}`,
    );
  }
  const verified = await readInkArchive(archive, {
    maxArchiveBytes: MAX_DEVICE_ARCHIVE_BYTES,
  });
  const verifiedSourcePages = verified.manifest.documents.flatMap((entry) =>
    entry.variants.flatMap((variant) =>
      variant.pages.filter((page) => page.sourceImage)
    )
  );
  if (verifiedSourcePages.length !== sources.length * variants.length) {
    throw new Error("Verified archive lost source-image references");
  }

  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  await writeFile(OUTPUT_PATH, archive);
  const archiveSha256 = await sha256Hex(archive);
  await writeFile(
    REPORT_PATH,
    `${JSON.stringify({
      schemaVersion: "inkos.source-image-build/v1",
      output: OUTPUT_PATH,
      packageId: PACKAGE_ID,
      entryUuid: ENTRY_UUID,
      revision: REVISION,
      archiveBytes: archive.length,
      archiveSha256,
      sourcePath: {
        decode: "M5GFX TJpgDec into grayscale_8bit canvas",
        fit: "contain",
        serverResize: false,
        serverToneMapping: false,
        serverGray4Quantization: false,
        baselineConversion: "lossless jpegtran coefficient copy",
      },
      sources: sources.map((source, pageIndex) => ({
        page: pageIndex + 1,
        label: source.label,
        url: source.url,
        width: source.width,
        height: source.height,
        channels: source.channels,
        originalBytes: source.original.length,
        originalSha256: source.originalSha256,
        embeddedBytes: source.baseline.length,
        embeddedSha256: source.baselineSha256,
        originalProgressive: source.wasProgressive,
        embeddedProgressive: false,
        decodedPixelsIdentical: true,
      })),
      frames: reportFrames,
    }, null, 2)}\n`,
  );
  console.log(
    `Wrote ${OUTPUT_PATH}\n`
    + `${archive.length} bytes sha256=${archiveSha256}\n`
    + `${variants.length} variants x ${sources.length} source-image pages`,
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
