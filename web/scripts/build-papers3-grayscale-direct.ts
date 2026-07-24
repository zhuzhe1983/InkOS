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
} from "../lib/ink/contracts";
import { createInkDisplayVariant } from "../lib/ink/package-builder";
import { uuidV5 } from "../lib/ink/uuid";
import { encodeGray4Png } from "../lib/rendering/gray4-output";

const PAPER_S3_PROFILE_ID = "m5stack-paper-s3-portrait";
const CREATED_AT = "2026-07-24T01:00:00+08:00";
const REVISION = 20_260_724;
const MAX_DEVICE_ARCHIVE_BYTES = 0x440000;
const DNS_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const PACKAGE_ID = uuidV5("inkos:papers3-grayscale-direct", DNS_NAMESPACE);
const ENTRY_UUID = uuidV5("document:grayscale-direct", PACKAGE_ID);
const OUTPUT_DIRECTORY = path.resolve(process.cwd(), "..", "output");
const OUTPUT_PATH = path.join(OUTPUT_DIRECTORY, "papers3-grayscale-direct.ink");
const REPORT_PATH = path.join(
  OUTPUT_DIRECTORY,
  "papers3-grayscale-direct.report.json",
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

interface DownloadedImage {
  label: string;
  url: string;
  bytes: Buffer;
  sha256: string;
  contentType: string;
}

async function downloadImage(
  image: (typeof IMAGES)[number],
): Promise<DownloadedImage> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(image.url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "image/jpeg,image/png,image/webp",
        "User-Agent": "InkOS-Offline-Gray4-Builder/1.0",
      },
    });
    if (!response.ok) {
      throw new Error(`${image.label}: HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]
      ?? "application/octet-stream";
    if (!["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
      throw new Error(`${image.label}: unsupported Content-Type ${contentType}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > 3 * 1024 * 1024) {
      throw new Error(`${image.label}: invalid source byte length ${bytes.length}`);
    }
    await sharp(bytes, { animated: false, failOn: "warning" }).metadata();
    return {
      ...image,
      bytes,
      sha256: await sha256Hex(bytes),
      contentType,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function directGray4Frame(
  source: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  const { data, info } = await sharp(source, {
    animated: false,
    failOn: "warning",
  })
    .rotate()
    .flatten({ background: "#ffffff" })
    .resize({
      width,
      height,
      fit: "contain",
      position: "centre",
      background: "#ffffff",
      kernel: "lanczos3",
    })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.width !== width || info.height !== height) {
    throw new Error(`Unexpected resized dimensions ${info.width}x${info.height}`);
  }
  const indexes = new Uint8Array(width * height);
  for (let index = 0; index < indexes.length; index += 1) {
    indexes[index] = Math.max(
      0,
      Math.min(15, Math.round(data[index * info.channels] / 17)),
    );
  }
  return encodeGray4Png(indexes, width, height);
}

function pagePath(pageIndex: number): string {
  return pageIndex.toString().padStart(4, "0");
}

async function main(): Promise<void> {
  console.log(`Downloading ${IMAGES.length} fixed grayscale sources...`);
  const downloaded = await Promise.all(IMAGES.map(downloadImage));
  for (const [index, image] of downloaded.entries()) {
    console.log(
      `${index + 1}/${downloaded.length} ${image.label} `
      + `${image.bytes.length} bytes sha256=${image.sha256}`,
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
      title: "PaperS3 灰度图片直通测试",
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
    pageIndex: number;
    label: string;
    imageBytes: number;
    imageSha256: string;
  }> = [];

  for (const variant of variants) {
    const pages: InkPackageManifest["documents"][number]["variants"][number]["pages"] = [];
    for (const [pageIndex, image] of downloaded.entries()) {
      const imageBytes = await directGray4Frame(
        image.bytes,
        variant.logicalSize.width,
        variant.logicalSize.height,
      );
      const imageSha256 = await sha256Hex(imageBytes);
      const prefix =
        `frames/${variant.id}/${ENTRY_UUID}/${pagePath(pageIndex)}`;
      const imagePath = `${prefix}.png`;
      const sidecarPath = `${prefix}.json`;
      files.set(imagePath, imageBytes);

      const sidecar = inkFrameSidecarSchema.parse({
        schemaVersion: "inkos.frame-sidecar/v1",
        packageId: PACKAGE_ID,
        documentUuid: ENTRY_UUID,
        variantId: variant.id,
        pageIndex,
        pageCount: downloaded.length,
        imagePath,
        imageSha256,
        logicalSize: variant.logicalSize,
        interactions: [],
      });
      const sidecarBytes = encodeInkJson(sidecar);
      files.set(sidecarPath, sidecarBytes);
      pages.push({
        pageIndex,
        imagePath,
        imageBytes: imageBytes.length,
        imageSha256,
        sidecarPath,
        sidecarBytes: sidecarBytes.length,
        sidecarSha256: await sha256Hex(sidecarBytes),
      });
      reportFrames.push({
        variantId: variant.id,
        orientation: variant.displayMeta.orientation,
        pageIndex,
        label: image.label,
        imageBytes: imageBytes.length,
        imageSha256,
      });
    }
    manifestVariants.push({
      variantId: variant.id,
      pageCount: downloaded.length,
      pages,
    });
  }

  const manifest: InkPackageManifest = {
    schemaVersion: "inkos.package/v1",
    packageId: PACKAGE_ID,
    slug: "papers3-grayscale-direct",
    revision: REVISION,
    title: "PaperS3 灰度图片直通测试",
    entryUuid: ENTRY_UUID,
    createdAt: CREATED_AT,
    generator: {
      name: "inkos-papers3-grayscale-direct",
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
      ],
    },
    provenance: {
      seeds: downloaded.map((image) => ({
        url: image.url,
        title: image.label,
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
  if (verified.manifest.documents[0].variants.some(
    (variant) => variant.pageCount !== downloaded.length,
  )) {
    throw new Error("Verified archive lost grayscale comparison pages");
  }

  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  await writeFile(OUTPUT_PATH, archive);
  const archiveSha256 = await sha256Hex(archive);
  await writeFile(
    REPORT_PATH,
    `${JSON.stringify({
      schemaVersion: "inkos.grayscale-direct-build/v1",
      output: OUTPUT_PATH,
      packageId: PACKAGE_ID,
      entryUuid: ENTRY_UUID,
      revision: REVISION,
      archiveBytes: archive.length,
      archiveSha256,
      quantization: {
        mode: "uniform-nearest-16",
        toneMapping: false,
        sharpening: false,
        dithering: false,
        palette: Array.from({ length: 16 }, (_, index) => index * 16 + 8),
      },
      sources: downloaded.map((image, pageIndex) => ({
        page: pageIndex + 1,
        label: image.label,
        url: image.url,
        contentType: image.contentType,
        sourceBytes: image.bytes.length,
        sourceSha256: image.sha256,
      })),
      frames: reportFrames,
    }, null, 2)}\n`,
  );
  console.log(
    `Wrote ${OUTPUT_PATH}\n`
    + `${archive.length} bytes sha256=${archiveSha256}\n`
    + `${variants.length} variants x ${downloaded.length} pages`,
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
