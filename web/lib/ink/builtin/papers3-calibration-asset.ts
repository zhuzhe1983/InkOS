import sharp from "sharp";

import {
  defaultAssetResolver,
  type AssetResolver,
  type ImageResolution,
  type ResolvedContentImage,
} from "../../rendering/asset-resolver";
import type { ContentImage } from "../../rendering/contracts";

export const PAPERS3_CALIBRATION_ASSET_ID = "builtin/papers3-native-calibration";
export const PAPERS3_CALIBRATION_WIDTH = 960;
export const PAPERS3_CALIBRATION_HEIGHT = 540;
export const PAPERS3_PORTRAIT_CALIBRATION_ASSET_ID =
  "builtin/papers3-portrait-native-calibration";
export const PAPERS3_PORTRAIT_CALIBRATION_WIDTH = 540;
export const PAPERS3_PORTRAIT_CALIBRATION_HEIGHT = 960;

const CHANNELS = 3 as const;
let calibrationImagePromise: Promise<ResolvedContentImage> | undefined;
let portraitCalibrationImagePromise: Promise<ResolvedContentImage> | undefined;

function setGray(pixels: Buffer, width: number, x: number, y: number, value: number): void {
  const offset = (y * width + x) * CHANNELS;
  pixels[offset] = value;
  pixels[offset + 1] = value;
  pixels[offset + 2] = value;
}

/**
 * Build one lossless, native-panel-size diagnostic image without network or
 * font dependencies. Its fixed regions exercise the complete 16-gray ramp,
 * sub-4-pixel detail, continuous tones and ordered-dither thresholds.
 */
export async function createPaperS3CalibrationPng(): Promise<Buffer> {
  const { width, height } = {
    width: PAPERS3_CALIBRATION_WIDTH,
    height: PAPERS3_CALIBRATION_HEIGHT,
  };
  const pixels = Buffer.alloc(width * height * CHANNELS, 255);

  for (let y = 0; y < 120; y += 1) {
    for (let x = 0; x < width; x += 1) {
      setGray(pixels, width, x, y, Math.floor(x / 60) * 17);
    }
  }

  for (let y = 120; y < 240; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const localX = x % 320;
      const scale = x < 320 ? 1 : x < 640 ? 2 : 4;
      const value = (Math.floor(localX / scale) + Math.floor((y - 120) / scale)) % 2 === 0
        ? 0
        : 255;
      setGray(pixels, width, x, y, value);
    }
  }

  for (let y = 240; y < 360; y += 1) {
    for (let x = 0; x < width; x += 1) {
      setGray(pixels, width, x, y, Math.round(x * 255 / (width - 1)));
    }
  }

  for (let y = 360; y < 480; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const patch = Math.floor(x / 60);
      setGray(pixels, width, x, y, Math.min(255, patch * 17 + 8));
    }
  }

  for (let y = 480; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let dark: boolean;
      if (x < 240) {
        dark = x % 2 === 0;
      } else if (x < 480) {
        dark = y % 2 === 0;
      } else if (x < 720) {
        dark = (x + y) % 2 === 0;
      } else {
        dark = (x + y) % 4 === 0 || (x - y) % 4 === 0;
      }
      setGray(pixels, width, x, y, dark ? 0 : 255);
    }
  }

  return sharp(pixels, { raw: { width, height, channels: CHANNELS } })
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
}

