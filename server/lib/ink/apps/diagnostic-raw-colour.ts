import sharp from "sharp";

import type { AssetResolver } from "../../rendering/asset-resolver";
import { crc32Hex, sha256Hex } from "../../rendering/checksum";
import type {
  DisplayMeta,
  RenderedFrame,
  ScreenProfile,
} from "../../rendering/contracts";
import { getScreenProfile, orientScreenProfile } from "../../rendering/profiles";
import type { PackagedDocument } from "../contracts";

/**
 * Temporary raw-colour baseline retained by server-owned map frames.
 *
 * This mode deliberately performs only decode/orientation, the semantic
 * contain geometry, white alpha compositing, and lossless RGB PNG encoding.
 */
export const DIAGNOSTIC_RAW_COLOUR_MODE =
  "diagnostic-raw-colour-png-v1" as const;

export const DIAGNOSTIC_RAW_COLOUR_RENDERER_VERSION =
  `inkos-app/${DIAGNOSTIC_RAW_COLOUR_MODE}` as const;

/**
 * PaperS3 photo mode. This is the Web equivalent of the proven
 * papers3-slideshow preprocessing pipeline: clipped autocontrast, restrained
 * global contrast/unsharp enhancement and serpentine Floyd-Steinberg
 * quantization to all sixteen panel levels.
 */
export const PHOTO_PAPERS3_SLIDESHOW_GRAY16_MODE =
  "photo-papers3-slideshow-gray16-rgb-png-v3" as const;

export const PHOTO_PAPERS3_SLIDESHOW_GRAY16_RENDERER_VERSION =
  `inkos-app/${PHOTO_PAPERS3_SLIDESHOW_GRAY16_MODE}` as const;

export type DiagnosticAppImageMode =
  | typeof DIAGNOSTIC_RAW_COLOUR_MODE
  | typeof PHOTO_PAPERS3_SLIDESHOW_GRAY16_MODE;

const MAX_RESOLVED_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_RESOLVED_IMAGE_PIXELS = 12_000_000;
const PHOTO_AUTOCONTRAST_CUTOFF_PERCENT = 0.5;
const PHOTO_CONTRAST = 1.08;
const PHOTO_UNSHARP_PERCENT = 65;
const PHOTO_UNSHARP_THRESHOLD = 3;

// Pillow's GaussianBlur(radius=1, passes=3) resolves to a fractional
// BoxBlur radius of 0.25. These are the exact 24-bit fixed-point weights used
// by Pillow's libImaging implementation for each one-dimensional pass.
const PILLOW_BOX_SCALE = 1 << 24;
const PILLOW_BOX_ROUND = 1 << 23;
// libImaging computes the radius and division as float32 before converting to
// UINT32; preserving those rounded integer weights is required for byte parity.
const PILLOW_BOX_CENTRE_WEIGHT = 11_184_811;
const PILLOW_BOX_NEIGHBOUR_WEIGHT = 2_796_202;

export interface DiagnosticRawColourRenderInput {
  document: PackagedDocument;
  displayMeta: DisplayMeta;
  profileId: string;
  assetResolver: AssetResolver;
  /** Explicit app-level override used only by the diagnostic request mode. */
  mode?: DiagnosticAppImageMode;
}

function fullRegion(profile: ScreenProfile) {
  return {
    x: 0,
    y: 0,
    width: profile.logicalSize.width,
    height: profile.logicalSize.height,
  };
}

