import { describe, expect, it } from "vitest";

import { encodeGray4Png } from "./gray4-output";
import {
  MAXIMUM_BINARY_TEXT_INTERMEDIATE_RATIO,
  inspectStableGray4Png,
  paperS3RefreshHint,
} from "./refresh-hint";
import { contentDocumentSchema } from "./contracts";
import { getScreenProfile } from "./profiles";

const profile = getScreenProfile("m5stack-paper-s3-portrait");
const textDocument = contentDocumentSchema.parse({
  schemaVersion: "inkos.content/v2",
  id: "10000000-0000-4000-8000-000000000001",
  revision: 1,
  locale: "zh-CN",
  page: {
    kind: "detail",
    layout: "article",
    title: "安全快速刷新",
    content: [{ type: "paragraph", text: "最终像素通过后才给出提示。" }],
  },
});

function gray4Frame(intermediatePixels: number): Buffer {
  const indexes = new Uint8Array(profile.logicalSize.width * profile.logicalSize.height);
  indexes.fill(15);
  indexes.fill(0, 0, 10_000);
  indexes.fill(7, 10_000, 10_000 + intermediatePixels);
  return encodeGray4Png(indexes, profile.logicalSize.width, profile.logicalSize.height);
}

describe("PaperS3 binary-text refresh hints", () => {
  it("inspects the final stable gray4 palette without re-rasterizing the PNG", () => {
    const payload = gray4Frame(321);
    const inspected = inspectStableGray4Png(payload);

    expect(inspected).toMatchObject({
      width: 540,
      height: 960,
    });
    expect(inspected?.counts[0]).toBe(10_000);
    expect(inspected?.counts[7]).toBe(321);
    expect(inspected?.counts[15]).toBe(540 * 960 - 10_321);
  });

  it("allows bounded glyph antialiasing but rejects material gray areas", () => {
    const pixelCount = profile.logicalSize.width * profile.logicalSize.height;
    const acceptedIntermediate = Math.floor(
      pixelCount * MAXIMUM_BINARY_TEXT_INTERMEDIATE_RATIO,
    );
    const rejectedIntermediate = acceptedIntermediate + 1;

    expect(paperS3RefreshHint({
      document: textDocument,
      profile,
      payload: gray4Frame(acceptedIntermediate),
    })).toBe("binary-text");
    expect(paperS3RefreshHint({
      document: textDocument,
      profile,
      payload: gray4Frame(rejectedIntermediate),
    })).toBeUndefined();
  });

  it("rejects semantic images even when their synthetic pixels happen to be binary", () => {
    const imageDocument = contentDocumentSchema.parse({
      schemaVersion: "inkos.content/v2",
      id: "10000000-0000-4000-8000-000000000002",
      revision: 1,
      locale: "zh-CN",
      page: {
        kind: "detail",
        layout: "article",
        title: "含图页面",
        content: [{
          type: "image",
          image: {
            source: { kind: "asset", assetId: "tests/binary-image" },
            alt: "即使图片碰巧只有黑白也不能走文字快速刷新",
          },
        }],
      },
    });

    expect(paperS3RefreshHint({
      document: imageDocument,
      profile,
      payload: gray4Frame(0),
    })).toBeUndefined();
  });

  it("fails closed for arbitrary or malformed PNG input", () => {
    expect(inspectStableGray4Png(Buffer.from("not a PNG"))).toBeUndefined();
    expect(paperS3RefreshHint({
      document: textDocument,
      profile,
      payload: Buffer.from("not a PNG"),
    })).toBeUndefined();
  });
});
