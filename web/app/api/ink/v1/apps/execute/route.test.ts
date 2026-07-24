import { describe, expect, it } from "vitest";
import sharp from "sharp";

import { sha256Hex } from "@/lib/rendering/checksum";
import type { RenderedFrame } from "@/lib/rendering/contracts";
import { getScreenProfile } from "@/lib/rendering/profiles";

import { handleAppExecute } from "./route";
import {
  DIAGNOSTIC_RAW_COLOUR_MODE,
  PHOTO_PAPERS3_SLIDESHOW_GRAY16_MODE,
} from "@/lib/ink/apps/diagnostic-raw-colour";

const request = (body: unknown) => new Request("http://localhost/api/ink/v1/apps/execute", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function frame(documentId: string, revision: number): RenderedFrame {
  const profile = getScreenProfile("m5stack-paper-s3-portrait");
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
      documentId,
      documentRevision: revision,
      contentType: "image",
      screenProfileId: profile.id,
      screenProfileVersion: profile.version,
      nativeSize: profile.nativeSize,
      logicalSize: profile.logicalSize,
      displayRotation: profile.displayRotation,
      pixelFormat: "gray4",
      layoutStrategy: profile.layoutStrategy,
      rasterStrategy: profile.rasterStrategy,
      displayMeta: { orientation: "portrait", fontLevel: 0, invert: false },
      codec: "png",
      pagination: { pageIndex: 0, pageCount: 1, hasPrevious: false, hasNext: false },
      update: { kind: "full", region: { x: 0, y: 0, ...profile.logicalSize } },
      payloadBytes: payload.byteLength,
      sha256,
      crc32: "00000000",
      interactions: [],
      warnings: [],
    },
  };
}

describe("POST /api/ink/v1/apps/execute", () => {
  it("returns a no-store verified frame and echoes the exact action identity", async () => {
    const nonce = "0123456789abcdef";
    const requestedAtUnixMs = 1_784_352_000_123;
    const response = await handleAppExecute(request({
      action: "inkos://app/random-image",
      nonce,
      requestedAtUnixMs,
    }), {
      render: async ({ document }) => frame(document.uuid, document.content.revision),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("X-Ink-App-Action")).toBe("inkos://app/random-image");
    expect(response.headers.get("X-Ink-App-Nonce")).toBe(nonce);
    expect(response.headers.get("X-Ink-App-Requested-At")).toBe(String(requestedAtUnixMs));
    expect(response.headers.get("X-Ink-App-Page-Index")).toBe("0");
    expect(response.headers.get("X-Ink-App-Image-Mode")).toBe(
      PHOTO_PAPERS3_SLIDESHOW_GRAY16_MODE,
    );
    expect(response.headers.get("X-Ink-Frame-Manifest")).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(response.headers.get("X-Ink-Sidecar")).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(response.headers.get("X-Ink-SHA256")).toBe(response.headers.get("ETag")?.slice(1, -1));
  });

  it("labels map RGB as raw while slideshow-processed photos use a distinct protocol mode", async () => {
    const response = await handleAppExecute(request({
      action: "inkos://app/baidu-map",
      nonce: "maprawfixture001",
      requestedAtUnixMs: 1_784_352_000_123,
    }), {
      baiduMapAk: "x".repeat(24),
      fetch: async () => Response.json({
        status: 0,
        content: { point: { x: "120.1551", y: "30.2741" } },
      }),
      render: async ({ document }) => frame(document.uuid, document.content.revision),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Ink-App-Image-Mode"))
      .toBe(DIAGNOSTIC_RAW_COLOUR_MODE);
  });

  it("returns a standards-compliant 8-bit true-colour PNG through the API path", async () => {
    const source = await sharp({
      create: {
        width: 540,
        height: 960,
        channels: 3,
        background: { r: 22, g: 177, b: 94 },
      },
    }).png({ palette: false }).toBuffer();
    const response = await handleAppExecute(request({
      action: "inkos://app/random-image",
      nonce: "rawcolourfixture",
      requestedAtUnixMs: 1_784_352_000_123,
    }), {
      assetResolver: {
        resolve: async () => ({
          status: "resolved",
          image: {
            dataUri: `data:image/png;base64,${source.toString("base64")}`,
            width: 540,
            height: 960,
            mimeType: "image/png",
          },
        }),
      },
    });
    const payload = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(payload.readUInt32BE(16)).toBe(540);
    expect(payload.readUInt32BE(20)).toBe(960);
    expect(payload[24]).toBe(8);
    expect(payload[25]).toBe(2);
    expect(payload.includes(Buffer.from("PLTE"))).toBe(false);
  });

  it("rejects any unlisted custom action before an upstream request", async () => {
    const response = await handleAppExecute(request({
      action: "inkos://app/random-image/next",
      nonce: "0123456789abcdef",
      requestedAtUnixMs: 1_784_352_000_123,
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_APP_REQUEST" });
  });

  it("rejects retired inverse rendering before executing an app", async () => {
    const response = await handleAppExecute(request({
      action: "inkos://app/random-image",
      nonce: "0123456789abcdef",
      requestedAtUnixMs: 1_784_352_000_123,
      displayMeta: { orientation: "portrait", fontLevel: 0, invert: true },
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_APP_REQUEST" });
  });

  it("never exposes missing map credentials or upstream URLs in the response", async () => {
    const response = await handleAppExecute(request({
      action: "inkos://app/baidu-map",
      nonce: "0123456789abcdef",
      requestedAtUnixMs: 1_784_352_000_123,
    }), { baiduMapAk: "" });
    const text = await response.text();
    expect(response.status).toBe(503);
    expect(text).toContain("APP_NOT_CONFIGURED");
    expect(text).not.toContain("api.map.baidu.com");
    expect(text).not.toContain("ak=");
  });

  it("sanitizes map upstream failures without reflecting the server credential", async () => {
    const credential = "server_only_test_credential";
    const response = await handleAppExecute(request({
      action: "inkos://app/baidu-map",
      nonce: "0123456789abcdef",
      requestedAtUnixMs: 1_784_352_000_123,
    }), {
      baiduMapAk: credential,
      fetch: async () => { throw new Error(`network failed for ${credential}`); },
    });
    const text = await response.text();
    expect(response.status).toBe(502);
    expect(text).toContain("APP_UPSTREAM_UNAVAILABLE");
    expect(text).not.toContain(credential);
    expect(text).not.toContain("api.map.baidu.com");
  });

  it("never returns renderer warnings that could contain a secret-bearing map URL", async () => {
    const credential = "server_only_warning_credential";
    const response = await handleAppExecute(request({
      action: "inkos://app/baidu-map",
      nonce: "0123456789abcdef",
      requestedAtUnixMs: 1_784_352_000_123,
    }), {
      baiduMapAk: credential,
      fetch: async () => Response.json({
        status: 0,
        content: { point: { x: "116.404", y: "39.915" } },
      }),
      render: async ({ document }) => {
        const rendered = frame(document.uuid, document.content.revision);
        const warning = `failed https://example.invalid/?ak=${credential}`;
        return {
          ...rendered,
          warnings: [warning],
          manifest: { ...rendered.manifest, warnings: [warning] },
        };
      },
    });
    const text = await response.text();
    expect(response.status).toBe(502);
    expect(text).toContain("APP_IMAGE_UNAVAILABLE");
    expect(text).not.toContain(credential);
    expect(text).not.toContain("ak=");
  });
});