function decodeResolvedDataUri(dataUri: string): Buffer {
  const match = /^data:image\/(?:jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(dataUri);
  if (!match) throw new Error("resolved image data URI is invalid");
  const payload = Buffer.from(match[1], "base64");
  if (payload.byteLength === 0 || payload.byteLength > MAX_RESOLVED_IMAGE_BYTES) {
    throw new Error("resolved image is outside the diagnostic byte limit");
  }
  return payload;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/**
 * Quantize to 8, 24, ... 248 rather than the usual 0, 17, ... 255 ramp.
 *
 * M5GFX converts an incoming byte with `(value + bayer - 8) >> 4`. These bucket
 * centres therefore produce one stable native gray level at every Bayer
 * position instead of spatially mixing two adjacent levels.
 */
export function quantizePaperS3StableLuma(luma: number): number {
  const level = Math.min(15, Math.round(clampByte(luma) / 17));
  return 8 + level * 16;
}

export function diagnosticAppImageModeForRenderIntent(
  renderIntent: "photo" | "graphic" | "map" | undefined,
): DiagnosticAppImageMode {
  return renderIntent === "photo"
    ? PHOTO_PAPERS3_SLIDESHOW_GRAY16_MODE
    : DIAGNOSTIC_RAW_COLOUR_MODE;
}

function rendererVersionForMode(mode: DiagnosticAppImageMode): string {
  return mode === PHOTO_PAPERS3_SLIDESHOW_GRAY16_MODE
    ? PHOTO_PAPERS3_SLIDESHOW_GRAY16_RENDERER_VERSION
    : DIAGNOSTIC_RAW_COLOUR_RENDERER_VERSION;
}

function pillowAutocontrast(source: Buffer): Buffer {
  const histogram = new Uint32Array(256);
  for (const value of source) histogram[value] += 1;

  const cutoff = Math.floor(
    source.byteLength * PHOTO_AUTOCONTRAST_CUTOFF_PERCENT / 100,
  );
  let remaining = cutoff;
  for (let value = 0; value < histogram.length && remaining > 0; value += 1) {
    if (remaining > histogram[value]) {
      remaining -= histogram[value];
      histogram[value] = 0;
    } else {
      histogram[value] -= remaining;
      remaining = 0;
    }
  }
  remaining = cutoff;
  for (let value = histogram.length - 1; value >= 0 && remaining > 0; value -= 1) {
    if (remaining > histogram[value]) {
      remaining -= histogram[value];
      histogram[value] = 0;
    } else {
      histogram[value] -= remaining;
      remaining = 0;
    }
  }

  let low = 0;
  while (low < 255 && histogram[low] === 0) low += 1;
  let high = 255;
  while (high > 0 && histogram[high] === 0) high -= 1;
  if (high <= low) return Buffer.from(source);

  const scale = 255 / (high - low);
  const offset = -low * scale;
  const adjusted = Buffer.allocUnsafe(source.byteLength);
  for (let index = 0; index < source.byteLength; index += 1) {
    adjusted[index] = Math.max(
      0,
      Math.min(255, Math.trunc(source[index] * scale + offset)),
    );
  }
  return adjusted;
}

function pillowContrast(source: Buffer): Buffer {
  let sum = 0;
  for (const value of source) sum += value;
  const mean = Math.floor(sum / source.byteLength + 0.5);
  const adjusted = Buffer.allocUnsafe(source.byteLength);
  for (let index = 0; index < source.byteLength; index += 1) {
    adjusted[index] = clampByte(Math.floor(
      source[index] * PHOTO_CONTRAST + mean * (1 - PHOTO_CONTRAST),
    ));
  }
  return adjusted;
}

function pillowRadiusOneBoxPass(
  source: Buffer,
  width: number,
  height: number,
  horizontal: boolean,
): Buffer {
  const output = Buffer.allocUnsafe(source.byteLength);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const centreIndex = y * width + x;
      const beforeIndex = horizontal
        ? y * width + Math.max(0, x - 1)
        : Math.max(0, y - 1) * width + x;
      const afterIndex = horizontal
        ? y * width + Math.min(width - 1, x + 1)
        : Math.min(height - 1, y + 1) * width + x;
      const bulk = source[centreIndex] * PILLOW_BOX_CENTRE_WEIGHT
        + (source[beforeIndex] + source[afterIndex])
          * PILLOW_BOX_NEIGHBOUR_WEIGHT;
      output[centreIndex] = Math.floor(
        (bulk + PILLOW_BOX_ROUND) / PILLOW_BOX_SCALE,
      );
    }
  }
  return output;
}

