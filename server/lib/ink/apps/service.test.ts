import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";

import type { AssetResolver } from "../../rendering/asset-resolver";
import { sha256Hex } from "../../rendering/checksum";
import type { RenderedFrame } from "../../rendering/contracts";
import { getScreenProfile, orientScreenProfile } from "../../rendering/profiles";
import {
  DEFAULT_RANDOM_IMAGE_COLLECTION_URL,
  LEGACY_GRAYSCALE_RANDOM_IMAGE_COLLECTION_URL,
  appExecuteRequestSchema,
} from "../service-contracts";
import {
  APP_DOCUMENT_UUIDS,
  BAIDU_MAP_ACTION,
  InkAppServiceError,
  RANDOM_IMAGE_ACTION,
  executeInkApp,
  mapBaiduMapPixelToGray,
  type InkAppServiceDependencies,
} from "./service";
import {
  DIAGNOSTIC_RAW_COLOUR_MODE,
  DIAGNOSTIC_RAW_COLOUR_RENDERER_VERSION,
  PHOTO_PAPERS3_SLIDESHOW_GRAY16_MODE,
  PHOTO_PAPERS3_SLIDESHOW_GRAY16_RENDERER_VERSION,
} from "./diagnostic-raw-colour";

const NONCE = "0123456789abcdef";
const REQUESTED_AT = 1_784_352_000_123;

function pngHeader(payload: Buffer): {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
} {
  expect(payload.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  expect(payload.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return {
    width: payload.readUInt32BE(16),
    height: payload.readUInt32BE(20),
    bitDepth: payload[24],
    colorType: payload[25],
  };
}

function pngChunkTypes(payload: Buffer): string[] {
  const types: string[] = [];
  let offset = 8;
  while (offset + 12 <= payload.byteLength) {
    const length = payload.readUInt32BE(offset);
    types.push(payload.subarray(offset + 4, offset + 8).toString("ascii"));
    offset += length + 12;
  }
  return types;
}

async function colourFixture(width: number, height: number): Promise<{
  png: Buffer;
  pixels: Buffer;
}> {
  const pixels = Buffer.allocUnsafe(width * height * 3);
  const colours = [
    [12, 210, 45],
    [241, 31, 163],
    [27, 73, 232],
    [252, 183, 17],
  ] as const;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const colour = colours[
        Math.min(colours.length - 1, Math.floor(x * colours.length / width))
      ];
      const offset = (y * width + x) * 3;
      pixels[offset] = colour[0];
      pixels[offset + 1] = colour[1];
      pixels[offset + 2] = colour[2];
    }
  }
  return {
    pixels,
    png: await sharp(pixels, { raw: { width, height, channels: 3 } })
      .png({ palette: false })
      .toBuffer(),
  };
}

function fixtureResolver(png: Buffer, width: number, height: number): AssetResolver {
  return {
    resolve: vi.fn(async () => ({
      status: "resolved" as const,
      image: {
        dataUri: `data:image/png;base64,${png.toString("base64")}`,
        width,
        height,
        mimeType: "image/png" as const,
      },
    })),
  };
}

function fixtureFrame(
  input: Parameters<NonNullable<InkAppServiceDependencies["render"]>>[0],
): RenderedFrame {
  const profile = orientScreenProfile(
    getScreenProfile("m5stack-paper-s3-portrait"),
    input.displayMeta.orientation,
  );
  const payload = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const sha256 = sha256Hex(payload);
  return {
    payload,
    contentType: "image/png",
    warnings: [],
    manifest: {
      schemaVersion: "inkos.frame/v2",
      rendererVersion: "inkos-renderer/test",
      frameId: sha256.slice(0, 24),
      documentId: input.document.uuid,
      documentRevision: input.document.content.revision,
      contentType: "image",
      screenProfileId: profile.id,
      screenProfileVersion: profile.version,
      nativeSize: profile.nativeSize,
      logicalSize: profile.logicalSize,
      displayRotation: profile.displayRotation,
      pixelFormat: "gray4",
      layoutStrategy: "paper-s3-semantic-v1",
      rasterStrategy: "eink-gray4-png-v1",
      displayMeta: input.displayMeta,
      codec: "png",
      pagination: {
        pageIndex: 0,
        pageCount: 1,
        hasPrevious: false,
        hasNext: false,
      },
      update: { kind: "full", region: { x: 0, y: 0, ...profile.logicalSize } },
      payloadBytes: payload.byteLength,
      sha256,
      crc32: "00000000",
      interactions: [],
      warnings: [],
    },
  };
}

