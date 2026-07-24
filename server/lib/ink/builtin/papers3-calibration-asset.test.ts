import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  createPaperS3CalibrationPng,
  createPaperS3PortraitCalibrationPng,
  PAPERS3_CALIBRATION_ASSET_ID,
  PAPERS3_CALIBRATION_HEIGHT,
  PAPERS3_CALIBRATION_WIDTH,
  PAPERS3_PORTRAIT_CALIBRATION_ASSET_ID,
  PAPERS3_PORTRAIT_CALIBRATION_HEIGHT,
  PAPERS3_PORTRAIT_CALIBRATION_WIDTH,
  paperS3HomeAssetResolver,
} from "./papers3-calibration-asset";

describe("PaperS3 native calibration asset", () => {
  it("is a deterministic lossless 960x540 image with exact diagnostic samples", async () => {
    const first = await createPaperS3CalibrationPng();
    const second = await createPaperS3CalibrationPng();
    expect(second).toEqual(first);

    const decoded = await sharp(first).raw().toBuffer({ resolveWithObject: true });
    expect(decoded.info).toMatchObject({
      width: PAPERS3_CALIBRATION_WIDTH,
      height: PAPERS3_CALIBRATION_HEIGHT,
      channels: 3,
    });
    const gray = (x: number, y: number) =>
      decoded.data[(y * decoded.info.width + x) * decoded.info.channels];

    expect(Array.from({ length: 16 }, (_unused, index) => gray(index * 60 + 30, 60)))
      .toEqual(Array.from({ length: 16 }, (_unused, index) => index * 17));
    expect([gray(0, 120), gray(1, 120), gray(2, 120)]).toEqual([0, 255, 0]);
    expect([gray(320, 120), gray(321, 120), gray(322, 120)]).toEqual([0, 0, 255]);
    expect([gray(640, 120), gray(643, 120), gray(644, 120)]).toEqual([0, 0, 255]);
    expect([gray(0, 300), gray(959, 300)]).toEqual([0, 255]);
    expect([gray(30, 400), gray(90, 400), gray(930, 400)]).toEqual([8, 25, 255]);
  });

  it("resolves only the bundled calibration asset without a network request", async () => {
    const result = await paperS3HomeAssetResolver.resolve({
      source: { kind: "asset", assetId: PAPERS3_CALIBRATION_ASSET_ID },
      alt: "PaperS3 calibration",
    });
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error("Expected calibration asset");
    expect(result.image).toMatchObject({
      width: 960,
      height: 540,
      mimeType: "image/png",
    });
    expect(result.image.dataUri).toMatch(/^data:image\/png;base64,/u);
  });

  it("provides a deterministic native 540x960 portrait pixel target", async () => {
    const payload = await createPaperS3PortraitCalibrationPng();
    expect(await createPaperS3PortraitCalibrationPng()).toEqual(payload);
    const decoded = await sharp(payload).raw().toBuffer({ resolveWithObject: true });
    expect(decoded.info).toMatchObject({
      width: PAPERS3_PORTRAIT_CALIBRATION_WIDTH,
      height: PAPERS3_PORTRAIT_CALIBRATION_HEIGHT,
      channels: 3,
    });
    const gray = (x: number, y: number) =>
      decoded.data[(y * decoded.info.width + x) * decoded.info.channels];
    expect(Array.from({ length: 16 }, (_unused, index) =>
      gray(Math.floor((index + 0.5) * 540 / 16), 60)
    )).toEqual(Array.from({ length: 16 }, (_unused, index) => index * 17));
    expect([gray(0, 120), gray(1, 120), gray(2, 120)]).toEqual([0, 255, 0]);
    expect([gray(180, 120), gray(181, 120), gray(182, 120)]).toEqual([0, 0, 255]);
    expect([gray(360, 120), gray(363, 120), gray(364, 120)]).toEqual([0, 0, 255]);
    expect([gray(0, 360), gray(539, 360)]).toEqual([0, 255]);

    const resolved = await paperS3HomeAssetResolver.resolve({
      source: { kind: "asset", assetId: PAPERS3_PORTRAIT_CALIBRATION_ASSET_ID },
      alt: "PaperS3 portrait calibration",
    });
    expect(resolved).toMatchObject({
      status: "resolved",
      image: { width: 540, height: 960, mimeType: "image/png" },
    });
  });
});
