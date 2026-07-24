import { describe, expect, it } from "vitest";

import type { LoadedInkCatalogPackage } from "./catalog-store";
import { packagedDocument } from "./contracts";
import { PAPERS3_CALIBRATION_ASSET_ID } from "./builtin/papers3-calibration-asset";
import { PAPERS3_HOME_PACKAGE_ID } from "./builtin/papers3-home-identity";
import { createInkDisplayVariant } from "./package-builder";
import { InkPackageRenderRuntime } from "./package-renderer";

const CALIBRATION_DOCUMENT_UUID = "9221d29a-8bb3-51d8-9dc0-133065d4180f";

function loadedCalibrationPackage(): LoadedInkCatalogPackage {
  const document = packagedDocument({
    uuid: CALIBRATION_DOCUMENT_UUID,
    source: { title: "原生像素测试 · 满屏裁剪" },
    content: {
      schemaVersion: "inkos.content/v2",
      id: CALIBRATION_DOCUMENT_UUID,
      revision: 1,
      locale: "zh-CN",
      page: {
        kind: "image",
        layout: "cover",
        image: {
          source: { kind: "asset", assetId: PAPERS3_CALIBRATION_ASSET_ID },
          alt: "原生像素灰阶测试图",
        },
      },
    },
  });
  const variant = createInkDisplayVariant("m5stack-paper-s3-portrait", {
    orientation: "portrait",
    fontLevel: 0,
    invert: false,
  });
  const manifest = {
    packageId: PAPERS3_HOME_PACKAGE_ID,
    revision: 1,
    entryUuid: CALIBRATION_DOCUMENT_UUID,
    variants: [variant],
    documents: [{ uuid: CALIBRATION_DOCUMENT_UUID }],
  };
  return {
    manifest,
    contents: {
      manifest,
      documents: new Map([[document.uuid, document]]),
      sidecars: new Map(),
      files: new Map(),
    },
    archive: new Uint8Array([1]),
    archiveSha256: "a".repeat(64),
    manifestSha256: "b".repeat(64),
    fileName: "papers3-home.ink",
  } as unknown as LoadedInkCatalogPackage;
}

describe("PaperS3 home on-demand rendering", () => {
  it("keeps the bundled native image available at normal polarity and rejects inverse requests", async () => {
    const runtime = new InkPackageRenderRuntime();
    const loaded = loadedCalibrationPackage();
    const normal = await runtime.render(loaded, {
      documentUuid: CALIBRATION_DOCUMENT_UUID,
      displayMeta: { orientation: "portrait", fontLevel: 0, invert: false },
      pageIndex: 0,
    });
    expect(normal.frame.warnings).toEqual([]);
    expect(normal.sidecar.documentUuid).toBe(CALIBRATION_DOCUMENT_UUID);
    await expect(runtime.render(loaded, {
      documentUuid: CALIBRATION_DOCUMENT_UUID,
      displayMeta: { orientation: "portrait", fontLevel: 0, invert: true },
      pageIndex: 0,
    })).rejects.toThrow(/invert is no longer supported/u);
  });
});