describe("server-owned PaperS3 applications", () => {
  it("accepts only the two exact action URLs and bounded client identity", () => {
    for (const action of [RANDOM_IMAGE_ACTION, BAIDU_MAP_ACTION]) {
      expect(appExecuteRequestSchema.safeParse({
        action,
        nonce: NONCE,
        requestedAtUnixMs: REQUESTED_AT,
      }).success).toBe(true);
    }
    for (const action of [
      "inkos://app/random-image/",
      "inkos://app/baidu-map?zoom=1",
      "inkos://app/settings",
      "https://picsum.photos/540/960",
    ]) {
      expect(appExecuteRequestSchema.safeParse({
        action,
        nonce: NONCE,
        requestedAtUnixMs: REQUESTED_AT,
      }).success).toBe(false);
    }
  });

  it("uses an editable HTTPS default while accepting only the retired exact alias", () => {
    const parsed = appExecuteRequestSchema.parse({
      action: RANDOM_IMAGE_ACTION,
      nonce: NONCE,
      requestedAtUnixMs: REQUESTED_AT,
    });
    expect(parsed.images).toEqual([{
      id: "random",
      label: "随机图片",
      url: DEFAULT_RANDOM_IMAGE_COLLECTION_URL,
    }]);
    expect(appExecuteRequestSchema.safeParse({
      action: RANDOM_IMAGE_ACTION,
      nonce: NONCE,
      requestedAtUnixMs: REQUESTED_AT,
      images: [{ id: "retired", label: "旧占位", url: RANDOM_IMAGE_ACTION }],
    }).success).toBe(true);
    expect(DEFAULT_RANDOM_IMAGE_COLLECTION_URL).not.toContain("grayscale");
    expect(LEGACY_GRAYSCALE_RANDOM_IMAGE_COLLECTION_URL).toContain("grayscale");
    expect(appExecuteRequestSchema.safeParse({
      action: RANDOM_IMAGE_ACTION,
      nonce: NONCE,
      requestedAtUnixMs: REQUESTED_AT,
      images: [{ id: "unsafe", label: "错误动作", url: "inkos://app/baidu-map" }],
    }).success).toBe(false);
  });

  it("uses every random-image nonce in the exact server-side Picsum request", async () => {
    const render = vi.fn(async (input) => fixtureFrame(input));
    const first = await executeInkApp({
      action: RANDOM_IMAGE_ACTION,
      nonce: NONCE,
      requestedAtUnixMs: REQUESTED_AT,
    }, { render });
    const second = await executeInkApp({
      action: RANDOM_IMAGE_ACTION,
      nonce: "fedcba9876543210",
      requestedAtUnixMs: REQUESTED_AT + 1,
    }, { render });
    const legacy = await executeInkApp({
      action: RANDOM_IMAGE_ACTION,
      nonce: "legacyrandom0001",
      requestedAtUnixMs: REQUESTED_AT + 2,
      images: [{ id: "retired", label: "旧随机项", url: RANDOM_IMAGE_ACTION }],
    }, { render });
    const legacyGray = await executeInkApp({
      action: RANDOM_IMAGE_ACTION,
      nonce: "legacygray000001",
      requestedAtUnixMs: REQUESTED_AT + 3,
      images: [{
        id: "legacy-gray",
        label: "旧灰度默认",
        url: LEGACY_GRAYSCALE_RANDOM_IMAGE_COLLECTION_URL,
      }],
    }, { render });
    const firstPage = first.document.content.page;
    const secondPage = second.document.content.page;
    const legacyPage = legacy.document.content.page;
    const legacyGrayPage = legacyGray.document.content.page;

    expect(firstPage.kind).toBe("image");
    expect(secondPage.kind).toBe("image");
    if (
      firstPage.kind !== "image"
      || secondPage.kind !== "image"
      || legacyPage.kind !== "image"
      || legacyGrayPage.kind !== "image"
    ) return;
    expect(firstPage.layout).toBe("cover");
    expect(firstPage.image.renderIntent).toBe("photo");
    expect(firstPage.image.source).toEqual({
      kind: "remote",
      url: `https://picsum.photos/540/960?random=${NONCE}`,
    });
    expect(secondPage.image.source).not.toEqual(firstPage.image.source);
    expect(legacyPage.image.source).toEqual({
      kind: "remote",
      url: "https://picsum.photos/540/960?random=legacyrandom0001",
    });
    expect(legacyGrayPage.image.source).toEqual({
      kind: "remote",
      url: "https://picsum.photos/540/960?random=legacygray000001",
    });
    expect(first.document.uuid).toBe(APP_DOCUMENT_UUIDS[RANDOM_IMAGE_ACTION]);
    expect(first.document.content.revision).not.toBe(second.document.content.revision);
    expect(first.sidecar.imagePath).toContain(`/random-image/${NONCE}/`);
  });

  it("does not rewrite a user-authored grayscale URL that is not the exact legacy default", async () => {
    const render = vi.fn(async (input) => fixtureFrame(input));
    const custom = "https://picsum.photos/id/42/540/960?grayscale";
    const result = await executeInkApp({
      action: RANDOM_IMAGE_ACTION,
      nonce: NONCE,
      requestedAtUnixMs: REQUESTED_AT,
      images: [{ id: "custom-gray", label: "自定义灰度", url: custom }],
    }, { render });
    const page = result.document.content.page;
    expect(page.kind).toBe("image");
    if (page.kind !== "image" || page.image.source.kind !== "remote") return;
    expect(page.image.source.url).toBe(custom);
  });

  it("renders the ordered device image collection as one server-fetched URL per page", async () => {
    const images = [
      { id: "fixed", label: "固定照片", url: "https://images.example/photo.jpg" },
      { id: "random", label: "随机照片", url: DEFAULT_RANDOM_IMAGE_COLLECTION_URL },
    ];
    const captured: Array<Parameters<NonNullable<InkAppServiceDependencies["render"]>>[0]> = [];
    const render = vi.fn(async (input) => {
      captured.push(input);
      return fixtureFrame(input);
    });
    const first = await executeInkApp({
      action: RANDOM_IMAGE_ACTION,
      nonce: NONCE,
      requestedAtUnixMs: REQUESTED_AT,
      images,
      pageIndex: 0,
    }, { render });
    const second = await executeInkApp({
      action: RANDOM_IMAGE_ACTION,
      nonce: NONCE,
      requestedAtUnixMs: REQUESTED_AT,
      images,
      pageIndex: 1,
    }, { render });
    const firstPage = first.document.content.page;
    const secondPage = second.document.content.page;
    if (
      firstPage.kind !== "image"
      || secondPage.kind !== "image"
      || firstPage.image.source.kind !== "remote"
      || secondPage.image.source.kind !== "remote"
    ) return;
    expect(firstPage.image.source.url).toBe("https://images.example/photo.jpg");
    expect(secondPage.image.source.url).toBe(
      `https://picsum.photos/540/960?random=${NONCE}`,
    );
    expect(captured[0]).toMatchObject({
      allowedSourceHosts: ["images.example"],
      allowPublicRedirectHosts: true,
    });
    expect(first.frame.manifest.pagination).toEqual({
      pageIndex: 0,
      pageCount: 2,
      hasPrevious: false,
      hasNext: true,
    });
    expect(second.frame.manifest.pagination).toEqual({
      pageIndex: 1,
      pageCount: 2,
      hasPrevious: true,
      hasNext: false,
    });
    expect(first.sidecar.pageCount).toBe(2);
    expect(second.sidecar.imagePath).toMatch(/\/0001\.png$/u);
    expect(first.document.content.revision).toBe(second.document.content.revision);
  });

  it("returns only PaperS3 slideshow-dithered stable-gray RGB despite gray4 tuning", async () => {
    const source = await colourFixture(540, 960);
    const resolver = fixtureResolver(source.png, 540, 960);
    const base = {
      action: RANDOM_IMAGE_ACTION,
      nonce: NONCE,
      requestedAtUnixMs: REQUESTED_AT,
    } as const;
    const baseline = await executeInkApp(base, { assetResolver: resolver });
    const aggressive = await executeInkApp({
      ...base,
      displayMeta: {
        outputTuning: {
          gamma: 0.5,
          contrast: 2.5,
          blackPoint: 96,
          whitePoint: 160,
          sharpen: 2,
          photoContrast: 2.5,
          quantization: "photo-ordered-16",
          supersampling: 2,
        },
      },
    }, { assetResolver: resolver });

    expect(pngHeader(baseline.frame.payload)).toEqual({
      width: 540,
      height: 960,
      bitDepth: 8,
      colorType: 2,
    });
    expect(pngChunkTypes(baseline.frame.payload)).not.toContain("PLTE");
    expect(baseline.frame.manifest.rendererVersion)
      .toBe(PHOTO_PAPERS3_SLIDESHOW_GRAY16_RENDERER_VERSION);
    expect(baseline.imageMode).toBe(PHOTO_PAPERS3_SLIDESHOW_GRAY16_MODE);
    expect(aggressive.frame.payload).toEqual(baseline.frame.payload);

    const decoded = await sharp(baseline.frame.payload)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(decoded.info.channels).toBe(3);
    const stableCentres = new Set(
      Array.from({ length: 16 }, (_, level) => 8 + level * 16),
    );
    let isNeutralGray = true;
    let usesOnlyStableCentres = true;
    for (let offset = 0; offset < decoded.data.byteLength; offset += 3) {
      isNeutralGray &&= decoded.data[offset + 1] === decoded.data[offset]
        && decoded.data[offset + 2] === decoded.data[offset];
      usesOnlyStableCentres &&= stableCentres.has(decoded.data[offset]);
    }
    expect(isNeutralGray).toBe(true);
    expect(usesOnlyStableCentres).toBe(true);

    const sourceLumas = Array.from(
      { length: source.pixels.byteLength / 3 },
      (_, pixel) => {
        const offset = pixel * 3;
        return (
          77 * source.pixels[offset]
          + 151 * source.pixels[offset + 1]
          + 29 * source.pixels[offset + 2]
        ) >> 8;
      },
    );
    const outputLumas = Array.from(
      { length: decoded.data.byteLength / 3 },
      (_, pixel) => decoded.data[pixel * 3],
    );
    const mean = (values: number[]) => {
      return values.reduce((sum, value) => sum + value, 0) / values.length;
    };
    const standardDeviation = (values: number[]) => {
      const average = mean(values);
      return Math.sqrt(
        values.reduce((sum, value) => sum + (value - average) ** 2, 0)
        / values.length,
      );
    };
    expect(Math.abs(mean(outputLumas) - mean(sourceLumas))).toBeLessThan(48);
    expect(standardDeviation(outputLumas))
      .toBeGreaterThan(standardDeviation(sourceLumas) * 2);
    expect(standardDeviation(outputLumas)).toBeLessThan(110);
    expect(new Set(outputLumas).size).toBeGreaterThanOrEqual(4);
  });

  it("offers an explicit raw-colour baseline for Image Viewer without changing its default", async () => {
    const source = await colourFixture(540, 960);
    const resolver = fixtureResolver(source.png, 540, 960);
    const request = {
      action: RANDOM_IMAGE_ACTION,
      nonce: NONCE,
      requestedAtUnixMs: REQUESTED_AT,
    } as const;
    const optimized = await executeInkApp(request, { assetResolver: resolver });
    const raw = await executeInkApp({
      ...request,
      imageProcessing: "diagnostic-raw-colour",
    }, { assetResolver: resolver });

    expect(optimized.imageMode).toBe(PHOTO_PAPERS3_SLIDESHOW_GRAY16_MODE);
    expect(raw.imageMode).toBe(DIAGNOSTIC_RAW_COLOUR_MODE);
    expect(raw.frame.manifest.rendererVersion)
      .toBe(DIAGNOSTIC_RAW_COLOUR_RENDERER_VERSION);
    expect(pngHeader(raw.frame.payload)).toEqual({
      width: 540,
      height: 960,
      bitDepth: 8,
      colorType: 2,
    });
    const decoded = await sharp(raw.frame.payload).raw().toBuffer();
    expect(decoded).toEqual(source.pixels);
    expect(raw.frame.payload).not.toEqual(optimized.frame.payload);
    expect(raw.document.content.revision)
      .not.toBe(optimized.document.content.revision);
  });

  it("rejects gallery pages outside the device image collection", () => {
    expect(appExecuteRequestSchema.safeParse({
      action: RANDOM_IMAGE_ACTION,
      nonce: NONCE,
      requestedAtUnixMs: REQUESTED_AT,
      images: [{ id: "only", label: "一张", url: "https://example.com/a.png" }],
      pageIndex: 1,
    }).success).toBe(false);
  });

  it("gets a BD-09 location server-side and renders a contain map at the exact orientation", async () => {
    const upstreamUrls: URL[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      upstreamUrls.push(new URL(String(input)));
      return Response.json({ status: 0, content: { point: { x: "116.404", y: "39.915" } } });
    });
    let captured: Parameters<NonNullable<InkAppServiceDependencies["render"]>>[0] | undefined;
    const result = await executeInkApp({
      action: BAIDU_MAP_ACTION,
      nonce: NONCE,
      requestedAtUnixMs: REQUESTED_AT,
      displayMeta: { orientation: "landscape" },
    }, {
      baiduMapAk: "x".repeat(24),
      fetch: fetcher,
      render: async (input) => {
        captured = input;
        return fixtureFrame(input);
      },
    });
    const page = result.document.content.page;

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(upstreamUrls[0].origin + upstreamUrls[0].pathname).toBe(
      "https://api.map.baidu.com/location/ip",
    );
    expect(upstreamUrls[0].searchParams.get("coor")).toBe("bd09ll");
    expect(page.kind).toBe("image");
    if (page.kind !== "image" || page.image.source.kind !== "remote") return;
    const mapUrl = new URL(page.image.source.url);
    expect(page.layout).toBe("contain");
    expect(mapUrl.origin + mapUrl.pathname).toBe("https://api.map.baidu.com/staticimage/v2");
    expect(mapUrl.searchParams.get("width")).toBe("480");
    expect(mapUrl.searchParams.get("height")).toBe("270");
    expect(mapUrl.searchParams.get("center")).toBe("116.404000,39.915000");
    expect(mapUrl.searchParams.get("markers")).toBe("116.404000,39.915000");
    expect(mapUrl.searchParams.get("scale")).toBe("2");
    expect(mapUrl.searchParams.get("zoom")).toBe("17");
    expect(mapUrl.searchParams.get("markerStyles")).toBe("l,P,0x000000");
    expect(mapUrl.searchParams.get("copyright")).toBe("1");
    expect(page.image.renderIntent).toBe("map");
    expect(captured?.allowedSourceHosts).toEqual(["api.map.baidu.com"]);
    expect(captured?.mapStyle).toBe("eink");
    expect(result.document.uuid).toBe(APP_DOCUMENT_UUIDS[BAIDU_MAP_ACTION]);
  });

  it("keeps e-ink map tone styles in server-owned request identity", async () => {
    const fetcher = vi.fn(async () => Response.json({
      status: 0,
      content: { point: { x: "120.1551", y: "30.2741" } },
    }));
    const captured: string[] = [];
    const render = vi.fn(async (input: Parameters<
      NonNullable<InkAppServiceDependencies["render"]>
    >[0]) => {
      captured.push(input.mapStyle ?? "none");
      return fixtureFrame(input);
    });
    const base = {
      action: BAIDU_MAP_ACTION,
      nonce: NONCE,
      requestedAtUnixMs: REQUESTED_AT,
    } as const;
    const eink = await executeInkApp(base, {
      baiduMapAk: "x".repeat(24), fetch: fetcher, render,
    });
    const detail = await executeInkApp({ ...base, mapStyle: "detail" }, {
      baiduMapAk: "x".repeat(24), fetch: fetcher, render,
    });

    expect(captured).toEqual(["eink", "detail"]);
    expect(eink.document.content.revision).not.toBe(detail.document.content.revision);
  });

  it("keeps raw map RGB pixels identical across legacy tone-style identities", async () => {
    const source = await colourFixture(960, 540);
    const resolver = fixtureResolver(source.png, 960, 540);
    const fetcher = vi.fn(async () => Response.json({
      status: 0,
      content: { point: { x: "120.1551", y: "30.2741" } },
    }));
    const base = {
      action: BAIDU_MAP_ACTION,
      nonce: NONCE,
      requestedAtUnixMs: REQUESTED_AT,
      displayMeta: { orientation: "landscape" as const },
    };
    const eink = await executeInkApp(base, {
      baiduMapAk: "x".repeat(24),
      fetch: fetcher,
      assetResolver: resolver,
    });
    const detail = await executeInkApp({
      ...base,
      mapStyle: "detail",
      imageProcessing: "diagnostic-raw-colour",
    }, {
      baiduMapAk: "x".repeat(24),
      fetch: fetcher,
      assetResolver: resolver,
    });

    expect(pngHeader(eink.frame.payload)).toEqual({
      width: 960,
      height: 540,
      bitDepth: 8,
      colorType: 2,
    });
    expect(pngChunkTypes(eink.frame.payload)).not.toContain("PLTE");
    expect(eink.frame.manifest.rendererVersion)
      .toBe(DIAGNOSTIC_RAW_COLOUR_RENDERER_VERSION);
    expect(detail.frame.payload).toEqual(eink.frame.payload);
    expect(detail.imageMode).toBe(DIAGNOSTIC_RAW_COLOUR_MODE);
    expect(eink.imageMode).not.toBe(PHOTO_PAPERS3_SLIDESHOW_GRAY16_MODE);
    const decoded = await sharp(eink.frame.payload).raw().toBuffer();
    expect(decoded).toEqual(source.pixels);
  });

  it("retains only the required cover/contain geometry in diagnostic mode", async () => {
    const colour = [19, 141, 223] as const;
    const square = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 3,
        background: { r: colour[0], g: colour[1], b: colour[2] },
      },
    }).png({ palette: false }).toBuffer();
    const resolver = fixtureResolver(square, 32, 32);
    const photo = await executeInkApp({
      action: RANDOM_IMAGE_ACTION,
      nonce: NONCE,
      requestedAtUnixMs: REQUESTED_AT,
    }, { assetResolver: resolver });
    const map = await executeInkApp({
      action: BAIDU_MAP_ACTION,
      nonce: NONCE,
      requestedAtUnixMs: REQUESTED_AT,
      displayMeta: { orientation: "landscape" },
    }, {
      baiduMapAk: "x".repeat(24),
      fetch: async () => Response.json({
        status: 0,
        content: { point: { x: "120.1551", y: "30.2741" } },
      }),
      assetResolver: resolver,
    });
    const photoPixels = await sharp(photo.frame.payload).raw().toBuffer();
    const mapPixels = await sharp(map.frame.payload).raw().toBuffer();
    const pixel = (pixels: Buffer, width: number, x: number, y: number) => {
      const offset = (y * width + x) * 3;
      return [...pixels.subarray(offset, offset + 3)];
    };

    // Cover fills every corner with stable neutral gray. Floyd-Steinberg may
    // select either adjacent native level for an otherwise uniform source.
    const stableCentres = new Set(
      Array.from({ length: 16 }, (_, level) => 8 + level * 16),
    );
    for (const corner of [
      pixel(photoPixels, 540, 0, 0),
      pixel(photoPixels, 540, 539, 959),
    ]) {
      expect(corner[1]).toBe(corner[0]);
      expect(corner[2]).toBe(corner[0]);
      expect(stableCentres.has(corner[0])).toBe(true);
    }
    // Contain centers the source on white.
    expect(pixel(mapPixels, 960, 0, 270)).toEqual([255, 255, 255]);
    expect(pixel(mapPixels, 960, 480, 270)).toEqual([...colour]);
    expect(pixel(mapPixels, 960, 959, 270)).toEqual([255, 255, 255]);
  });

  it("keeps the neutral canvas white while separating roads, fills, and text by map style", () => {
    const styles = ["eink", "detail", "balanced"] as const;

    // Baidu's two dominant neutral canvas colours must stay panel white.
    for (const style of styles) {
      expect(mapBaiduMapPixelToGray(style, 237, 237, 237)).toBe(255);
      expect(mapBaiduMapPixelToGray(style, 245, 243, 240)).toBe(255);
    }

    // Pale neutral boundaries and yellow roads are pulled below the final
    // renderer's white shoulder. E-ink is the strongest, balanced the mildest.
    const boundary = styles.map((style) => mapBaiduMapPixelToGray(style, 229, 229, 228));
    const road = styles.map((style) => mapBaiduMapPixelToGray(style, 255, 238, 187));
    expect(boundary[0]).toBeLessThan(boundary[1]);
    expect(boundary[1]).toBeLessThan(boundary[2]);
    expect(boundary[2]).toBeLessThan(235);
    expect(road[0]).toBeLessThan(road[1]);
    expect(road[1]).toBeLessThan(road[2]);
    expect(road[0]).toBeLessThanOrEqual(195);

    // Existing dark POI text remains dark and close to its source luma rather
    // than being thresholded; all three styles still have distinct output.
    const poi = styles.map((style) => mapBaiduMapPixelToGray(style, 70, 123, 137));
    expect(new Set(poi).size).toBe(3);
    expect(Math.max(...poi) - Math.min(...poi)).toBeLessThan(16);
    expect(poi.every((value) => value > 90 && value < 120)).toBe(true);
  });

  it("fails closed with a sanitized error when map credentials are absent", async () => {
    await expect(executeInkApp({
      action: BAIDU_MAP_ACTION,
      nonce: NONCE,
      requestedAtUnixMs: REQUESTED_AT,
    }, { baiduMapAk: "" })).rejects.toMatchObject({
      code: "APP_NOT_CONFIGURED",
      status: 503,
      message: "地图应用尚未配置服务端凭据。",
    } satisfies Partial<InkAppServiceError>);
  });
});
