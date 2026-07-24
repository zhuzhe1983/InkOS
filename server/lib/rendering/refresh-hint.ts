import { inflateSync } from "node:zlib";

import { collectContentImageOccurrences } from "./content-images";
import type {
  ContentDocument,
  FrameRefreshHint,
  ScreenProfile,
} from "./contracts";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PAPER_S3_PROFILE_ID = "m5stack-paper-s3-portrait";

/**
 * `epd_fast` reduces the decoded frame to black and white. Ordinary glyph
 * antialiasing therefore has to be tolerated, but a page with a material
 * continuous-gray area must stay on the quality waveform.
 */
export const MAXIMUM_BINARY_TEXT_INTERMEDIATE_RATIO = 0.08;

interface Gray4Histogram {
  width: number;
  height: number;
  counts: readonly number[];
}

function chunkType(payload: Buffer, offset: number): string {
  return payload.toString("ascii", offset + 4, offset + 8);
}

/**
 * Read only PNGs produced by `encodeGray4Png`.
 *
 * This avoids a second Sharp raster pass in the interactive render path. The
 * accepted format is deliberately narrow: non-indexed, interlaced, filtered,
 * differently-paletted or malformed PNGs simply receive no fast-refresh hint.
 */
export function inspectStableGray4Png(payload: Buffer): Gray4Histogram | undefined {
  if (
    payload.byteLength < PNG_SIGNATURE.byteLength
    || !payload.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)
  ) {
    return undefined;
  }

  let offset = PNG_SIGNATURE.byteLength;
  let width = 0;
  let height = 0;
  let validHeader = false;
  let validPalette = false;
  let sawEnd = false;
  const idatChunks: Buffer[] = [];

  while (offset + 12 <= payload.byteLength) {
    const length = payload.readUInt32BE(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > payload.byteLength) return undefined;
    const type = chunkType(payload, offset);
    const data = payload.subarray(dataStart, dataEnd);

    if (type === "IHDR") {
      if (validHeader || length !== 13) return undefined;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      validHeader = width > 0
        && height > 0
        && data[8] === 4
        && data[9] === 3
        && data[10] === 0
        && data[11] === 0
        && data[12] === 0;
    } else if (type === "PLTE") {
      if (length !== 16 * 3) return undefined;
      validPalette = true;
      for (let index = 0; index < 16; index += 1) {
        const expected = index * 16 + 8;
        const paletteOffset = index * 3;
        if (
          data[paletteOffset] !== expected
          || data[paletteOffset + 1] !== expected
          || data[paletteOffset + 2] !== expected
        ) {
          validPalette = false;
          break;
        }
      }
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      if (length !== 0) return undefined;
      sawEnd = true;
      break;
    }
    offset = chunkEnd;
  }

  if (!validHeader || !validPalette || !sawEnd || idatChunks.length === 0) {
    return undefined;
  }

  const bytesPerRow = Math.ceil(width / 2);
  const expectedBytes = (bytesPerRow + 1) * height;
  let scanlines: Buffer;
  try {
    scanlines = inflateSync(Buffer.concat(idatChunks), {
      maxOutputLength: expectedBytes,
    });
  } catch {
    return undefined;
  }
  if (scanlines.byteLength !== expectedBytes) return undefined;

  const counts = Array.from({ length: 16 }, () => 0);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (bytesPerRow + 1);
    // InkOS's encoder uses filter 0. Refuse arbitrary PNG filtering instead of
    // risking a histogram computed from still-filtered bytes.
    if (scanlines[rowOffset] !== 0) return undefined;
    for (let x = 0; x < width; x += 1) {
      const packed = scanlines[rowOffset + 1 + Math.floor(x / 2)];
      const index = x % 2 === 0 ? packed >> 4 : packed & 0x0f;
      counts[index] += 1;
    }
  }
  return { width, height, counts };
}

export function paperS3RefreshHint(input: {
  document: ContentDocument;
  profile: ScreenProfile;
  payload: Buffer;
}): FrameRefreshHint | undefined {
  const { document, profile, payload } = input;
  if (
    profile.id !== PAPER_S3_PROFILE_ID
    || profile.pixelFormat !== "gray4"
    || profile.rasterStrategy !== "eink-gray4-png-v1"
    || collectContentImageOccurrences(document).length !== 0
  ) {
    return undefined;
  }

  const histogram = inspectStableGray4Png(payload);
  if (
    !histogram
    || histogram.width !== profile.logicalSize.width
    || histogram.height !== profile.logicalSize.height
  ) {
    return undefined;
  }
  const pixelCount = histogram.width * histogram.height;
  const terminalCount = histogram.counts[0] + histogram.counts[15];
  const intermediateRatio = (pixelCount - terminalCount) / pixelCount;
  return intermediateRatio <= MAXIMUM_BINARY_TEXT_INTERMEDIATE_RATIO
    ? "binary-text"
    : undefined;
}
