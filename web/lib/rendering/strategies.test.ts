import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { getScreenProfile } from "./profiles";
import {
  EinkSpectra6PhotoDitherPngStrategy,
  EinkSpectra6PngStrategy,
  extractPhotoRects,
} from "./strategies";

const profile = getScreenProfile("m5stack-paper-color");
const region = { x: 0, y: 0, ...profile.logicalSize };
const displayMeta = { invert: false, fontLevel: 0, orientation: "portrait" } as const;

function photoDataUri(color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="600"><rect width="200" height="600" fill="${color}"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function comparisonSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600">
    <rect width="400" height="600" fill="#808080"/>
    <image data-ink-photo="true" x="0" y="0" width="200" height="600" href="${photoDataUri("#ff8000")}" preserveAspectRatio="none"/>
  </svg>`;
}

async function decode(payload: Buffer) {
  return sharp(payload).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
}

function regionColors(
  data: Buffer,
  channels: number,
  left: number,
  right: number,
): Set<string> {
  const colors = new Set<string>();
  for (let y = 0; y < 600; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * 400 + x) * channels;
      colors.add(data.subarray(offset, offset + 3).toString("hex"));
    }
  }
  return colors;
}

function averageGreen(data: Buffer, channels: number): number {
  let sum = 0;
  for (let y = 0; y < 600; y += 1) {
    for (let x = 0; x < 200; x += 1) {
      sum += data[(y * 400 + x) * channels + 1];
    }
  }
  return sum / (200 * 600);
}

describe("PaperColor photo dithering", () => {
  it("discovers renderer-owned photo regions without content coordinates", () => {
    expect(extractPhotoRects(comparisonSvg())).toEqual([
      { x: 0, y: 0, width: 200, height: 600 },
    ]);
  });

  it("uses serpentine error diffusion only inside image regions", async () => {
    const svg = comparisonSvg();
    const legacy = await new EinkSpectra6PngStrategy().render({
      svg,
      profile,
      region,
      displayMeta,
    });
    const dithered = await new EinkSpectra6PhotoDitherPngStrategy().render({
      svg,
      profile,
      region,
      displayMeta,
    });
    const legacyPixels = await decode(legacy);
    const ditheredPixels = await decode(dithered);
    const photoColors = regionColors(ditheredPixels.data, ditheredPixels.info.channels, 0, 200);
    const uiColors = regionColors(ditheredPixels.data, ditheredPixels.info.channels, 200, 400);
    const legacyGreenError = Math.abs(128 - averageGreen(
      legacyPixels.data,
      legacyPixels.info.channels,
    ));
    const ditheredGreenError = Math.abs(128 - averageGreen(
      ditheredPixels.data,
      ditheredPixels.info.channels,
    ));

    expect(photoColors.size).toBeGreaterThan(1);
    expect(uiColors.size).toBe(1);
    expect(ditheredGreenError).toBeLessThan(legacyGreenError);
  });

  it("is deterministic for package generation", async () => {
    const strategy = new EinkSpectra6PhotoDitherPngStrategy();
    const input = { svg: comparisonSvg(), profile, region, displayMeta };
    const [first, second] = await Promise.all([strategy.render(input), strategy.render(input)]);
    expect(first.equals(second)).toBe(true);
  });
});