function pillowUnsharpRadiusOne(source: Buffer, width: number, height: number): Buffer {
  let blurred = source;
  for (let pass = 0; pass < 3; pass += 1) {
    blurred = pillowRadiusOneBoxPass(blurred, width, height, true);
  }
  for (let pass = 0; pass < 3; pass += 1) {
    blurred = pillowRadiusOneBoxPass(blurred, width, height, false);
  }

  const sharpened = Buffer.allocUnsafe(source.byteLength);
  for (let offset = 0; offset < source.byteLength; offset += 1) {
    const difference = source[offset] - blurred[offset];
    sharpened[offset] = Math.abs(difference) > PHOTO_UNSHARP_THRESHOLD
      ? clampByte(
          source[offset] + Math.trunc(
            difference * PHOTO_UNSHARP_PERCENT / 100,
          ),
        )
      : source[offset];
  }
  return sharpened;
}

/**
 * Apply the exact post-geometry tonal stages used by process_images.py.
 * Exported to make the Python/TypeScript parity contract independently
 * testable without depending on image decoder or resampler implementations.
 */
export function enhancePaperS3SlideshowPhotoLuma(
  source: Buffer,
  width: number,
  height: number,
): Buffer {
  if (width <= 0 || height <= 0 || source.byteLength !== width * height) {
    throw new Error("PaperS3 photo luma geometry is invalid");
  }
  const contrasted = pillowContrast(pillowAutocontrast(source));
  return pillowUnsharpRadiusOne(contrasted, width, height);
}

function pythonRoundNonNegative(value: number): number {
  const lower = Math.floor(value);
  const fraction = value - lower;
  if (fraction < 0.5) return lower;
  if (fraction > 0.5) return lower + 1;
  return lower % 2 === 0 ? lower : lower + 1;
}

/**
 * Serpentine Floyd-Steinberg quantization equivalent to quantize_gray16() in
 * the slideshow processor. Error is diffused against the mathematical
 * 0,17,...,255 ramp; the encoded RGB byte is the M5GFX-stable centre
 * 8,24,...,248 for the selected level.
 */
export function ditherPaperS3SlideshowGray16ToStableRgb(
  source: Buffer,
  width: number,
  height: number,
): Buffer {
  if (width <= 0 || height <= 0 || source.byteLength !== width * height) {
    throw new Error("PaperS3 photo dither geometry is invalid");
  }

  let current = Float64Array.from(source.subarray(0, width));
  let next = new Float64Array(width);
  const output = Buffer.allocUnsafe(source.byteLength * 3);

  for (let y = 0; y < height; y += 1) {
    next = y + 1 < height
      ? Float64Array.from(source.subarray((y + 1) * width, (y + 2) * width))
      : new Float64Array(width);
    const direction = y % 2 === 0 ? 1 : -1;
    let x = direction === 1 ? 0 : width - 1;
    const end = direction === 1 ? width : -1;
    for (; x !== end; x += direction) {
      const old = Math.max(0, Math.min(255, current[x]));
      const level = Math.max(
        0,
        Math.min(15, pythonRoundNonNegative(old / 17)),
      );
      const quantized = level * 17;
      const encoded = 8 + level * 16;
      const outputOffset = (y * width + x) * 3;
      output[outputOffset] = encoded;
      output[outputOffset + 1] = encoded;
      output[outputOffset + 2] = encoded;
      const error = old - quantized;

      const neighbour = x + direction;
      if (neighbour >= 0 && neighbour < width) {
        current[neighbour] += error * 7 / 16;
      }
      if (y + 1 < height) {
        const back = x - direction;
        if (back >= 0 && back < width) next[back] += error * 3 / 16;
        next[x] += error * 5 / 16;
        if (neighbour >= 0 && neighbour < width) {
          next[neighbour] += error / 16;
        }
      }
    }
    current = next;
  }
  return output;
}

/**
 * Render an app image without entering RenderEngine or any e-paper raster
 * strategy. The manifest keeps the target PaperS3 profile fields so the
 * existing on-demand frame/sidecar lineage remains compatible. Photo intent
 * receives the proven slideshow autocontrast/contrast/unsharp/Floyd-Steinberg
 * pipeline and stable native-gray encoding. Map/graphic intent remains a
 * byte-preserving raw-colour diagnostic baseline after required geometry.
 */
