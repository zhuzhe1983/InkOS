import { deflateSync } from "node:zlib";

import type { EinkOutputTuning } from "./contracts";

export type Gray4Quantization = "uniform-16" | "photo-ordered-16";

export interface ResolvedGray4OutputTuning {
  /** Midtone control. Values above 1 lighten; values below 1 darken. */
  gamma: number;
  /** Global contrast around middle gray. */
  contrast: number;
  /** Input gray mapped to panel black. */
  blackPoint: number;
  /** Input gray mapped to panel white. */
  whitePoint: number;
  /** Three-by-three unsharp-mask amount. */
  sharpen: number;
  /** Extra contrast applied only to renderer-marked photo regions. */
  photoContrast: number;
  /** UI stays deterministic; optional ordered dithering is photo-only. */
  quantization: Gray4Quantization;
  /** SVG raster scale before the final high-quality downsample. */
  supersampling: 1 | 2;
}

export type ResolvedGray4PhotoTuning = Pick<
  ResolvedGray4OutputTuning,
  | "gamma"
  | "contrast"
  | "blackPoint"
  | "whitePoint"
  | "sharpen"
  | "photoContrast"
>;

/**
 * Readability-oriented defaults for the 235 ppi PaperS3 panel. They keep
 * anti-aliased edge coverage, but compress pale edge pixels toward paper and
 * dark edge pixels toward ink before the fixed 16-gray quantizer.
 */
export const PAPER_S3_DEFAULT_OUTPUT_TUNING = Object.freeze({
  gamma: 0.94,
  contrast: 1.12,
  blackPoint: 8,
  whitePoint: 247,
  sharpen: 0.34,
  photoContrast: 1.1,
  quantization: "photo-ordered-16",
  supersampling: 2,
} satisfies ResolvedGray4OutputTuning);

/**
 * Continuous-tone photos need a gentler curve than UI strokes. Keeping their
 * full 0..255 source range avoids the HDR-like black/white clipping produced by
 * the readability curve. Do not add sharpening or contrast here: the server's
 * one bounded ordered-dither pass is sufficient for 16-level photographs, and
 * preserving the source tone curve makes the image viewer a neutral baseline.
 */
export const PAPER_S3_DEFAULT_PHOTO_TUNING = Object.freeze({
  gamma: 1,
  contrast: 1,
  blackPoint: 0,
  whitePoint: 255,
  sharpen: 0,
  photoContrast: 1,
} satisfies ResolvedGray4PhotoTuning);

export function resolveGray4OutputTuning(
  override?: EinkOutputTuning,
): ResolvedGray4OutputTuning {
  return {
    ...PAPER_S3_DEFAULT_OUTPUT_TUNING,
    ...override,
  };
}

export function resolveGray4PhotoTuning(
  override?: EinkOutputTuning,
): ResolvedGray4PhotoTuning {
  return {
    gamma: override?.gamma ?? PAPER_S3_DEFAULT_PHOTO_TUNING.gamma,
    contrast: override?.contrast ?? PAPER_S3_DEFAULT_PHOTO_TUNING.contrast,
    blackPoint: override?.blackPoint ?? PAPER_S3_DEFAULT_PHOTO_TUNING.blackPoint,
    whitePoint: override?.whitePoint ?? PAPER_S3_DEFAULT_PHOTO_TUNING.whitePoint,
    sharpen: override?.sharpen ?? PAPER_S3_DEFAULT_PHOTO_TUNING.sharpen,
    photoContrast: override?.photoContrast
      ?? PAPER_S3_DEFAULT_PHOTO_TUNING.photoContrast,
  };
}

const clampByte = (value: number): number => Math.max(0, Math.min(255, value));

function toneMap(
  value: number,
  tuning: Pick<
    ResolvedGray4OutputTuning,
    "gamma" | "contrast" | "blackPoint" | "whitePoint"
  >,
): number {
  const normalized = Math.max(
    0,
    Math.min(1, (value - tuning.blackPoint) / (tuning.whitePoint - tuning.blackPoint)),
  );
  const contrasted = Math.max(0, Math.min(1, (normalized - 0.5) * tuning.contrast + 0.5));
  return 255 * contrasted ** (1 / tuning.gamma);
}

function photoMean(values: Float32Array, photoMask: Uint8Array): number {
  let sum = 0;
  let count = 0;
  for (let index = 0; index < values.length; index += 1) {
    if (photoMask[index] !== 1) continue;
    sum += values[index];
    count += 1;
  }
  return count === 0 ? 127.5 : sum / count;
}

