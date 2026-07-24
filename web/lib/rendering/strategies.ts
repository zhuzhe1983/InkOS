import { deflateSync } from "node:zlib";

import sharp from "sharp";

import type { DisplayMeta, RenderRegion, ScreenProfile } from "./contracts";
import {
  encodeGray4Png,
  resolveGray4PhotoTuning,
  resolveGray4OutputTuning,
  tuneAndQuantizeGray4,
} from "./gray4-output";

export interface StrategyInput {
  svg: string;
  profile: ScreenProfile;
  region: RenderRegion;
  displayMeta: DisplayMeta;
}

export interface RenderStrategy {
  readonly id: ScreenProfile["rasterStrategy"];
  render(input: StrategyInput): Promise<Buffer>;
}

export const SPECTRA6_PALETTE = [
  [0, 0, 0],
  [255, 255, 255],
  [255, 0, 0],
  [255, 255, 0],
  [0, 0, 255],
  [0, 255, 0],
] as const satisfies readonly (readonly [number, number, number])[];

function basePipeline(
  { svg, profile, region }: StrategyInput,
  options: { supersampling?: 1 | 2 } = {},
): sharp.Sharp {
  const supersampling = options.supersampling ?? 1;
  let pipeline = sharp(Buffer.from(svg), { density: 72 * supersampling })
    .resize(profile.logicalSize.width, profile.logicalSize.height, {
      fit: "fill",
      kernel: sharp.kernel.lanczos3,
    })
    .flatten({ background: "#FFFFFF" })
    .greyscale();

  if (
    region.x !== 0 ||
    region.y !== 0 ||
    region.width !== profile.logicalSize.width ||
    region.height !== profile.logicalSize.height
  ) {
    pipeline = pipeline.extract({
      left: region.x,
      top: region.y,
      width: region.width,
      height: region.height,
    });
  }

  return pipeline;
}

function colorPipeline({ svg, profile, region }: StrategyInput): sharp.Sharp {
  let pipeline = sharp(Buffer.from(svg), { density: 72 })
    .resize(profile.logicalSize.width, profile.logicalSize.height, { fit: "fill" })
    .flatten({ background: "#FFFFFF" });

  if (
    region.x !== 0 ||
    region.y !== 0 ||
    region.width !== profile.logicalSize.width ||
    region.height !== profile.logicalSize.height
  ) {
    pipeline = pipeline.extract({
      left: region.x,
      top: region.y,
      width: region.width,
      height: region.height,
    });
  }

  return pipeline.removeAlpha().toColourspace("srgb");
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

function nearestSpectra6ColorIndex(red: number, green: number, blue: number): number {
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < SPECTRA6_PALETTE.length; index += 1) {
    const [paletteRed, paletteGreen, paletteBlue] = SPECTRA6_PALETTE[index];
    const redDelta = red - paletteRed;
    const greenDelta = green - paletteGreen;
    const blueDelta = blue - paletteBlue;
    // Weight the squared RGB distance by perceived channel brightness.
    const distance =
      redDelta * redDelta * 0.2126 +
      greenDelta * greenDelta * 0.7152 +
      blueDelta * blueDelta * 0.0722;

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }

  return nearestIndex;
}

type LinearRgb = readonly [number, number, number];

interface PhotoRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function srgb8ToLinear(value: number): number {
  const encoded = Math.max(0, Math.min(255, value)) / 255;
  return encoded <= 0.04045
    ? encoded / 12.92
    : ((encoded + 0.055) / 1.055) ** 2.4;
}

function linearRgbToOklab([red, green, blue]: LinearRgb): LinearRgb {
  const long = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const medium = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const short = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  return [
    0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short,
    1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short,
    0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short,
  ];
}

const SPECTRA6_LINEAR_PALETTE = SPECTRA6_PALETTE.map(
  ([red, green, blue]) => [srgb8ToLinear(red), srgb8ToLinear(green), srgb8ToLinear(blue)] as const,
);
const SPECTRA6_OKLAB_PALETTE = SPECTRA6_LINEAR_PALETTE.map(linearRgbToOklab);

function nearestPerceptualSpectra6ColorIndex(color: LinearRgb): number {
  const [lightness, greenRed, blueYellow] = linearRgbToOklab(color);
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < SPECTRA6_OKLAB_PALETTE.length; index += 1) {
    const [paletteLightness, paletteGreenRed, paletteBlueYellow] =
      SPECTRA6_OKLAB_PALETTE[index];
    const lightnessDelta = lightness - paletteLightness;
    const greenRedDelta = greenRed - paletteGreenRed;
    const blueYellowDelta = blueYellow - paletteBlueYellow;
    const distance =
      lightnessDelta * lightnessDelta +
      greenRedDelta * greenRedDelta +
      blueYellowDelta * blueYellowDelta;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }

  return nearestIndex;
}