/** Native portrait companion for real-panel photographs and pixel inspection. */
export async function createPaperS3PortraitCalibrationPng(): Promise<Buffer> {
  const width = PAPERS3_PORTRAIT_CALIBRATION_WIDTH;
  const height = PAPERS3_PORTRAIT_CALIBRATION_HEIGHT;
  const pixels = Buffer.alloc(width * height * CHANNELS, 255);

  // Exact 16-gray ramp.
  for (let y = 0; y < 120; y += 1) {
    for (let x = 0; x < width; x += 1) {
      setGray(pixels, width, x, y, Math.min(255, Math.floor(x * 16 / width) * 17));
    }
  }

  // Native one-, two- and four-pixel checkerboards.
  for (let y = 120; y < 300; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const scale = x < 180 ? 1 : x < 360 ? 2 : 4;
      const localX = x % 180;
      const dark = (Math.floor(localX / scale) + Math.floor((y - 120) / scale)) % 2 === 0;
      setGray(pixels, width, x, y, dark ? 0 : 255);
    }
  }

  // Continuous ramp and half-step thresholds between the 16 panel levels.
  for (let y = 300; y < 480; y += 1) {
    for (let x = 0; x < width; x += 1) {
      setGray(pixels, width, x, y, Math.round(x * 255 / (width - 1)));
    }
  }
  for (let y = 480; y < 660; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const patch = Math.min(15, Math.floor(x * 16 / width));
      setGray(pixels, width, x, y, Math.min(255, patch * 17 + 8));
    }
  }

  // Vertical, horizontal and crossed 1/2/4 px line fields.
  for (let y = 660; y < 840; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const band = Math.floor(x / 180);
      const scale = band === 0 ? 1 : band === 1 ? 2 : 4;
      const localX = x % 180;
      const localY = y - 660;
      const dark = localX % (scale * 8) < scale
        || localY % (scale * 8) < scale
        || (localX + localY) % (scale * 12) < scale;
      setGray(pixels, width, x, y, dark ? 0 : 255);
    }
  }

  // A deterministic photo-like continuous-tone field. The gray4 renderer's
  // photo-only ordered dithering can be judged without a network image.
  for (let y = 840; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const horizontal = x / (width - 1);
      const vertical = (y - 840) / (height - 841);
      const wave = (Math.sin(x / 17) + Math.cos((x + y) / 29) + 2) / 4;
      const value = Math.round(255 * (horizontal * 0.5 + vertical * 0.25 + wave * 0.25));
      setGray(pixels, width, x, y, Math.max(0, Math.min(255, value)));
    }
  }

  return sharp(pixels, { raw: { width, height, channels: CHANNELS } })
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
}

async function calibrationImage(): Promise<ResolvedContentImage> {
  if (!calibrationImagePromise) {
    calibrationImagePromise = createPaperS3CalibrationPng().then((payload) => ({
      dataUri: `data:image/png;base64,${payload.toString("base64")}`,
      width: PAPERS3_CALIBRATION_WIDTH,
      height: PAPERS3_CALIBRATION_HEIGHT,
      mimeType: "image/png",
    }));
  }
  return calibrationImagePromise;
}

async function portraitCalibrationImage(): Promise<ResolvedContentImage> {
  if (!portraitCalibrationImagePromise) {
    portraitCalibrationImagePromise = createPaperS3PortraitCalibrationPng().then((payload) => ({
      dataUri: `data:image/png;base64,${payload.toString("base64")}`,
      width: PAPERS3_PORTRAIT_CALIBRATION_WIDTH,
      height: PAPERS3_PORTRAIT_CALIBRATION_HEIGHT,
      mimeType: "image/png",
    }));
  }
  return portraitCalibrationImagePromise;
}

export class PaperS3HomeAssetResolver implements AssetResolver {
  constructor(private readonly fallback: AssetResolver = defaultAssetResolver) {}

  async resolve(image: ContentImage): Promise<ImageResolution> {
    if (
      image.source.kind === "asset"
      && image.source.assetId === PAPERS3_CALIBRATION_ASSET_ID
    ) {
      return { status: "resolved", image: await calibrationImage() };
    }
    if (
      image.source.kind === "asset"
      && image.source.assetId === PAPERS3_PORTRAIT_CALIBRATION_ASSET_ID
    ) {
      return { status: "resolved", image: await portraitCalibrationImage() };
    }
    return this.fallback.resolve(image);
  }
}

export const paperS3HomeAssetResolver = new PaperS3HomeAssetResolver();