function sharpenedValues(
  values: Float32Array,
  width: number,
  height: number,
  amount: number,
  photoMask?: Uint8Array,
  photoAmount = amount,
): Float32Array {
  if (amount <= 0 && photoAmount <= 0) return values;
  const output = new Float32Array(values.length);
  for (let y = 0; y < height; y += 1) {
    const previousY = Math.max(0, y - 1);
    const nextY = Math.min(height - 1, y + 1);
    for (let x = 0; x < width; x += 1) {
      const previousX = Math.max(0, x - 1);
      const nextX = Math.min(width - 1, x + 1);
      const blurred = (
        values[previousY * width + previousX]
        + 2 * values[previousY * width + x]
        + values[previousY * width + nextX]
        + 2 * values[y * width + previousX]
        + 4 * values[y * width + x]
        + 2 * values[y * width + nextX]
        + values[nextY * width + previousX]
        + 2 * values[nextY * width + x]
        + values[nextY * width + nextX]
      ) / 16;
      const center = values[y * width + x];
      const index = y * width + x;
      const localAmount = photoMask?.[index] === 1 ? photoAmount : amount;
      output[index] = clampByte(center + localAmount * (center - blurred));
    }
  }
  return output;
}

const BAYER_4X4 = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
] as const;

/** Convert the rasterizer's gray pixels to exact four-bit panel indexes. */
export function tuneAndQuantizeGray4(
  pixels: Buffer,
  width: number,
  height: number,
  channels: number,
  photoMask: Uint8Array,
  tuning: ResolvedGray4OutputTuning,
  photoTuning?: ResolvedGray4PhotoTuning,
): Uint8Array {
  const pixelCount = width * height;
  if (pixels.length < pixelCount * channels || photoMask.length !== pixelCount) {
    throw new Error("Gray4 raster and photo mask dimensions differ");
  }

  const values = new Float32Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    values[index] = toneMap(
      pixels[index * channels],
      photoTuning && photoMask[index] === 1 ? photoTuning : tuning,
    );
  }

  const mean = photoMean(values, photoMask);
  const photoContrast = photoTuning?.photoContrast ?? tuning.photoContrast;
  if (photoContrast !== 1) {
    for (let index = 0; index < pixelCount; index += 1) {
      if (photoMask[index] === 1) {
        values[index] = clampByte(mean + (values[index] - mean) * photoContrast);
      }
    }
  }

  const sharpened = sharpenedValues(
    values,
    width,
    height,
    tuning.sharpen,
    photoMask,
    photoTuning?.sharpen ?? tuning.sharpen,
  );
  const indexes = new Uint8Array(pixelCount);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      let value = sharpened[index];
      if (tuning.quantization === "photo-ordered-16" && photoMask[index] === 1) {
        // Less than one panel step: enough to preserve texture without adding
        // visible screen-door noise to small thumbnails.
        const threshold = (BAYER_4X4[(y % 4) * 4 + (x % 4)] + 0.5) / 16 - 0.5;
        value = clampByte(value + threshold * 8);
      }
      indexes[index] = Math.max(0, Math.min(15, Math.round(value / 17)));
    }
  }
  return indexes;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let checksum = 0xffffffff;
  for (const byte of data) {
    checksum = CRC32_TABLE[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

function pngChunk(type: "IHDR" | "PLTE" | "IDAT" | "IEND", data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const chunk = Buffer.allocUnsafe(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), data.length + 8);
  return chunk;
}

/**
 * Encode a standards-compliant indexed PNG whose palette entries are centered
 * in M5GFX's 8-bit-to-4-bit buckets. PaperS3's Panel_EPD applies
 * `(value + Bayer - 8) >> 4` when an 8-bit sprite is pushed, so the intuitive
 * 0,17,...255 palette gets dithered a second time on-device. Values
 * 8,24,...248 survive every Bayer position as the exact intended 0..15 index.
 */
export function encodeGray4Png(indexes: Uint8Array, width: number, height: number): Buffer {
  if (indexes.length !== width * height) throw new Error("Gray4 index dimensions differ");
  const bytesPerRow = Math.ceil(width / 2);
  const scanlines = Buffer.alloc((bytesPerRow + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const scanlineOffset = y * (bytesPerRow + 1);
    scanlines[scanlineOffset] = 0;
    for (let x = 0; x < width; x += 2) {
      const first = indexes[y * width + x];
      const second = x + 1 < width ? indexes[y * width + x + 1] : 0;
      scanlines[scanlineOffset + 1 + x / 2] = (first << 4) | second;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 4;
  header[9] = 3;
  const palette = Buffer.from(Array.from({ length: 16 }, (_, index) => {
    const gray = index * 16 + 8;
    return [gray, gray, gray];
  }).flat());
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", header),
    pngChunk("PLTE", palette),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