function numericSvgAttribute(tag: string, name: "x" | "y" | "width" | "height"): number | undefined {
  const match = tag.match(new RegExp(`\\b${name}=(?:"([0-9.]+)"|'([0-9.]+)')`, "u"));
  const value = match?.[1] ?? match?.[2];
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function extractPhotoRects(svg: string): PhotoRect[] {
  const tags = svg.match(/<image\b[^>]*\bdata-ink-photo=(?:"true"|'true')[^>]*>/gu) ?? [];
  return tags.flatMap((tag) => {
    const x = numericSvgAttribute(tag, "x");
    const y = numericSvgAttribute(tag, "y");
    const width = numericSvgAttribute(tag, "width");
    const height = numericSvgAttribute(tag, "height");
    if (x === undefined || y === undefined || width === undefined || height === undefined) return [];
    if (width <= 0 || height <= 0) return [];
    return [{ x, y, width, height }];
  });
}

function photoMaskForRegion(
  rects: readonly PhotoRect[],
  region: RenderRegion,
  width: number,
  height: number,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (const rect of rects) {
    const left = Math.max(0, Math.floor(rect.x - region.x));
    const top = Math.max(0, Math.floor(rect.y - region.y));
    const right = Math.min(width, Math.ceil(rect.x + rect.width - region.x));
    const bottom = Math.min(height, Math.ceil(rect.y + rect.height - region.y));
    if (left >= right || top >= bottom) continue;
    for (let y = top; y < bottom; y += 1) {
      mask.fill(1, y * width + left, y * width + right);
    }
  }
  return mask;
}

function encodeSpectra6Indexes(indexes: Uint8Array, width: number, height: number): Buffer {
  const bytesPerRow = Math.ceil(width / 2);
  const scanlines = Buffer.alloc((bytesPerRow + 1) * height);

  for (let y = 0; y < height; y += 1) {
    const scanlineOffset = y * (bytesPerRow + 1);
    scanlines[scanlineOffset] = 0;
    for (let x = 0; x < width; x += 2) {
      const firstIndex = indexes[y * width + x];
      const secondIndex = x + 1 < width ? indexes[y * width + x + 1] : 0;
      scanlines[scanlineOffset + 1 + x / 2] = (firstIndex << 4) | secondIndex;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 4;
  header[9] = 3;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const palette = Buffer.from(SPECTRA6_PALETTE.flatMap((color) => [...color]));
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", header),
    pngChunk("PLTE", palette),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function encodeSpectra6Png(
  pixels: Buffer,
  width: number,
  height: number,
  channels: number,
): Buffer {
  const indexes = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelOffset = (y * width + x) * channels;
      indexes[y * width + x] = nearestSpectra6ColorIndex(
        pixels[pixelOffset],
        pixels[pixelOffset + 1],
        pixels[pixelOffset + 2],
      );
    }
  }
  return encodeSpectra6Indexes(indexes, width, height);
}

function encodePhotoDitheredSpectra6Png(
  pixels: Buffer,
  width: number,
  height: number,
  channels: number,
  photoMask: Uint8Array,
): Buffer {
  const indexes = new Uint8Array(width * height);
  const currentError = new Float32Array((width + 2) * 3);
  const nextError = new Float32Array((width + 2) * 3);
  const errorStrength = 0.78;

  const addError = (
    errors: Float32Array,
    x: number,
    y: number,
    red: number,
    green: number,
    blue: number,
    weight: number,
  ) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    if (photoMask[y * width + x] !== 1) return;
    const offset = (x + 1) * 3;
    errors[offset] += red * weight;
    errors[offset + 1] += green * weight;
    errors[offset + 2] += blue * weight;
  };

  for (let y = 0; y < height; y += 1) {
    const leftToRight = y % 2 === 0;
    const start = leftToRight ? 0 : width - 1;
    const end = leftToRight ? width : -1;
    const step = leftToRight ? 1 : -1;

    for (let x = start; x !== end; x += step) {
      const pixelIndex = y * width + x;
      const pixelOffset = pixelIndex * channels;
      if (photoMask[pixelIndex] !== 1) {
        indexes[pixelIndex] = nearestSpectra6ColorIndex(
          pixels[pixelOffset],
          pixels[pixelOffset + 1],
          pixels[pixelOffset + 2],
        );
        continue;
      }

      const errorOffset = (x + 1) * 3;
      const color: LinearRgb = [
        Math.max(0, Math.min(1, srgb8ToLinear(pixels[pixelOffset]) + currentError[errorOffset])),
        Math.max(0, Math.min(1, srgb8ToLinear(pixels[pixelOffset + 1]) + currentError[errorOffset + 1])),
        Math.max(0, Math.min(1, srgb8ToLinear(pixels[pixelOffset + 2]) + currentError[errorOffset + 2])),
      ];
      const paletteIndex = nearestPerceptualSpectra6ColorIndex(color);
      indexes[pixelIndex] = paletteIndex;
      const palette = SPECTRA6_LINEAR_PALETTE[paletteIndex];
      const redError = (color[0] - palette[0]) * errorStrength;
      const greenError = (color[1] - palette[1]) * errorStrength;
      const blueError = (color[2] - palette[2]) * errorStrength;
      const nextX = x + step;
      const previousX = x - step;

      addError(currentError, nextX, y, redError, greenError, blueError, 7 / 16);
      addError(nextError, previousX, y + 1, redError, greenError, blueError, 3 / 16);
      addError(nextError, x, y + 1, redError, greenError, blueError, 5 / 16);
      addError(nextError, nextX, y + 1, redError, greenError, blueError, 1 / 16);
    }

    currentError.set(nextError);
    nextError.fill(0);
  }

  return encodeSpectra6Indexes(indexes, width, height);
}

function encodeMonoPng(
  pixels: Buffer,
  width: number,
  height: number,
  channels: number,
): Buffer {
  const bytesPerRow = Math.ceil(width / 8);
  const scanlines = Buffer.alloc((bytesPerRow + 1) * height);

  for (let y = 0; y < height; y += 1) {
    const scanlineOffset = y * (bytesPerRow + 1);
    scanlines[scanlineOffset] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixelOffset = (y * width + x) * channels;
      const paletteIndex = pixels[pixelOffset] >= 176 ? 1 : 0;
      scanlines[scanlineOffset + 1 + Math.floor(x / 8)] |=
        paletteIndex << (7 - (x % 8));
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 1;
  header[9] = 3;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const palette = Buffer.from([0, 0, 0, 255, 255, 255]);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", header),
    pngChunk("PLTE", palette),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export class EinkMonoPngStrategy implements RenderStrategy {
  readonly id = "eink-mono1-png-v1" as const;

  async render(input: StrategyInput): Promise<Buffer> {
    const { data, info } = await basePipeline(input)
      .raw()
      .toBuffer({ resolveWithObject: true });
    return encodeMonoPng(data, info.width, info.height, info.channels);
  }
}

export class EinkGray4PngStrategy implements RenderStrategy {
  readonly id = "eink-gray4-png-v1" as const;

  async render(input: StrategyInput): Promise<Buffer> {
    const tuning = resolveGray4OutputTuning(input.displayMeta.outputTuning);
    const { data, info } = await basePipeline(input, {
      supersampling: tuning.supersampling,
    }).raw().toBuffer({ resolveWithObject: true });
    const photoMask = photoMaskForRegion(
      extractPhotoRects(input.svg),
      input.region,
      info.width,
      info.height,
    );
    const indexes = tuneAndQuantizeGray4(
      data,
      info.width,
      info.height,
      info.channels,
      photoMask,
      tuning,
      resolveGray4PhotoTuning(input.displayMeta.outputTuning),
    );
    return encodeGray4Png(indexes, info.width, info.height);
  }
}

export class EinkSpectra6PngStrategy implements RenderStrategy {
  readonly id = "eink-spectra6-png-v1" as const;

  async render(input: StrategyInput): Promise<Buffer> {
    const { data, info } = await colorPipeline(input)
      .raw()
      .toBuffer({ resolveWithObject: true });

    return encodeSpectra6Png(data, info.width, info.height, info.channels);
  }
}

export class EinkSpectra6PhotoDitherPngStrategy implements RenderStrategy {
  readonly id = "eink-spectra6-photo-dither-png-v2" as const;

  async render(input: StrategyInput): Promise<Buffer> {
    const { data, info } = await colorPipeline(input)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const photoMask = photoMaskForRegion(
      extractPhotoRects(input.svg),
      input.region,
      info.width,
      info.height,
    );
    return encodePhotoDitheredSpectra6Png(
      data,
      info.width,
      info.height,
      info.channels,
      photoMask,
    );
  }
}

export class RenderStrategyRegistry {
  private readonly strategies = new Map<ScreenProfile["rasterStrategy"], RenderStrategy>();

  constructor(strategies: RenderStrategy[]) {
    for (const strategy of strategies) {
      this.strategies.set(strategy.id, strategy);
    }
  }

  resolve(profile: ScreenProfile): RenderStrategy {
    const strategy = this.strategies.get(profile.rasterStrategy);
    if (!strategy) {
      throw new Error(`No render strategy registered for ${profile.rasterStrategy}`);
    }
    return strategy;
  }
}

export const defaultStrategyRegistry = new RenderStrategyRegistry([
  new EinkMonoPngStrategy(),
  new EinkGray4PngStrategy(),
  new EinkSpectra6PngStrategy(),
  new EinkSpectra6PhotoDitherPngStrategy(),
]);
