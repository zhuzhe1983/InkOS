import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  encodeGray4Png,
  PAPER_S3_DEFAULT_PHOTO_TUNING,
  PAPER_S3_DEFAULT_OUTPUT_TUNING,
  resolveGray4PhotoTuning,
  resolveGray4OutputTuning,
  tuneAndQuantizeGray4,
} from "./gray4-output";

function pngChunk(payload: Buffer, expectedType: string): Buffer {
  let offset = 8;
  while (offset + 12 <= payload.length) {
    const length = payload.readUInt32BE(offset);
    const type = payload.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === expectedType) return payload.subarray(offset + 8, offset + 8 + length);
    offset += length + 12;
  }
  throw new Error(`PNG has no ${expectedType} chunk`);
}

describe("PaperS3 fixed gray4 output", () => {
  it("uses readability defaults without serializing them into old requests", () => {
    expect(resolveGray4OutputTuning()).toEqual(PAPER_S3_DEFAULT_OUTPUT_TUNING);
    expect(resolveGray4OutputTuning({ gamma: 1.1, sharpen: 0 })).toMatchObject({
      gamma: 1.1,
      sharpen: 0,
      contrast: PAPER_S3_DEFAULT_OUTPUT_TUNING.contrast,
      quantization: "photo-ordered-16",
    });
  });

  it("uses a neutral source-preserving default for continuous-tone photos", () => {
    expect(resolveGray4PhotoTuning()).toEqual(PAPER_S3_DEFAULT_PHOTO_TUNING);
    expect(resolveGray4PhotoTuning({ contrast: 1.2, sharpen: 0 })).toMatchObject({
      gamma: 1,
      contrast: 1.2,
      blackPoint: 0,
      whitePoint: 255,
      sharpen: 0,
      photoContrast: 1,
    });
  });

  it("encodes stable M5GFX bucket centers so PaperS3 preserves every gray4 index", async () => {
    const indexes = Uint8Array.from({ length: 16 }, (_, index) => index);
    const payload = encodeGray4Png(indexes, 16, 1);
    const palette = pngChunk(payload, "PLTE");
    const metadata = await sharp(payload).metadata();

    expect(metadata).toMatchObject({ width: 16, height: 1, depth: "uchar", isPalette: true });
    expect(palette).toEqual(Buffer.from(Array.from({ length: 16 }, (_, index) => {
      const gray = index * 16 + 8;
      return [gray, gray, gray];
    }).flat()));
  });

  it("maps every palette entry back to its exact Panel_EPD index at all Bayer positions", () => {
    const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    for (let index = 0; index < 16; index += 1) {
      const paletteValue = index * 16 + 8;
      expect(bayer.map((threshold) => Math.max(
        0,
        Math.min(15, (paletteValue + threshold - 8) >> 4),
      ))).toEqual(Array.from({ length: 16 }, () => index));
    }
  });

  it("maps the full input range monotonically to the fixed panel indexes", () => {
    const pixels = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
    const mask = new Uint8Array(256);
    const tuning = resolveGray4OutputTuning({ supersampling: 1 });
    const indexes = tuneAndQuantizeGray4(pixels, 256, 1, 1, mask, tuning);

    expect(indexes[0]).toBe(0);
    expect(indexes[indexes.length - 1]).toBe(15);
    expect([...indexes].every((value, index, values) => index === 0 || value >= values[index - 1]))
      .toBe(true);
  });

  it("dithers constant tones only inside photos, leaving UI fills and text edges stable", () => {
    const width = 32;
    const height = 16;
    const pixels = Buffer.alloc(width * height, 144);
    const photoMask = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      photoMask.fill(1, y * width, y * width + width / 2);
    }
    const indexes = tuneAndQuantizeGray4(
      pixels,
      width,
      height,
      1,
      photoMask,
      resolveGray4OutputTuning({
        gamma: 1,
        contrast: 1,
        blackPoint: 0,
        whitePoint: 255,
        sharpen: 0,
        photoContrast: 1,
        quantization: "photo-ordered-16",
        supersampling: 1,
      }),
    );
    const photoLevels = new Set<number>();
    const uiLevels = new Set<number>();
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        (x < width / 2 ? photoLevels : uiLevels).add(indexes[y * width + x]);
      }
    }

    expect(photoLevels.size).toBeGreaterThan(1);
    expect(uiLevels.size).toBe(1);
  });

  it("increases a washed-out photo's useful panel range without changing surrounding UI", () => {
    const width = 32;
    const height = 8;
    const pixels = Buffer.alloc(width * height, 245);
    const photoMask = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width / 2; x += 1) {
        photoMask[y * width + x] = 1;
        pixels[y * width + x] = 180 + ((x + y) % 8) * 8;
      }
    }
    const neutral = resolveGray4OutputTuning({
      gamma: 1,
      contrast: 1,
      blackPoint: 0,
      whitePoint: 255,
      sharpen: 0,
      photoContrast: 1,
      quantization: "uniform-16",
      supersampling: 1,
    });
    const enhanced = resolveGray4OutputTuning({ quantization: "uniform-16", sharpen: 0 });
    const neutralIndexes = tuneAndQuantizeGray4(
      pixels, width, height, 1, photoMask, neutral,
    );
    const enhancedIndexes = tuneAndQuantizeGray4(
      pixels, width, height, 1, photoMask, enhanced,
    );
    const range = (values: Uint8Array, left: number, right: number) => {
      const selected: number[] = [];
      for (let y = 0; y < height; y += 1) {
        for (let x = left; x < right; x += 1) selected.push(values[y * width + x]);
      }
      return Math.max(...selected) - Math.min(...selected);
    };

    expect(range(enhancedIndexes, 0, width / 2)).toBeGreaterThanOrEqual(
      range(neutralIndexes, 0, width / 2),
    );
    expect(range(enhancedIndexes, width / 2, width)).toBe(0);
  });

  it("keeps default photo tones near-neutral without weakening the surrounding UI curve", () => {
    const width = 512;
    const pixels = Buffer.from(Array.from({ length: width }, (_, index) => index % 256));
    const photoMask = new Uint8Array(width);
    photoMask.fill(1, 0, width / 2);
    const uiAndPhoto = tuneAndQuantizeGray4(
      pixels,
      width,
      1,
      1,
      photoMask,
      resolveGray4OutputTuning({ quantization: "uniform-16", supersampling: 1 }),
      resolveGray4PhotoTuning(),
    );
    const allUi = tuneAndQuantizeGray4(
      pixels,
      width,
      1,
      1,
      new Uint8Array(width),
      resolveGray4OutputTuning({ quantization: "uniform-16", supersampling: 1 }),
    );

    // The photo half no longer reaches panel black from the readability curve,
    // while the non-photo half remains bit-for-bit on that existing curve.
    expect(uiAndPhoto[16]).toBeGreaterThan(uiAndPhoto[width / 2 + 16]);
    expect(uiAndPhoto[240]).toBeLessThan(uiAndPhoto[width / 2 + 240]);
    expect([...uiAndPhoto.slice(width / 2)]).toEqual([...allUi.slice(width / 2)]);
  });
});