export async function renderDiagnosticRawColourFrame(
  input: DiagnosticRawColourRenderInput,
): Promise<RenderedFrame> {
  const page = input.document.content.page;
  if (page.kind !== "image") {
    throw new Error("diagnostic raw-colour rendering requires an image page");
  }
  const resolution = await input.assetResolver.resolve(page.image);
  if (resolution.status !== "resolved") {
    throw new Error("diagnostic source image could not be resolved");
  }

  const profile = orientScreenProfile(
    getScreenProfile(input.profileId),
    input.displayMeta.orientation,
  );
  const source = decodeResolvedDataUri(resolution.image.dataUri);
  const decoded = sharp(source, {
    animated: false,
    failOn: "warning",
    limitInputPixels: MAX_RESOLVED_IMAGE_PIXELS,
  })
    .rotate()
    .flatten({ background: "#ffffff" });
  const mode = input.mode
    ?? diagnosticAppImageModeForRenderIntent(page.image.renderIntent);
  const prepared = mode === PHOTO_PAPERS3_SLIDESHOW_GRAY16_MODE
    ? decoded
        // The reference slideshow converts to L before its Lanczos cover fit.
        .greyscale()
        .resize(profile.logicalSize.width, profile.logicalSize.height, {
          fit: page.layout,
          position: "centre",
          background: { r: 255, g: 255, b: 255, alpha: 1 },
          kernel: sharp.kernel.lanczos3,
        })
        .removeAlpha()
    : decoded
        .resize(profile.logicalSize.width, profile.logicalSize.height, {
          fit: page.layout,
          position: "centre",
          background: { r: 255, g: 255, b: 255, alpha: 1 },
          kernel: sharp.kernel.lanczos3,
        })
        .toColourspace("srgb")
        .removeAlpha();

  const encoded = mode === PHOTO_PAPERS3_SLIDESHOW_GRAY16_MODE
    ? await (async () => {
        const raw = await prepared.raw().toBuffer({ resolveWithObject: true });
        if (
          raw.info.width !== profile.logicalSize.width
          || raw.info.height !== profile.logicalSize.height
          || raw.info.channels !== 1
        ) {
          throw new Error("diagnostic grayscale photo geometry or channels are invalid");
        }
        const enhanced = enhancePaperS3SlideshowPhotoLuma(
          raw.data,
          raw.info.width,
          raw.info.height,
        );
        const stableRgb = ditherPaperS3SlideshowGray16ToStableRgb(
          enhanced,
          raw.info.width,
          raw.info.height,
        );
        return sharp(stableRgb, {
          raw: {
            width: raw.info.width,
            height: raw.info.height,
            channels: 3,
          },
        })
          .png({ compressionLevel: 9, palette: false })
          .toBuffer({ resolveWithObject: true });
      })()
    : await prepared
        .png({ compressionLevel: 9, palette: false })
        .toBuffer({ resolveWithObject: true });
  const { data, info } = encoded;

  if (
    info.width !== profile.logicalSize.width
    || info.height !== profile.logicalSize.height
    || info.channels !== 3
  ) {
    throw new Error("diagnostic RGB PNG geometry or channels are invalid");
  }

  const sha256 = sha256Hex(data);
  const region = fullRegion(profile);
  return {
    payload: data,
    contentType: "image/png",
    warnings: [],
    manifest: {
      schemaVersion: "inkos.frame/v2",
      rendererVersion: rendererVersionForMode(mode),
      frameId: sha256.slice(0, 24),
      documentId: input.document.uuid,
      documentRevision: input.document.content.revision,
      contentType: "image",
      screenProfileId: profile.id,
      screenProfileVersion: profile.version,
      nativeSize: profile.nativeSize,
      logicalSize: profile.logicalSize,
      displayRotation: profile.displayRotation,
      pixelFormat: profile.pixelFormat,
      layoutStrategy: profile.layoutStrategy,
      rasterStrategy: profile.rasterStrategy,
      displayMeta: input.displayMeta,
      codec: "png",
      pagination: {
        pageIndex: 0,
        pageCount: 1,
        hasPrevious: false,
        hasNext: false,
      },
      update: { kind: "full", region },
      payloadBytes: data.byteLength,
      sha256,
      crc32: crc32Hex(data),
      interactions: [],
      warnings: [],
    },
  };
}
