import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import type { AssetResolver } from "../lib/rendering/asset-resolver";
import { RenderEngine } from "../lib/rendering/engine";
import {
  BAIDU_MAP_ACTION,
  PAPER_S3_PROFILE_ID,
  RANDOM_IMAGE_ACTION,
  executeInkApp,
  mapBaiduMapPixelToGray,
} from "../lib/ink/apps/service";

const outputDirectory = path.resolve(process.argv[2] ?? "output/raw-colour-evidence");
const requestedAtUnixMs = 1_784_777_777_000;

function sha256(payload: Buffer): string {
  return createHash("sha256").update(payload).digest("hex");
}

function chunkTypes(payload: Buffer): string[] {
  const result: string[] = [];
  let offset = 8;
  while (offset + 12 <= payload.byteLength) {
    const length = payload.readUInt32BE(offset);
    result.push(payload.subarray(offset + 4, offset + 8).toString("ascii"));
    offset += length + 12;
  }
  return result;
}

function pngFacts(payload: Buffer) {
  return {
    bytes: payload.byteLength,
    sha256: sha256(payload),
    width: payload.readUInt32BE(16),
    height: payload.readUInt32BE(20),
    bitDepth: payload[24],
    colorType: payload[25],
    chunks: chunkTypes(payload),
  };
}

function pattern(width: number, height: number): Buffer {
  const pixels = Buffer.allocUnsafe(width * height * 3);
  const colours = [
    [12, 210, 45],
    [241, 31, 163],
    [27, 73, 232],
    [252, 183, 17],
  ] as const;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const colour = colours[
        Math.min(colours.length - 1, Math.floor(x * colours.length / width))
      ];
      const offset = (y * width + x) * 3;
      pixels[offset] = colour[0];
      pixels[offset + 1] = colour[1];
      pixels[offset + 2] = colour[2];
    }
  }
  return pixels;
}

async function pngFromPixels(pixels: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png({ palette: false })
    .toBuffer();
}

function resolver(png: Buffer, width: number, height: number): AssetResolver {
  return {
    async resolve() {
      return {
        status: "resolved",
        image: {
          dataUri: `data:image/png;base64,${png.toString("base64")}`,
          width,
          height,
          mimeType: "image/png",
        },
      };
    },
  };
}

async function rawPixels(png: Buffer): Promise<Buffer> {
  return sharp(png).removeAlpha().toColourspace("srgb").raw().toBuffer();
}

async function main(): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });

  const photoPixels = pattern(540, 960);
  const photoSource = await pngFromPixels(photoPixels, 540, 960);
  const photoResolver = resolver(photoSource, 540, 960);
  const photoAfter = await executeInkApp({
    action: RANDOM_IMAGE_ACTION,
    nonce: "evidence-photo-001",
    requestedAtUnixMs,
  }, { assetResolver: photoResolver });
  const photoBefore = await new RenderEngine({ assetResolver: photoResolver }).render({
    profileId: PAPER_S3_PROFILE_ID,
    document: photoAfter.document.content,
    displayMeta: photoAfter.request.displayMeta,
    pageIndex: 0,
  });

  const mapPixels = pattern(960, 540);
  const mapSource = await pngFromPixels(mapPixels, 960, 540);
  const mapResolver = resolver(mapSource, 960, 540);
  const mapAfter = await executeInkApp({
    action: BAIDU_MAP_ACTION,
    nonce: "evidence-map-0001",
    requestedAtUnixMs,
    displayMeta: { orientation: "landscape" },
    mapStyle: "detail",
  }, {
    baiduMapAk: "x".repeat(24),
    fetch: async () => Response.json({
      status: 0,
      content: { point: { x: "120.1551", y: "30.2741" } },
    }),
    assetResolver: mapResolver,
  });
  const tonedMapPixels = Buffer.allocUnsafe(960 * 540 * 3);
  for (let index = 0; index < 960 * 540; index += 1) {
    const sourceOffset = index * 3;
    const gray = mapBaiduMapPixelToGray(
      "detail",
      mapPixels[sourceOffset],
      mapPixels[sourceOffset + 1],
      mapPixels[sourceOffset + 2],
    );
    tonedMapPixels.fill(gray, sourceOffset, sourceOffset + 3);
  }
  const tonedMap = await pngFromPixels(tonedMapPixels, 960, 540);
  const mapBefore = await new RenderEngine({
    assetResolver: resolver(tonedMap, 960, 540),
  }).render({
    profileId: PAPER_S3_PROFILE_ID,
    document: mapAfter.document.content,
    displayMeta: mapAfter.request.displayMeta,
    pageIndex: 0,
  });

  const files = {
    "photo-source.png": photoSource,
    "photo-before-gray4.png": photoBefore.payload,
    "photo-after-diagnostic-rgb.png": photoAfter.frame.payload,
    "map-source.png": mapSource,
    "map-before-tone-gray4.png": mapBefore.payload,
    "map-after-diagnostic-rgb.png": mapAfter.frame.payload,
  };
  await Promise.all(
    Object.entries(files).map(([name, payload]) => {
      return writeFile(path.join(outputDirectory, name), payload);
    }),
  );

  const photoAfterPixels = await rawPixels(photoAfter.frame.payload);
  const mapAfterPixels = await rawPixels(mapAfter.frame.payload);
  const evidence = {
    schemaVersion: "inkos.raw-colour-evidence/v1",
    status: "temporary diagnostic baseline",
    bypassed: [
      "Baidu map tone mapping",
      "photo gamma",
      "photo contrast",
      "sharpening",
      "grayscale conversion",
      "gray4 palette quantization",
      "ordered dithering",
    ],
    retained: [
      "URL and SSRF policy",
      "download byte limit",
      "decoded pixel limit",
      "decode validation",
      "contain/cover geometry",
      "SHA-256 and response lineage",
    ],
    photo: {
      source: pngFacts(photoSource),
      before: pngFacts(photoBefore.payload),
      after: pngFacts(photoAfter.frame.payload),
      afterRendererVersion: photoAfter.frame.manifest.rendererVersion,
      afterPixelsEqualDecodedSource: photoAfterPixels.equals(photoPixels),
    },
    map: {
      source: pngFacts(mapSource),
      before: pngFacts(mapBefore.payload),
      after: pngFacts(mapAfter.frame.payload),
      afterRendererVersion: mapAfter.frame.manifest.rendererVersion,
      afterPixelsEqualDecodedSource: mapAfterPixels.equals(mapPixels),
    },
  };
  await writeFile(
    path.join(outputDirectory, "evidence.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "evidence capture failed");
  process.exitCode = 1;
});
