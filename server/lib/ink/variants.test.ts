import { describe, expect, it } from "vitest";

import { createInkDisplayVariant } from "./package-builder";
import { findExactVariant, inkVariantId } from "./variants";

const base = { orientation: "portrait", invert: false, fontLevel: 0 } as const;

describe("raster-tuned ink variants", () => {
  it("preserves the legacy variant ID when output tuning is omitted", () => {
    expect(inkVariantId("m5stack-paper-s3-portrait", base)).toBe(
      "m5stack-paper-s3-portrait.portrait.normal.font-p0",
    );
  });

  it("gives distinct deterministic IDs to custom raster settings", () => {
    const first = inkVariantId("m5stack-paper-s3-portrait", {
      ...base,
      outputTuning: { gamma: 1.1, sharpen: 0.4 },
    });
    const second = inkVariantId("m5stack-paper-s3-portrait", {
      ...base,
      outputTuning: { gamma: 0.9, sharpen: 0.4 },
    });

    expect(first).toMatch(/\.tune-[a-f0-9]{8}$/u);
    expect(first).toBe(inkVariantId("m5stack-paper-s3-portrait", {
      ...base,
      outputTuning: { gamma: 1.1, sharpen: 0.4 },
    }));
    expect(second).not.toBe(first);
  });

  it("does not reuse a cached package variant rendered with different tuning", () => {
    const tuned = createInkDisplayVariant("m5stack-paper-s3-portrait", {
      ...base,
      outputTuning: { contrast: 1.3 },
    });
    const manifest = { variants: [tuned] } as Parameters<typeof findExactVariant>[0];

    expect(findExactVariant(manifest, "m5stack-paper-s3-portrait", tuned.displayMeta)).toBe(tuned);
    expect(findExactVariant(manifest, "m5stack-paper-s3-portrait", base)).toBeUndefined();
  });
});
