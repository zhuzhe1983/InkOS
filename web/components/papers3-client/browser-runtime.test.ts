import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";

import {
  buildInkArchive,
  encodeInkJson,
  inkPackageManifestSchema,
  inkVariantId,
  packagedDocument,
  sha256Hex,
  type InkFrameSidecar,
  type InkPackageManifest,
  type PackagedDocument,
} from "@/lib/ink";
import {
  INKOS_APP_DOCUMENT_UUIDS,
  type InkClientAppUrl,
} from "@/lib/ink/app-actions";
import { ONLINE_PACKAGE_ID } from "@/lib/ink/service-contracts";

import { BrowserInkRuntimeAdapter, PAPER_S3_PROFILE_ID } from "./browser-runtime";
import type { InkDisplayPreferences } from "./runtime-adapter";

const PACKAGE_ID = "00000000-0000-4000-8000-000000000099";
const ROOT_UUID = "00000000-0000-4000-8000-000000000001";
const CHILD_UUID = "00000000-0000-4000-8000-000000000002";
const BASE_DISPLAY = { orientation: "portrait", invert: false, fontLevel: 0 } as const;
const VARIANT_ID = inkVariantId(PAPER_S3_PROFILE_ID, BASE_DISPLAY);

function minimalPng(width = 540, height = 960): Uint8Array {
  const png = new Uint8Array(24);
  png.set([137, 80, 78, 71, 13, 10, 26, 10]);
  png.set([0, 0, 0, 13, 73, 72, 68, 82], 8);
  const view = new DataView(png.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return png;
}

async function makePackage(options: { dynamicClock?: boolean; sourceImage?: boolean } = {}) {
  const root = packagedDocument({
    uuid: ROOT_UUID,
    source: { title: "Nook 目录" },
    content: {
      schemaVersion: "inkos.content/v2",
      id: ROOT_UUID,
      revision: 4,
      locale: "zh-CN",
      page: {
        kind: "list",
        layout: "list",
        title: "Nook 目录",
        items: [{
          id: "simple-touch",
          title: "Nook Simple Touch",
          link: { label: "打开", target: { kind: "document", documentId: CHILD_UUID } },
        }],
      },
    },
  });
  const child = packagedDocument({
    uuid: CHILD_UUID,
    parentUuid: ROOT_UUID,
    source: { title: "Nook Simple Touch" },
    content: {
      schemaVersion: "inkos.content/v2",
      id: CHILD_UUID,
      revision: 2,
      locale: "zh-CN",
      page: options.sourceImage
        ? {
            kind: "image",
            layout: "contain",
            image: {
              source: { kind: "asset", assetId: "fixture/source-jpeg" },
              alt: "Source JPEG fixture",
            },
          }
        : { kind: "reader", content: [{ type: "paragraph", text: "正文" }] },
    },
  });

  const files = new Map<string, Uint8Array>();
  const documents: InkPackageManifest["documents"] = [];
  const documentValues = new Map<string, PackagedDocument>();
  const sidecarValues = new Map<string, InkFrameSidecar>();
  const image = minimalPng();
  const imageSha256 = await sha256Hex(image);
  const sourceImageBytes = options.sourceImage
    ? new Uint8Array(await sharp({
        create: { width: 540, height: 960, channels: 3, background: { r: 96, g: 128, b: 160 } },
      }).jpeg({ progressive: false }).toBuffer())
    : undefined;

  for (const document of [root, child]) {
    documentValues.set(document.uuid, document);
    const documentPath = `documents/${document.uuid}.json`;
    const documentBytes = encodeInkJson(document);
    files.set(documentPath, documentBytes);
    const imagePath = `frames/${VARIANT_ID}/${document.uuid}/0000.png`;
    files.set(imagePath, image);
    const sourcePath = `sources/${document.uuid}/0000.jpg`;
    const sourceImage = options.sourceImage && document.uuid === CHILD_UUID && sourceImageBytes
      ? {
          path: sourcePath,
          bytes: sourceImageBytes.byteLength,
          sha256: await sha256Hex(sourceImageBytes),
          mediaType: "image/jpeg" as const,
          pixelSize: { width: 540, height: 960 },
          fit: "contain" as const,
        }
      : undefined;
    if (sourceImage && sourceImageBytes) files.set(sourcePath, sourceImageBytes);
    const sidecarPath = `frames/${VARIANT_ID}/${document.uuid}/0000.json`;
    const sidecar: InkFrameSidecar = {
      schemaVersion: "inkos.frame-sidecar/v1",
      packageId: PACKAGE_ID,
      documentUuid: document.uuid,
      ...(document.parentUuid ? { parentUuid: document.parentUuid } : {}),
      variantId: VARIANT_ID,
      pageIndex: 0,
      pageCount: 1,
      imagePath,
      imageSha256,
      ...(sourceImage ? { sourceImage } : {}),
      logicalSize: { width: 540, height: 960 },
      interactions: document.uuid === ROOT_UUID ? [{
        id: "page.items[0].link",
        contentPath: "page.items[0].link",
        bounds: { x: 20, y: 120, width: 500, height: 120 },
        targetUuid: CHILD_UUID,
      }] : [],
      ...(options.dynamicClock && document.uuid === CHILD_UUID ? {
        dynamicRegions: [{
          id: "clock-main",
          kind: "clock" as const,
          bounds: { x: 20, y: 100, width: 500, height: 44 },
          format: "HH:mm:ss" as const,
          timezone: "Asia/Shanghai" as const,
          refreshMs: 1_000,
          fullRefreshEvery: 60,
          style: {
            fontFamily: "monospace" as const,
            fontSize: 36,
            fontWeight: 700 as const,
            textAlign: "center" as const,
            verticalAlign: "top" as const,
            foreground: "black" as const,
            background: "white" as const,
          },
        }],
      } : {}),
    };
    sidecarValues.set(sidecarPath, sidecar);
    const sidecarBytes = encodeInkJson(sidecar);
    files.set(sidecarPath, sidecarBytes);
    documents.push({
      uuid: document.uuid,
      ...(document.parentUuid ? { parentUuid: document.parentUuid } : {}),
      title: document.source.title,
      kind: document.content.page.kind,
      documentPath,
      documentBytes: documentBytes.byteLength,
      documentSha256: await sha256Hex(documentBytes),
      variants: [{
        variantId: VARIANT_ID,
        pageCount: 1,
        pages: [{
          pageIndex: 0,
          imagePath,
          imageBytes: image.byteLength,
          imageSha256,
          ...(sourceImage ? { sourceImage } : {}),
          sidecarPath,
          sidecarBytes: sidecarBytes.byteLength,
          sidecarSha256: await sha256Hex(sidecarBytes),
        }],
      }],
    });
  }

  const manifest = inkPackageManifestSchema.parse({
    schemaVersion: "inkos.package/v1",
    packageId: PACKAGE_ID,
    slug: "nook-runtime-test",
    revision: 7,
    title: "Nook 电子墨水屏系列",
    entryUuid: ROOT_UUID,
    createdAt: "2026-07-16T14:00:00+08:00",
    generator: { name: "inkos-test", version: "1.0.0" },
    compatibility: {
      formatMajor: 1,
      minimumClientVersions: { web: "1.0.0", paperS3: "1.0.0" },
      requiredCapabilities: options.sourceImage
        ? [
          "navigation.parent-v1",
          "navigation.hitbox-v1",
          "frame.source-image-jpeg-v1",
        ]
        : ["navigation.parent-v1", "navigation.hitbox-v1"],
    },
    provenance: {
      seeds: [{
        url: "https://zh.wikipedia.org/wiki/Nook",
        title: "Nook",
        retrievedAt: "2026-07-16T14:00:00+08:00",
      }],
      crawl: { maxDepth: 1, maxDocuments: 2 },
    },
    variants: [{
      id: VARIANT_ID,
      profileId: PAPER_S3_PROFILE_ID,
      screenProfileVersion: 2,
      displayMeta: BASE_DISPLAY,
      logicalSize: { width: 540, height: 960 },
      displayRotation: 90,
      pixelFormat: "gray4",
      codec: "png",
    }],
    documents,
  });

  return {
    archive: await buildInkArchive(manifest, files),
    manifest,
    documents: documentValues,
    sidecars: sidecarValues,
    image,
    sourceImageBytes,
    files,
  };
}

function objectUrls() {
  let index = 0;
  return {
    create: vi.fn<(blob: Blob) => string>(() => `blob:test-${++index}`),
    revoke: vi.fn(),
  };
}

function successfulDecoder() {
  return vi.fn<(image: Uint8Array, signal?: AbortSignal) => Promise<void>>()
    .mockResolvedValue(undefined);
}

function artifactResponse(
  bytes: Uint8Array,
  sha256: string,
  contentType: string,
  contentLength = bytes.byteLength,
  manifestSha256?: string,
): Response {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Response(copy.buffer, {
    headers: {
      "Content-Length": String(contentLength),
      "Content-Type": contentType,
      "X-Ink-SHA256": sha256,
      ...(manifestSha256 ? { "X-Ink-Manifest-SHA256": manifestSha256 } : {}),
    },
  });
}

async function manifestResponse(manifest: InkPackageManifest): Promise<Response> {
  const bytes = encodeInkJson(manifest);
  const sha256 = await sha256Hex(bytes);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Response(copy.buffer, {
    headers: {
      "Content-Length": String(bytes.byteLength),
      "Content-Type": "application/json; charset=utf-8",
      "X-Ink-SHA256": sha256,
      ETag: `"${sha256}"`,
      "X-Ink-Package-Id": manifest.packageId,
      "X-Ink-Package-Revision": String(manifest.revision),
    },
  });
}

function base64UrlJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

interface OnDemandFixtureOptions {
  readonly display: InkDisplayPreferences;
  readonly manifest?: InkPackageManifest;
  readonly documentUuid?: string;
  readonly requestedPageIndex?: number;
  readonly actualPageIndex?: number;
  readonly pageCount?: number;
  readonly framePatch?: Record<string, unknown>;
  readonly sidecarPatch?: Record<string, unknown>;
  readonly headerOverrides?: Record<string, string>;
  readonly contentLength?: number;
}

async function onDemandResponse(
  fixture: PackageFixture,
  options: OnDemandFixtureOptions,
): Promise<Response> {
  const manifest = options.manifest ?? fixture.manifest;
  const documentUuid = options.documentUuid ?? ROOT_UUID;
  const document = fixture.documents.get(documentUuid)!;
  const requestedPageIndex = options.requestedPageIndex ?? 0;
  const pageCount = options.pageCount ?? 1;
  const actualPageIndex = options.actualPageIndex ?? Math.min(requestedPageIndex, pageCount - 1);
  const logicalSize = options.display.orientation === "portrait"
    ? { width: 540, height: 960 }
    : { width: 960, height: 540 };
  const image = minimalPng(logicalSize.width, logicalSize.height);
  const imageSha256 = await sha256Hex(image);
  const manifestSha256 = await sha256Hex(encodeInkJson(manifest));
  const variantId = inkVariantId(PAPER_S3_PROFILE_ID, options.display);
  const interactions = documentUuid === ROOT_UUID ? [
    {
      contentPath: "page.items[0].link",
      label: "打开子文档",
      bounds: { x: 20, y: 100, width: 180, height: 80 },
      action: { type: "open-document", documentId: CHILD_UUID },
    },
    {
      contentPath: "page.navigation[0]",
      label: "访问来源",
      bounds: { x: 220, y: 100, width: 180, height: 80 },
      action: { type: "open-url", url: "https://example.com/source" },
    },
  ] : [];
  const frame = {
    schemaVersion: "inkos.frame/v2",
    rendererVersion: "1.0.0",
    frameId: imageSha256.slice(0, 24),
    documentId: documentUuid,
    documentRevision: document.content.revision,
    contentType: document.content.page.kind,
    screenProfileId: PAPER_S3_PROFILE_ID,
    screenProfileVersion: 2,
    nativeSize: { width: 960, height: 540 },
    logicalSize,
    displayRotation: options.display.orientation === "portrait" ? 90 : 0,
    pixelFormat: "gray4",
    layoutStrategy: "paper-s3-semantic-v1",
    rasterStrategy: "eink-gray4-png-v1",
    displayMeta: options.display,
    codec: "png",
    pagination: {
      pageIndex: actualPageIndex,
      pageCount,
      hasPrevious: actualPageIndex > 0,
      hasNext: actualPageIndex + 1 < pageCount,
    },
    update: { kind: "full", region: { x: 0, y: 0, ...logicalSize } },
    payloadBytes: image.byteLength,
    sha256: imageSha256,
    crc32: "1234abcd",
    interactions,
    warnings: ["fixture warning"],
    ...options.framePatch,
  };
  const sidecar = {
    schemaVersion: "inkos.frame-sidecar/v1",
    packageId: PACKAGE_ID,
    documentUuid,
    ...(document.parentUuid ? { parentUuid: document.parentUuid } : {}),
    variantId,
    pageIndex: actualPageIndex,
    pageCount,
    imagePath: `online/${variantId}/${documentUuid}/${actualPageIndex.toString().padStart(4, "0")}.png`,
    imageSha256,
    logicalSize,
    interactions: interactions.map((interaction) => ({
      id: interaction.contentPath,
      contentPath: interaction.contentPath,
      label: interaction.label,
      bounds: interaction.bounds,
      targetUuid: interaction.action.type === "open-document"
        ? interaction.action.documentId
        : documentUuid,
      ...(interaction.action.type === "open-url" ? { targetUrl: interaction.action.url } : {}),
    })),
    ...options.sidecarPatch,
  };
  const copy = new Uint8Array(image.byteLength);
  copy.set(image);
  return new Response(copy.buffer, {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(options.contentLength ?? image.byteLength),
      "Cache-Control": "no-store",
      ETag: `"${imageSha256}"`,
      "X-Ink-SHA256": imageSha256,
      "X-Ink-Frame-Manifest": base64UrlJson(frame),
      "X-Ink-Sidecar": base64UrlJson(sidecar),
      "X-Ink-Warnings": base64UrlJson(frame.warnings),
      "X-Ink-Package-Id": PACKAGE_ID,
      "X-Ink-Package-Revision": String(manifest.revision),
      "X-Ink-Manifest-SHA256": manifestSha256,
      "X-Ink-Requested-Page-Index": String(requestedPageIndex),
      "X-Ink-Actual-Page-Index": String(actualPageIndex),
      ...options.headerOverrides,
    },
  });
}

async function appResponse(
  action: InkClientAppUrl,
  nonce: string,
  requestedAtUnixMs: number,
  display: InkDisplayPreferences,
  headerOverrides: Record<string, string> = {},
): Promise<Response> {
  const logicalSize = display.orientation === "portrait"
    ? { width: 540, height: 960 }
    : { width: 960, height: 540 };
  const image = minimalPng(logicalSize.width, logicalSize.height);
  const imageSha256 = await sha256Hex(image);
  const documentUuid = INKOS_APP_DOCUMENT_UUIDS[action];
  const variantId = inkVariantId(PAPER_S3_PROFILE_ID, display);
  const slug = action === "inkos://app/random-image" ? "random-image" : "baidu-map";
  const frame = {
    schemaVersion: "inkos.frame/v2",
    rendererVersion: "inkos-renderer/0.8.0",
    frameId: imageSha256.slice(0, 24),
    documentId: documentUuid,
    documentRevision: 17,
    contentType: "image",
    screenProfileId: PAPER_S3_PROFILE_ID,
    screenProfileVersion: 2,
    nativeSize: { width: 960, height: 540 },
    logicalSize,
    displayRotation: display.orientation === "portrait" ? 90 : 0,
    pixelFormat: "gray4",
    layoutStrategy: "paper-s3-semantic-v1",
    rasterStrategy: "eink-gray4-png-v1",
    displayMeta: display,
    codec: "png",
    pagination: { pageIndex: 0, pageCount: 1, hasPrevious: false, hasNext: false },
    update: { kind: "full", region: { x: 0, y: 0, ...logicalSize } },
    payloadBytes: image.byteLength,
    sha256: imageSha256,
    crc32: "1234abcd",
    interactions: [],
    warnings: [],
  };
  const sidecar = {
    schemaVersion: "inkos.frame-sidecar/v1",
    packageId: ONLINE_PACKAGE_ID,
    documentUuid,
    variantId,
    pageIndex: 0,
    pageCount: 1,
    imagePath: `apps/${slug}/${nonce}/${variantId}/${documentUuid}/0000.png`,
    imageSha256,
    logicalSize,
    interactions: [],
  };
  const responseBody = image.buffer.slice(
    image.byteOffset,
    image.byteOffset + image.byteLength,
  ) as ArrayBuffer;
  return new Response(responseBody, {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(image.byteLength),
      "Cache-Control": "no-store",
      ETag: `"${imageSha256}"`,
      "X-Ink-SHA256": imageSha256,
      "X-Ink-Frame-Manifest": base64UrlJson(frame),
      "X-Ink-Sidecar": base64UrlJson(sidecar),
      "X-Ink-Warnings": base64UrlJson([]),
      "X-Ink-App-Action": action,
      "X-Ink-App-Nonce": nonce,
      "X-Ink-App-Requested-At": String(requestedAtUnixMs),
      "X-Ink-App-Page-Index": "0",
      ...headerOverrides,
    },
  });
}

function revisionChangedResponse(headers: Record<string, string> = {}): Response {
  return Response.json({
    type: "about:blank",
    title: "Package manifest changed",
    status: 412,
    code: "PACKAGE_REVISION_CHANGED",
    detail: "Reload the package manifest before retrying the complete resource transaction",
  }, { status: 412, headers: { "Cache-Control": "no-store", ...headers } });
}

type PackageFixture = Awaited<ReturnType<typeof makePackage>>;

interface OnlineFixtureOptions {
  readonly manifest?: InkPackageManifest;
  readonly documentBytes?: Uint8Array;
  readonly documentContentLength?: number;
  readonly sidecarBytes?: Uint8Array;
  readonly sidecarContentLength?: number;
}

function fixtureFetcher(fixture: PackageFixture, options: OnlineFixtureOptions = {}) {
  const manifest = options.manifest ?? fixture.manifest;
  const manifestSha256 = sha256Hex(encodeInkJson(manifest));
  const documentIndex = manifest.documents.find((entry) => entry.uuid === ROOT_UUID)!;
  const page = documentIndex.variants[0].pages[0];
  const originalDocument = fixture.files.get(fixture.manifest.documents[0].documentPath)!;
  const originalSidecar = fixture.files.get(
    fixture.manifest.documents[0].variants[0].pages[0].sidecarPath,
  )!;

  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void init;
    const url = String(input);
    const boundManifestSha256 = await manifestSha256;
    if (url === "/api/ink/v1/packages") {
      return Response.json({
        defaultPackageId: PACKAGE_ID,
        defaultEntryUuid: ROOT_UUID,
        packages: [{
          packageId: PACKAGE_ID,
          entryUuid: ROOT_UUID,
          title: manifest.title,
        }],
      });
    }
    if (url.endsWith(`/${PACKAGE_ID}/manifest`)) return manifestResponse(manifest);
    if (url.endsWith(`/documents/${ROOT_UUID}`)) {
      return artifactResponse(
        options.documentBytes ?? originalDocument,
        documentIndex.documentSha256,
        "application/json; charset=utf-8",
        options.documentContentLength,
        boundManifestSha256,
      );
    }
    if (url.endsWith(`/frames/${VARIANT_ID}/${ROOT_UUID}/0/sidecar`)) {
      return artifactResponse(
        options.sidecarBytes ?? originalSidecar,
        page.sidecarSha256,
        "application/json; charset=utf-8",
        options.sidecarContentLength,
        boundManifestSha256,
      );
    }
    if (url.endsWith(`/frames/${VARIANT_ID}/${ROOT_UUID}/0`)) {
      return artifactResponse(
        fixture.image,
        page.imageSha256,
        "image/png",
        fixture.image.byteLength,
        boundManifestSha256,
      );
    }
    for (const candidate of manifest.documents) {
      const fixtureCandidate = fixture.manifest.documents.find((entry) => entry.uuid === candidate.uuid)!;
      const candidatePage = candidate.variants[0].pages[0];
      const fixturePage = fixtureCandidate.variants[0].pages[0];
      if (url.endsWith(`/documents/${candidate.uuid}`)) {
        return artifactResponse(
          fixture.files.get(fixtureCandidate.documentPath)!,
          candidate.documentSha256,
          "application/json; charset=utf-8",
          undefined,
          boundManifestSha256,
        );
      }
      if (url.endsWith(`/frames/${VARIANT_ID}/${candidate.uuid}/0/sidecar`)) {
        return artifactResponse(
          fixture.files.get(fixturePage.sidecarPath)!,
          candidatePage.sidecarSha256,
          "application/json; charset=utf-8",
          undefined,
          boundManifestSha256,
        );
      }
      if (url.endsWith(`/frames/${VARIANT_ID}/${candidate.uuid}/0`)) {
        return artifactResponse(
          fixture.files.get(fixturePage.imagePath)!,
          candidatePage.imageSha256,
          "image/png",
          undefined,
          boundManifestSha256,
        );
      }
    }
    return new Response("missing", { status: 404 });
  });
}

describe("PaperS3 real browser runtime", () => {
  it("generates a client nonce/timestamp, verifies an app frame, and opens it without source resolution", async () => {
    const nonce = "0123456789abcdef";
    const requestedAtUnixMs = 1_784_352_000_123;
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/ink/v1/apps/execute");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      return appResponse(
        body.action as InkClientAppUrl,
        String(body.nonce),
        Number(body.requestedAtUnixMs),
        body.displayMeta as InkDisplayPreferences,
      );
    });
    const decodeFrame = successfulDecoder();
    const runtime = new BrowserInkRuntimeAdapter({
      fetch: fetcher,
      objectUrls: objectUrls(),
      decodeFrame,
      appNonce: () => nonce,
      now: () => requestedAtUnixMs,
    });
    const legacyDisplay = { ...BASE_DISPLAY, invert: true } as const;
    const prepared = await runtime.prepareAppAction("inkos://app/random-image", {
      display: legacyDisplay,
    });
    const view = await runtime.open({
      uuid: prepared.documentUuid,
      pageIndex: 0,
      sourceMode: "online",
      display: legacyDisplay,
    });

    expect(prepared).toEqual({
      action: "inkos://app/random-image",
      documentUuid: INKOS_APP_DOCUMENT_UUIDS["inkos://app/random-image"],
      nonce,
      requestedAtUnixMs,
    });
    expect(bodies).toEqual([{
      action: "inkos://app/random-image",
      nonce,
      requestedAtUnixMs,
      pageIndex: 0,
      displayMeta: BASE_DISPLAY,
    }]);
    expect(decodeFrame).toHaveBeenCalledOnce();
    expect(view).toMatchObject({
      document: { uuid: prepared.documentUuid, kind: "image", title: "图片查看器" },
      page: { index: 0, count: 1, pixelSize: { width: 540, height: 960 } },
      source: { mode: "online", label: "实时应用", verified: true },
    });
  });

  it("creates a fresh nonce for every app click and keeps app actions away from /sources/resolve", async () => {
    const nonces = ["0000000000000001", "0000000000000002"];
    const requested: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requested.push(String(input));
      const body = JSON.parse(String(init?.body)) as {
        action: InkClientAppUrl;
        nonce: string;
        requestedAtUnixMs: number;
        displayMeta: InkDisplayPreferences;
      };
      return appResponse(
        body.action,
        body.nonce,
        body.requestedAtUnixMs,
        body.displayMeta,
      );
    });
    const runtime = new BrowserInkRuntimeAdapter({
      fetch: fetcher,
      objectUrls: objectUrls(),
      decodeFrame: successfulDecoder(),
      appNonce: () => nonces.shift()!,
      now: () => 1_784_352_000_123,
    });

    const first = await runtime.prepareAppAction("inkos://app/random-image");
    const second = await runtime.prepareAppAction("inkos://app/random-image");
    expect(first.nonce).not.toBe(second.nonce);
    expect(requested).toEqual([
      "/api/ink/v1/apps/execute",
      "/api/ink/v1/apps/execute",
    ]);
    expect(requested.some((url) => url.endsWith("/sources/resolve"))).toBe(false);
  });

  it("re-renders an active app for orientation with the same click identity", async () => {
    const requests: Array<{
      nonce: string;
      requestedAtUnixMs: number;
      displayMeta: InkDisplayPreferences;
    }> = [];
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        action: InkClientAppUrl;
        nonce: string;
        requestedAtUnixMs: number;
        displayMeta: InkDisplayPreferences;
      };
      requests.push(body);
      return appResponse(body.action, body.nonce, body.requestedAtUnixMs, body.displayMeta);
    };
    const runtime = new BrowserInkRuntimeAdapter({
      fetch: fetcher,
      objectUrls: objectUrls(),
      decodeFrame: successfulDecoder(),
      appNonce: () => "0123456789abcdef",
      now: () => 1_784_352_000_123,
    });
    const prepared = await runtime.prepareAppAction("inkos://app/baidu-map", {
      display: BASE_DISPLAY,
    });
    const landscape = { orientation: "landscape", fontLevel: 0, invert: false } as const;
    const view = await runtime.open({
      uuid: prepared.documentUuid,
      pageIndex: 0,
      sourceMode: "online",
      display: landscape,
    });

    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      nonce: requests[0].nonce,
      requestedAtUnixMs: requests[0].requestedAtUnixMs,
      displayMeta: landscape,
    });
    expect(view.page.pixelSize).toEqual({ width: 960, height: 540 });
    expect(view.document.title).toBe("附近地图");
  });

  it("installs an ArrayBuffer .ink archive and exposes its real root frame and hitboxes", async () => {
    const fixture = await makePackage();
    const urls = objectUrls();
    const decodeFrame = successfulDecoder();
    const runtime = new BrowserInkRuntimeAdapter({ objectUrls: urls, decodeFrame });
    const buffer = fixture.archive.buffer.slice(
      fixture.archive.byteOffset,
      fixture.archive.byteOffset + fixture.archive.byteLength,
    ) as ArrayBuffer;

    const installed = await runtime.installArchive(buffer, "nook.ink");
    expect(installed).toMatchObject({
      packageId: PACKAGE_ID,
      filename: "nook.ink",
      entryUuid: ROOT_UUID,
      documentCount: 2,
    });
    expect(decodeFrame).toHaveBeenCalledOnce();
    expect(decodeFrame.mock.calls[0][0]).toEqual(fixture.image);
    expect(runtime.getRootUuid("offline")).toBe(ROOT_UUID);

    const view = await runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "offline",
      display: { orientation: "portrait", fontLevel: 0, invert: false },
    });
    expect(view.document).toMatchObject({ uuid: ROOT_UUID, title: "Nook 目录", revision: 4 });
    expect(view.page).toMatchObject({ index: 0, count: 1, imageUrl: "blob:test-1" });
    expect(view.page.linkHitboxes).toEqual([expect.objectContaining({
      targetUuid: CHILD_UUID,
      label: "Nook Simple Touch",
      bounds: { x: 20, y: 120, width: 500, height: 120 },
    })]);
    expect(view.source).toMatchObject({ mode: "offline", packageFilename: "nook.ink", verified: true });
  });

  it("prefers a verified source JPEG over its packaged PNG fallback offline", async () => {
    const fixture = await makePackage({ sourceImage: true });
    const urls = objectUrls();
    const runtime = new BrowserInkRuntimeAdapter({
      objectUrls: urls,
      decodeFrame: successfulDecoder(),
    });
    await runtime.installArchive(fixture.archive, "source-image.ink");

    const view = await runtime.open({
      uuid: CHILD_UUID,
      pageIndex: 0,
      sourceMode: "offline",
      display: BASE_DISPLAY,
    });

    expect(view.document.kind).toBe("image");
    expect(view.page.imageUrl).toBe("blob:test-1");
    expect(urls.create).toHaveBeenCalledOnce();
    expect((urls.create.mock.calls[0][0] as Blob).type).toBe("image/jpeg");
  });

  it("rejects unavailable orientation/font variants but normalizes legacy reverse state", async () => {
    const fixture = await makePackage();
    const runtime = new BrowserInkRuntimeAdapter({
      objectUrls: objectUrls(),
      decodeFrame: successfulDecoder(),
    });
    await runtime.installArchive(fixture.archive, "base-only.ink");

    await expect(runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "offline",
      display: { orientation: "portrait", fontLevel: 1, invert: false },
    })).rejects.toThrow(/VARIANT_UNAVAILABLE.*字号 1/u);
    await expect(runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "offline",
      display: { orientation: "portrait", fontLevel: 0, invert: true },
    })).resolves.toMatchObject({ document: { uuid: ROOT_UUID } });
    await expect(runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "offline",
      display: { orientation: "landscape", fontLevel: 0, invert: false },
    })).rejects.toThrow(/VARIANT_UNAVAILABLE.*横屏/u);
  });

  it("exposes only schema-verified dynamic regions from the frame sidecar", async () => {
    const fixture = await makePackage({ dynamicClock: true });
    const runtime = new BrowserInkRuntimeAdapter({
      objectUrls: objectUrls(),
      decodeFrame: successfulDecoder(),
    });
    await runtime.installArchive(fixture.archive, "clock.ink");

    const view = await runtime.open({
      uuid: CHILD_UUID,
      pageIndex: 0,
      sourceMode: "offline",
      display: BASE_DISPLAY,
    });
    expect(view.page.dynamicRegions).toEqual([
      expect.objectContaining({
        id: "clock-main",
        bounds: { x: 20, y: 100, width: 500, height: 44 },
        style: expect.objectContaining({ fontFamily: "monospace", textAlign: "center" }),
      }),
    ]);
  });

  it("does not install a package that lacks the currently selected display variant", async () => {
    const fixture = await makePackage();
    const decodeFrame = successfulDecoder();
    const runtime = new BrowserInkRuntimeAdapter({
      objectUrls: objectUrls(),
      decodeFrame,
    });
    await runtime.installArchive(fixture.archive, "working.ink");

    await expect(runtime.installArchive(
      fixture.archive,
      "missing-selected-variant.ink",
      undefined,
      { orientation: "portrait", fontLevel: 1, invert: false },
    )).rejects.toThrow(/VARIANT_UNAVAILABLE.*字号 1/u);
    expect(decodeFrame).toHaveBeenCalledOnce();

    const view = await runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "offline",
      display: { orientation: "portrait", fontLevel: 0, invert: false },
    });
    expect(view.source.packageFilename).toBe("working.ink");
  });

  it("maps the versioned package runtime API to the same verified client view", async () => {
    const fixture = await makePackage();
    const seen: string[] = [];
    const backingFetcher = fixtureFetcher(fixture);
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push(url);
      return backingFetcher(input, init);
    });
    const runtime = new BrowserInkRuntimeAdapter({ fetch: fetcher, objectUrls: objectUrls() });

    expect(await runtime.resolveRootUuid("online")).toBe(ROOT_UUID);
    const view = await runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "online",
      display: { orientation: "portrait", fontLevel: 0, invert: false },
    });
    expect(view.source).toMatchObject({ mode: "online", verified: true });
    expect(view.page.linkHitboxes[0].targetUuid).toBe(CHILD_UUID);
    expect(seen).toEqual([
      "/api/ink/v1/packages",
      `/api/ink/v1/packages/${PACKAGE_ID}/manifest`,
      `/api/ink/v1/packages/${PACKAGE_ID}/documents/${ROOT_UUID}`,
      `/api/ink/v1/packages/${PACKAGE_ID}/frames/${VARIANT_ID}/${ROOT_UUID}/0/sidecar`,
      `/api/ink/v1/packages/${PACKAGE_ID}/frames/${VARIANT_ID}/${ROOT_UUID}/0`,
    ]);
    const manifestSha256 = await sha256Hex(encodeInkJson(fixture.manifest));
    const artifactCalls = fetcher.mock.calls.filter(([input]) =>
      /\/(?:documents|frames)\//u.test(String(input)),
    );
    expect(artifactCalls).toHaveLength(3);
    for (const [, init] of artifactCalls) {
      expect(new Headers(init?.headers).get("If-Match")).toBe(`"${manifestSha256}"`);
      expect(init?.cache).toBe("no-store");
    }
  });

  it("uses the catalog's explicit default package and rejects an inconsistent default entry", async () => {
    const fixture = await makePackage();
    const otherPackageId = "00000000-0000-4000-8000-000000000077";
    const backingFetcher = fixtureFetcher(fixture);
    const selectedFetcher = vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/ink/v1/packages"
      ? Response.json({
          defaultPackageId: PACKAGE_ID,
          defaultEntryUuid: ROOT_UUID,
          packages: [
            { packageId: otherPackageId, entryUuid: CHILD_UUID, title: "不是默认包" },
            { packageId: PACKAGE_ID, entryUuid: ROOT_UUID, title: fixture.manifest.title },
          ],
        })
      : backingFetcher(input));
    const selectedRuntime = new BrowserInkRuntimeAdapter({
      fetch: selectedFetcher,
      objectUrls: objectUrls(),
    });
    expect(await selectedRuntime.resolveRootUuid("online")).toBe(ROOT_UUID);
    expect(selectedFetcher.mock.calls.map(([input]) => String(input)))
      .not.toContain(`/api/ink/v1/packages/${otherPackageId}/manifest`);

    const inconsistentRuntime = new BrowserInkRuntimeAdapter({
      fetch: async () => Response.json({
        defaultPackageId: PACKAGE_ID,
        defaultEntryUuid: CHILD_UUID,
        packages: [{ packageId: PACKAGE_ID, entryUuid: ROOT_UUID, title: fixture.manifest.title }],
      }),
      objectUrls: objectUrls(),
    });
    await expect(inconsistentRuntime.resolveRootUuid("online"))
      .rejects.toThrow(/defaultEntryUuid.*不一致/u);
  });

  it("rejects a schema-valid sidecar that does not match the addressed document", async () => {
    const fixture = await makePackage();
    const originalPath = fixture.manifest.documents[0].variants[0].pages[0].sidecarPath;
    const wrongSidecar = {
      ...fixture.sidecars.get(originalPath)!,
      parentUuid: CHILD_UUID,
    };
    const wrongSidecarBytes = encodeInkJson(wrongSidecar);
    const manifest = structuredClone(fixture.manifest);
    manifest.documents[0].variants[0].pages[0].sidecarBytes = wrongSidecarBytes.byteLength;
    manifest.documents[0].variants[0].pages[0].sidecarSha256 = await sha256Hex(wrongSidecarBytes);
    const fetcher = fixtureFetcher(fixture, {
      manifest: inkPackageManifestSchema.parse(manifest),
      sidecarBytes: wrongSidecarBytes,
    });
    const runtime = new BrowserInkRuntimeAdapter({ fetch: fetcher, objectUrls: objectUrls() });
    await runtime.resolveRootUuid("online");

    await expect(runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "online",
      display: { orientation: "portrait", fontLevel: 0, invert: false },
    })).rejects.toThrow(/sidecar 与包清单不一致/u);
  });

  it("does not activate an online manifest that requires a newer web client", async () => {
    const fixture = await makePackage();
    const manifest = inkPackageManifestSchema.parse({
      ...fixture.manifest,
      compatibility: {
        ...fixture.manifest.compatibility,
        minimumClientVersions: {
          ...fixture.manifest.compatibility.minimumClientVersions,
          web: "99.0.0",
        },
      },
    });
    const runtime = new BrowserInkRuntimeAdapter({
      fetch: fixtureFetcher(fixture, { manifest }),
      objectUrls: objectUrls(),
    });

    await expect(runtime.resolveRootUuid("online")).rejects.toThrow(/PACKAGE_INCOMPATIBLE.*99\.0\.0/u);
    expect(runtime.getRootUuid("online")).toBeUndefined();
  });

  it("does not activate an online manifest without a supported PaperS3 profile", async () => {
    const fixture = await makePackage();
    const manifest = inkPackageManifestSchema.parse({
      ...fixture.manifest,
      variants: fixture.manifest.variants.map((variant) => ({
        ...variant,
        profileId: "m5stack-xiaozhi-card",
      })),
    });
    const runtime = new BrowserInkRuntimeAdapter({
      fetch: fixtureFetcher(fixture, { manifest }),
      objectUrls: objectUrls(),
    });

    await expect(runtime.resolveRootUuid("online")).rejects.toThrow(/PACKAGE_INCOMPATIBLE.*display variant/u);
    expect(runtime.getRootUuid("online")).toBeUndefined();
  });

  it("rejects a schema-valid online document whose bytes were changed", async () => {
    const fixture = await makePackage();
    const document = fixture.documents.get(ROOT_UUID)!;
    const tampered = encodeInkJson({
      ...document,
      content: { ...document.content, revision: document.content.revision + 1 },
    });
    expect(tampered.byteLength).toBe(fixture.manifest.documents[0].documentBytes);
    const runtime = new BrowserInkRuntimeAdapter({
      fetch: fixtureFetcher(fixture, { documentBytes: tampered }),
      objectUrls: objectUrls(),
    });
    await runtime.resolveRootUuid("online");

    await expect(runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "online",
      display: { orientation: "portrait", fontLevel: 0, invert: false },
    })).rejects.toThrow(/在线文档.*SHA-256/u);
  });

  it("rejects a schema-valid online sidecar whose bytes were changed", async () => {
    const fixture = await makePackage();
    const path = fixture.manifest.documents[0].variants[0].pages[0].sidecarPath;
    const sidecar = fixture.sidecars.get(path)!;
    const tampered = encodeInkJson({
      ...sidecar,
      interactions: sidecar.interactions.map((interaction) => ({
        ...interaction,
        bounds: { ...interaction.bounds, x: interaction.bounds.x + 1 },
      })),
    });
    expect(tampered.byteLength).toBe(fixture.manifest.documents[0].variants[0].pages[0].sidecarBytes);
    const runtime = new BrowserInkRuntimeAdapter({
      fetch: fixtureFetcher(fixture, { sidecarBytes: tampered }),
      objectUrls: objectUrls(),
    });
    await runtime.resolveRootUuid("online");

    await expect(runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "online",
      display: { orientation: "portrait", fontLevel: 0, invert: false },
    })).rejects.toThrow(/在线 sidecar.*SHA-256/u);
  });

  it.each([
    ["文档", { documentContentLength: 1 }],
    ["sidecar", { sidecarContentLength: 1 }],
  ] as const)("rejects an online %s response whose Content-Length contradicts the manifest", async (_label, override) => {
    const fixture = await makePackage();
    const runtime = new BrowserInkRuntimeAdapter({
      fetch: fixtureFetcher(fixture, override),
      objectUrls: objectUrls(),
    });
    await runtime.resolveRootUuid("online");

    await expect(runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "online",
      display: { orientation: "portrait", fontLevel: 0, invert: false },
    })).rejects.toThrow(/Content-Length 与包清单不一致/u);
  });

  it("turns a document length revision race into one manifest refresh and a complete retry", async () => {
    const fixture = await makePackage();
    const latestManifest = inkPackageManifestSchema.parse({
      ...fixture.manifest,
      revision: fixture.manifest.revision + 1,
    });
    const oldManifestSha256 = await sha256Hex(encodeInkJson(fixture.manifest));
    const latestManifestSha256 = await sha256Hex(encodeInkJson(latestManifest));
    const backingFetcher = fixtureFetcher(fixture);
    const decodeFrame = successfulDecoder();
    let manifestGets = 0;
    let childDocumentGets = 0;
    const documentIfMatches: Array<string | null> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/${PACKAGE_ID}/manifest`)) {
        manifestGets += 1;
        return manifestResponse(manifestGets === 1 ? fixture.manifest : latestManifest);
      }
      if (url.endsWith(`/documents/${CHILD_UUID}`)) {
        childDocumentGets += 1;
        documentIfMatches.push(new Headers(init?.headers).get("If-Match"));
        if (childDocumentGets === 1) {
          // This is the production symptom: the latest document has a different
          // length, but the stale request must see 412 before any byte claim.
          return revisionChangedResponse({ "Content-Length": "24869" });
        }
      }
      return backingFetcher(input, init);
    });
    const runtime = new BrowserInkRuntimeAdapter({
      fetch: fetcher,
      objectUrls: objectUrls(),
      decodeFrame,
    });
    const before = await runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "online",
      display: BASE_DISPLAY,
    });

    const refreshed = await runtime.open({
      uuid: CHILD_UUID,
      pageIndex: 0,
      sourceMode: "online",
      display: BASE_DISPLAY,
    });
    expect(refreshed.document.uuid).toBe(CHILD_UUID);
    expect(refreshed.source.detail).toContain(`revision ${latestManifest.revision}`);
    expect(manifestGets).toBe(2);
    expect(childDocumentGets).toBe(2);
    expect(documentIfMatches).toEqual([
      `"${oldManifestSha256}"`,
      `"${latestManifestSha256}"`,
    ]);
    expect(fetcher.mock.calls.filter(([input]) =>
      String(input).includes(`/frames/${VARIANT_ID}/${CHILD_UUID}/`),
    )).toHaveLength(2);
    expect(decodeFrame).toHaveBeenCalledOnce();
    expect(refreshed.page.imageUrl).not.toBe(before.page.imageUrl);
  });

  it.each(["frame", "sidecar"] as const)(
    "retries the entire page transaction once when the packaged %s races the manifest revision",
    async (racedArtifact) => {
      const fixture = await makePackage();
      const latestManifest = inkPackageManifestSchema.parse({
        ...fixture.manifest,
        revision: fixture.manifest.revision + 1,
      });
      const backingFetcher = fixtureFetcher(fixture);
      const decodeFrame = successfulDecoder();
      let manifestGets = 0;
      let childDocumentGets = 0;
      let racedArtifactGets = 0;
      const targetSuffix = racedArtifact === "sidecar"
        ? `/frames/${VARIANT_ID}/${CHILD_UUID}/0/sidecar`
        : `/frames/${VARIANT_ID}/${CHILD_UUID}/0`;
      const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith(`/${PACKAGE_ID}/manifest`)) {
          manifestGets += 1;
          return manifestResponse(manifestGets === 1 ? fixture.manifest : latestManifest);
        }
        if (url.endsWith(`/documents/${CHILD_UUID}`)) childDocumentGets += 1;
        if (url.endsWith(targetSuffix)) {
          racedArtifactGets += 1;
          if (racedArtifactGets === 1) return revisionChangedResponse();
        }
        return backingFetcher(input, init);
      });
      const runtime = new BrowserInkRuntimeAdapter({
        fetch: fetcher,
        objectUrls: objectUrls(),
        decodeFrame,
      });
      await runtime.open({
        uuid: ROOT_UUID,
        pageIndex: 0,
        sourceMode: "online",
        display: BASE_DISPLAY,
      });

      const refreshed = await runtime.open({
        uuid: CHILD_UUID,
        pageIndex: 0,
        sourceMode: "online",
        display: BASE_DISPLAY,
      });
      expect(refreshed.source.detail).toContain(`revision ${latestManifest.revision}`);
      expect(manifestGets).toBe(2);
      expect(childDocumentGets).toBe(2);
      expect(racedArtifactGets).toBe(2);
      expect(decodeFrame).toHaveBeenCalledOnce();
    },
  );

  it("stops after a second document revision response and preserves the old online package", async () => {
    const fixture = await makePackage();
    const latestManifest = inkPackageManifestSchema.parse({
      ...fixture.manifest,
      revision: fixture.manifest.revision + 1,
    });
    const backingFetcher = fixtureFetcher(fixture);
    const urls = objectUrls();
    let manifestGets = 0;
    let childDocumentGets = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/${PACKAGE_ID}/manifest`)) {
        manifestGets += 1;
        return manifestResponse(manifestGets === 1 ? fixture.manifest : latestManifest);
      }
      if (url.endsWith(`/documents/${CHILD_UUID}`)) {
        childDocumentGets += 1;
        return revisionChangedResponse();
      }
      return backingFetcher(input, init);
    });
    const runtime = new BrowserInkRuntimeAdapter({ fetch: fetcher, objectUrls: urls });
    const before = await runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "online",
      display: BASE_DISPLAY,
    });

    await expect(runtime.open({
      uuid: CHILD_UUID,
      pageIndex: 0,
      sourceMode: "online",
      display: BASE_DISPLAY,
    })).rejects.toThrow(/HTTP 412.*complete resource transaction/u);
    expect(manifestGets).toBe(2);
    expect(childDocumentGets).toBe(2);
    expect(urls.revoke).not.toHaveBeenCalled();

    const after = await runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "online",
      display: BASE_DISPLAY,
    });
    expect(after.page.imageUrl).toBe(before.page.imageUrl);
    expect(after.source.detail).toContain(`revision ${fixture.manifest.revision}`);
  });

  it("keeps the previous offline package and blob URLs when a replacement entry frame cannot decode", async () => {
    const fixture = await makePackage();
    const urls = objectUrls();
    const decodeFrame = vi.fn<(image: Uint8Array, signal?: AbortSignal) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("PNG codec rejected the entry frame"));
    const runtime = new BrowserInkRuntimeAdapter({ objectUrls: urls, decodeFrame });
    await runtime.installArchive(fixture.archive, "working.ink");
    const before = await runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "offline",
      display: { orientation: "portrait", fontLevel: 0, invert: false },
    });

    await expect(runtime.installArchive(fixture.archive, "broken.ink")).rejects.toThrow(/codec rejected/u);
    expect(runtime.getRootUuid("offline")).toBe(ROOT_UUID);
    expect(urls.revoke).not.toHaveBeenCalled();

    const after = await runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "offline",
      display: { orientation: "portrait", fontLevel: 0, invert: false },
    });
    expect(after.page.imageUrl).toBe(before.page.imageUrl);
    expect(after.source).toMatchObject({ packageFilename: "working.ink", verified: true });
  });

  it("opens a cached HTTPS source by its returned packageId without consulting the first catalog item", async () => {
    const fixture = await makePackage();
    const sourceUrl = "https://example.com/a+b?q=x+y#part";
    const backingFetcher = fixtureFetcher(fixture);
    const seen: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push(url);
      if (url === "/api/ink/v1/sources/resolve") {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          url: sourceUrl,
          displayMeta: BASE_DISPLAY,
        });
        return Response.json({
          schemaVersion: "inkos.source-resolution/v1",
          normalizedUrl: sourceUrl,
          cached: true,
          status: "complete",
          job: null,
          packageId: PACKAGE_ID,
          entryUuid: ROOT_UUID,
        });
      }
      return backingFetcher(input);
    });
    const decodeFrame = successfulDecoder();
    const progress: Array<{ phase: string; message: string }> = [];
    const runtime = new BrowserInkRuntimeAdapter({
      fetch: fetcher,
      objectUrls: objectUrls(),
      decodeFrame,
    });

    const selected = await runtime.prepareOnlineSource(sourceUrl, {
      display: { orientation: "portrait", fontLevel: 0, invert: false },
      onProgress: ({ phase, message }) => progress.push({ phase, message }),
    });
    expect(selected).toEqual({
      normalizedUrl: sourceUrl,
      packageId: PACKAGE_ID,
      entryUuid: ROOT_UUID,
      cached: true,
    });
    expect(runtime.getRootUuid("online")).toBe(ROOT_UUID);
    expect(decodeFrame).toHaveBeenCalledOnce();
    expect(seen).not.toContain("/api/ink/v1/packages");
    expect(progress).toEqual([
      { phase: "resolving", message: "正在打开网页内容，请稍等。" },
      { phase: "loading-package", message: "正在打开网页内容，请稍等。" },
      { phase: "ready", message: "正在打开网页内容，请稍等。" },
    ]);

    const callsBeforeOpen = fetcher.mock.calls.length;
    const view = await runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "online",
      display: { orientation: "portrait", fontLevel: 0, invert: false },
    });
    expect(view.source).toMatchObject({ mode: "online", verified: true });
    expect(fetcher).toHaveBeenCalledTimes(callsBeforeOpen);
  });

  it("opens an exact package/document UUID deep link without consulting the catalog", async () => {
    const fixture = await makePackage();
    const backingFetcher = fixtureFetcher(fixture);
    const seen: string[] = [];
    const decodeFrame = successfulDecoder();
    const runtime = new BrowserInkRuntimeAdapter({
      fetch: async (input) => {
        seen.push(String(input));
        return backingFetcher(input);
      },
      objectUrls: objectUrls(),
      decodeFrame,
    });

    const selected = await runtime.prepareOnlinePackage(PACKAGE_ID, {
      targetUuid: CHILD_UUID,
      pageIndex: 0,
      display: { orientation: "portrait", fontLevel: 0, invert: false },
    });
    expect(selected).toEqual({ packageId: PACKAGE_ID, entryUuid: ROOT_UUID });
    expect(seen).not.toContain("/api/ink/v1/packages");
    expect(decodeFrame).toHaveBeenCalledOnce();

    const callsBeforeOpen = seen.length;
    const view = await runtime.open({
      uuid: CHILD_UUID,
      pageIndex: 0,
      sourceMode: "online",
      display: { orientation: "portrait", fontLevel: 0, invert: false },
    });
    expect(view.document.uuid).toBe(CHILD_UUID);
    expect(view.source).toMatchObject({ packageId: PACKAGE_ID, mode: "online", verified: true });
    expect(seen).toHaveLength(callsBeforeOpen);
  });

  it("renders only the requested missing display variant and caches the clamped dynamic page", async () => {
    const fixture = await makePackage();
    const backingFetcher = fixtureFetcher(fixture);
    const legacyDisplay = { orientation: "landscape", fontLevel: 1, invert: true } as const;
    const display = { ...legacyDisplay, invert: false } as const;
    const decodeFrame = successfulDecoder();
    const urls = objectUrls();
    let renderCalls = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/${PACKAGE_ID}/render`)) {
        renderCalls += 1;
        const manifestSha256 = await sha256Hex(encodeInkJson(fixture.manifest));
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("If-Match")).toBe(`"${manifestSha256}"`);
        expect(JSON.parse(String(init?.body))).toEqual({
          documentUuid: ROOT_UUID,
          manifestSha256,
          displayMeta: display,
          pageIndex: 8,
        });
        return onDemandResponse(fixture, {
          display,
          requestedPageIndex: 8,
          actualPageIndex: 2,
          pageCount: 3,
        });
      }
      return backingFetcher(input);
    });
    const runtime = new BrowserInkRuntimeAdapter({ fetch: fetcher, objectUrls: urls, decodeFrame });
    await runtime.resolveRootUuid("online");

    const request = {
      uuid: ROOT_UUID,
      pageIndex: 8,
      sourceMode: "online" as const,
      display: legacyDisplay,
    };
    const first = await runtime.open(request);
    expect(first.page).toMatchObject({
      index: 2,
      count: 3,
      pixelSize: { width: 960, height: 540 },
    });
    expect(first.page.linkHitboxes).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetUuid: CHILD_UUID }),
      expect.objectContaining({
        targetUuid: ROOT_UUID,
        targetUrl: "https://example.com/source",
      }),
    ]));
    expect(renderCalls).toBe(1);
    expect(decodeFrame).toHaveBeenCalledOnce();

    const second = await runtime.open(request);
    expect(second.page.imageUrl).toBe(first.page.imageUrl);
    expect(renderCalls).toBe(1);
    expect(urls.create).toHaveBeenCalledOnce();
  });

  it("stages a missing deep-link display through on-demand render without catalog fallback", async () => {
    const fixture = await makePackage();
    const backingFetcher = fixtureFetcher(fixture);
    const display = { orientation: "landscape", fontLevel: -1, invert: false } as const;
    const seen: string[] = [];
    const decodeFrame = successfulDecoder();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith(`/${PACKAGE_ID}/render`)) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          documentUuid: CHILD_UUID,
          displayMeta: display,
          pageIndex: 0,
        });
        return onDemandResponse(fixture, { display, documentUuid: CHILD_UUID });
      }
      return backingFetcher(input);
    });
    const runtime = new BrowserInkRuntimeAdapter({ fetch: fetcher, objectUrls: objectUrls(), decodeFrame });

    await runtime.prepareOnlinePackage(PACKAGE_ID, {
      targetUuid: CHILD_UUID,
      pageIndex: 0,
      display,
    });
    expect(seen).not.toContain("/api/ink/v1/packages");
    expect(seen.filter((url) => url.endsWith(`/${PACKAGE_ID}/render`))).toHaveLength(1);
    expect(decodeFrame).toHaveBeenCalledOnce();

    const callsBeforeOpen = fetcher.mock.calls.length;
    const view = await runtime.open({
      uuid: CHILD_UUID,
      pageIndex: 0,
      sourceMode: "online",
      display,
    });
    expect(view.document).toMatchObject({ uuid: CHILD_UUID, parentUuid: ROOT_UUID });
    expect(fetcher).toHaveBeenCalledTimes(callsBeforeOpen);
  });

  it("passes displayMeta through source resolution and stages a current package's missing variant on demand", async () => {
    const fixture = await makePackage();
    const backingFetcher = fixtureFetcher(fixture);
    const sourceUrl = "https://example.com/current-landscape";
    const display = { orientation: "landscape", fontLevel: 2, invert: false } as const;
    let renderCalls = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/sources/resolve")) {
        expect(JSON.parse(String(init?.body))).toEqual({ url: sourceUrl, displayMeta: display });
        return Response.json({
          schemaVersion: "inkos.source-resolution/v1",
          normalizedUrl: sourceUrl,
          cached: true,
          status: "complete",
          job: null,
          packageId: PACKAGE_ID,
          entryUuid: ROOT_UUID,
        });
      }
      if (url.endsWith(`/${PACKAGE_ID}/render`)) {
        renderCalls += 1;
        return onDemandResponse(fixture, { display });
      }
      return backingFetcher(input);
    });
    const decodeFrame = successfulDecoder();
    const runtime = new BrowserInkRuntimeAdapter({ fetch: fetcher, objectUrls: objectUrls(), decodeFrame });

    await runtime.prepareOnlineSource(sourceUrl, { display });
    expect(renderCalls).toBe(1);
    expect(decodeFrame).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.map(([input]) => String(input))).not.toContain("/api/ink/v1/packages");
  });

  it("falls back to on-demand only when an exact packaged frame artifact returns 404", async () => {
    const fixture = await makePackage();
    const backingFetcher = fixtureFetcher(fixture);
    let renderCalls = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`/frames/${VARIANT_ID}/${ROOT_UUID}/0`)) {
        return new Response("gone", { status: 404 });
      }
      if (url.endsWith(`/${PACKAGE_ID}/render`)) {
        renderCalls += 1;
        return onDemandResponse(fixture, { display: BASE_DISPLAY });
      }
      return backingFetcher(input);
    });
    const decodeFrame = successfulDecoder();
    const runtime = new BrowserInkRuntimeAdapter({ fetch: fetcher, objectUrls: objectUrls(), decodeFrame });

    const view = await runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "online",
      display: BASE_DISPLAY,
    });
    expect(view.page.pixelSize).toEqual({ width: 540, height: 960 });
    expect(renderCalls).toBe(1);
    expect(decodeFrame).toHaveBeenCalledOnce();
  });

  it("rejects manifest lineage mismatches without committing the candidate package", async () => {
    const fixture = await makePackage();
    const backingFetcher = fixtureFetcher(fixture);
    const display = { orientation: "landscape", fontLevel: 0, invert: false } as const;
    const urls = objectUrls();
    const decodeFrame = successfulDecoder();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/${PACKAGE_ID}/render`)) {
        const manifestSha256 = await sha256Hex(encodeInkJson(fixture.manifest));
        expect(new Headers(init?.headers).get("If-Match")).toBe(`"${manifestSha256}"`);
        expect(JSON.parse(String(init?.body))).toMatchObject({ manifestSha256 });
        return Response.json({
          type: "about:blank",
          title: "Manifest precondition failed",
          status: 412,
          detail: "The package revision changed",
        }, { status: 412, headers: { "Cache-Control": "no-store" } });
      }
      return backingFetcher(input);
    });
    const runtime = new BrowserInkRuntimeAdapter({ fetch: fetcher, objectUrls: urls, decodeFrame });

    await expect(runtime.prepareOnlinePackage(PACKAGE_ID, { display }))
      .rejects.toThrow(/HTTP 412.*revision changed/u);
    expect(runtime.getRootUuid("online")).toBeUndefined();
    expect(decodeFrame).not.toHaveBeenCalled();
    expect(urls.create).not.toHaveBeenCalled();
  });

  it("atomically refreshes the same package after one revision-change response and preserves sourceUrl", async () => {
    const fixture = await makePackage();
    const latestManifest = inkPackageManifestSchema.parse({
      ...fixture.manifest,
      revision: fixture.manifest.revision + 1,
    });
    const backingFetcher = fixtureFetcher(fixture, { manifest: latestManifest });
    const sourceUrl = "https://example.com/hot-daily-home";
    const display = { orientation: "landscape", fontLevel: 0, invert: false } as const;
    const urls = objectUrls();
    const decodeFrame = successfulDecoder();
    let manifestGets = 0;
    let renderCalls = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/sources/resolve")) {
        return Response.json({
          schemaVersion: "inkos.source-resolution/v1",
          normalizedUrl: sourceUrl,
          cached: true,
          status: "complete",
          job: null,
          packageId: PACKAGE_ID,
          entryUuid: ROOT_UUID,
        });
      }
      if (url.endsWith(`/${PACKAGE_ID}/manifest`)) {
        manifestGets += 1;
        return manifestResponse(manifestGets === 1 ? fixture.manifest : latestManifest);
      }
      if (url.endsWith(`/${PACKAGE_ID}/render`)) {
        renderCalls += 1;
        return renderCalls === 1
          ? revisionChangedResponse()
          : onDemandResponse(fixture, { display, manifest: latestManifest });
      }
      return backingFetcher(input);
    });
    const runtime = new BrowserInkRuntimeAdapter({ fetch: fetcher, objectUrls: urls, decodeFrame });
    await runtime.prepareOnlineSource(sourceUrl, { display: BASE_DISPLAY });
    const before = await runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "online",
      display: BASE_DISPLAY,
    });

    const refreshed = await runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "online",
      display,
    });
    expect(refreshed.source).toMatchObject({
      packageId: PACKAGE_ID,
      sourceUrl,
      verified: true,
    });
    expect(refreshed.source.detail).toContain(`revision ${latestManifest.revision}`);
    expect(manifestGets).toBe(2);
    expect(renderCalls).toBe(2);
    expect(urls.create).toHaveBeenCalledTimes(2);
    expect(urls.revoke).toHaveBeenCalledWith(before.page.imageUrl);
    expect(decodeFrame).toHaveBeenCalledTimes(2);
  });

  it("refreshes and retries once when initial staged activation races a package revision", async () => {
    const fixture = await makePackage();
    const latestManifest = inkPackageManifestSchema.parse({
      ...fixture.manifest,
      revision: fixture.manifest.revision + 1,
    });
    const backingFetcher = fixtureFetcher(fixture, { manifest: latestManifest });
    const display = { orientation: "landscape", fontLevel: 1, invert: false } as const;
    let manifestGets = 0;
    let renderCalls = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/${PACKAGE_ID}/manifest`)) {
        manifestGets += 1;
        return manifestResponse(manifestGets === 1 ? fixture.manifest : latestManifest);
      }
      if (url.endsWith(`/${PACKAGE_ID}/render`)) {
        renderCalls += 1;
        return renderCalls === 1
          ? revisionChangedResponse()
          : onDemandResponse(fixture, { display, manifest: latestManifest });
      }
      return backingFetcher(input);
    });
    const decodeFrame = successfulDecoder();
    const runtime = new BrowserInkRuntimeAdapter({ fetch: fetcher, objectUrls: objectUrls(), decodeFrame });

    await runtime.prepareOnlinePackage(PACKAGE_ID, { display });
    expect(manifestGets).toBe(2);
    expect(renderCalls).toBe(2);
    expect(decodeFrame).toHaveBeenCalledOnce();
    const callsBeforeOpen = fetcher.mock.calls.length;
    const view = await runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "online",
      display,
    });
    expect(view.source.detail).toContain(`revision ${latestManifest.revision}`);
    expect(fetcher).toHaveBeenCalledTimes(callsBeforeOpen);
  });

  it("keeps the old package and frame when the refreshed manifest no longer contains the target UUID", async () => {
    const fixture = await makePackage();
    const latestManifest = inkPackageManifestSchema.parse({
      ...fixture.manifest,
      revision: fixture.manifest.revision + 1,
      documents: fixture.manifest.documents.filter((document) => document.uuid !== CHILD_UUID),
    });
    const backingFetcher = fixtureFetcher(fixture);
    const display = { orientation: "landscape", fontLevel: 0, invert: false } as const;
    const urls = objectUrls();
    let manifestGets = 0;
    let renderCalls = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/${PACKAGE_ID}/manifest`)) {
        manifestGets += 1;
        return manifestResponse(manifestGets === 1 ? fixture.manifest : latestManifest);
      }
      if (url.endsWith(`/${PACKAGE_ID}/render`)) {
        renderCalls += 1;
        return revisionChangedResponse();
      }
      return backingFetcher(input);
    });
    const runtime = new BrowserInkRuntimeAdapter({ fetch: fetcher, objectUrls: urls });
    const before = await runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "online",
      display: BASE_DISPLAY,
    });

    await expect(runtime.open({
      uuid: CHILD_UUID,
      pageIndex: 0,
      sourceMode: "online",
      display,
    })).rejects.toThrow(/不在当前包中/u);
    expect(manifestGets).toBe(2);
    expect(renderCalls).toBe(1);
    expect(urls.revoke).not.toHaveBeenCalled();
    const after = await runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "online",
      display: BASE_DISPLAY,
    });
    expect(after.page.imageUrl).toBe(before.page.imageUrl);
    expect(after.source.detail).toContain(`revision ${fixture.manifest.revision}`);
  });

  it("stops after a second revision-change response and does not commit the refreshed candidate", async () => {
    const fixture = await makePackage();
    const latestManifest = inkPackageManifestSchema.parse({
      ...fixture.manifest,
      revision: fixture.manifest.revision + 1,
    });
    const backingFetcher = fixtureFetcher(fixture);
    const display = { orientation: "landscape", fontLevel: 0, invert: false } as const;
    const urls = objectUrls();
    let manifestGets = 0;
    let renderCalls = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/${PACKAGE_ID}/manifest`)) {
        manifestGets += 1;
        return manifestResponse(manifestGets === 1 ? fixture.manifest : latestManifest);
      }
      if (url.endsWith(`/${PACKAGE_ID}/render`)) {
        renderCalls += 1;
        return revisionChangedResponse();
      }
      return backingFetcher(input);
    });
    const runtime = new BrowserInkRuntimeAdapter({ fetch: fetcher, objectUrls: urls });
    const before = await runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "online",
      display: BASE_DISPLAY,
    });

    await expect(runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "online",
      display,
    })).rejects.toThrow(/HTTP 412/u);
    expect(manifestGets).toBe(2);
    expect(renderCalls).toBe(2);
    expect(urls.revoke).not.toHaveBeenCalled();
    const after = await runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "online",
      display: BASE_DISPLAY,
    });
    expect(after.page.imageUrl).toBe(before.page.imageUrl);
    expect(after.source.detail).toContain(`revision ${fixture.manifest.revision}`);
  });

  it("does not reload the manifest for non-revision render failures", async () => {
    const fixture = await makePackage();
    const backingFetcher = fixtureFetcher(fixture);
    const display = { orientation: "landscape", fontLevel: 0, invert: false } as const;
    const urls = objectUrls();
    let manifestGets = 0;
    let renderCalls = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/${PACKAGE_ID}/manifest`)) {
        manifestGets += 1;
        return manifestResponse(fixture.manifest);
      }
      if (url.endsWith(`/${PACKAGE_ID}/render`)) {
        renderCalls += 1;
        return Response.json({
          type: "about:blank",
          title: "Package frame rendering failed",
          status: 422,
          code: "RENDER_FAILED",
          detail: "renderer rejected this page",
        }, { status: 422, headers: { "Cache-Control": "no-store" } });
      }
      return backingFetcher(input);
    });
    const runtime = new BrowserInkRuntimeAdapter({ fetch: fetcher, objectUrls: urls });
    const before = await runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "online",
      display: BASE_DISPLAY,
    });

    await expect(runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "online",
      display,
    })).rejects.toThrow(/HTTP 422.*renderer rejected/u);
    expect(manifestGets).toBe(1);
    expect(renderCalls).toBe(1);
    expect(urls.revoke).not.toHaveBeenCalled();
    const after = await runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "online",
      display: BASE_DISPLAY,
    });
    expect(after.page.imageUrl).toBe(before.page.imageUrl);
  });

  it("rejects tampered on-demand headers, envelopes, and target graphs before decode or blob creation", async () => {
    const fixture = await makePackage();
    const display = { orientation: "landscape", fontLevel: 0, invert: false } as const;
    const outsideUuid = "00000000-0000-4000-8000-000000000088";
    const danglingFrameInteraction = {
      contentPath: "page.items[0].link",
      label: "越界目标",
      bounds: { x: 20, y: 100, width: 180, height: 80 },
      action: { type: "open-document", documentId: outsideUuid },
    };
    const danglingSidecarInteraction = {
      id: "page.items[0].link",
      contentPath: "page.items[0].link",
      label: "越界目标",
      bounds: { x: 20, y: 100, width: 180, height: 80 },
      targetUuid: outsideUuid,
    };
    const cases: ReadonlyArray<{
      label: string;
      options: Omit<OnDemandFixtureOptions, "display">;
      expected: RegExp;
    }> = [
      { label: "length", options: { contentLength: 1 }, expected: /字节数与 Content-Length/u },
      {
        label: "PNG hash",
        options: { headerOverrides: { "X-Ink-SHA256": "a".repeat(64) } },
        expected: /X-Ink-SHA256/u,
      },
      {
        label: "frame display",
        options: { framePatch: { displayMeta: BASE_DISPLAY } },
        expected: /frame manifest 与请求/u,
      },
      {
        label: "sidecar package",
        options: { sidecarPatch: { packageId: outsideUuid } },
        expected: /sidecar 与 package/u,
      },
      {
        label: "base64url",
        options: { headerOverrides: { "X-Ink-Sidecar": "%%%" } },
        expected: /X-Ink-Sidecar.*base64url/u,
      },
      {
        label: "target graph",
        options: {
          framePatch: { interactions: [danglingFrameInteraction] },
          sidecarPatch: { interactions: [danglingSidecarInteraction] },
        },
        expected: /包内不存在的 UUID/u,
      },
    ];

    for (const candidate of cases) {
      const backingFetcher = fixtureFetcher(fixture);
      const urls = objectUrls();
      const decodeFrame = successfulDecoder();
      const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith(`/${PACKAGE_ID}/render`)
        ? onDemandResponse(fixture, { display, ...candidate.options })
        : backingFetcher(input));
      const runtime = new BrowserInkRuntimeAdapter({ fetch: fetcher, objectUrls: urls, decodeFrame });
      await runtime.resolveRootUuid("online");

      await expect(runtime.open({
        uuid: ROOT_UUID,
        pageIndex: 0,
        sourceMode: "online",
        display,
      }), candidate.label).rejects.toThrow(candidate.expected);
      expect(decodeFrame, candidate.label).not.toHaveBeenCalled();
      expect(urls.create, candidate.label).not.toHaveBeenCalled();
    }
  });

  it("keeps the working online package when dynamic staging is aborted during browser decode", async () => {
    const fixture = await makePackage();
    const backingFetcher = fixtureFetcher(fixture);
    const display = { orientation: "landscape", fontLevel: 0, invert: false } as const;
    const controller = new AbortController();
    const urls = objectUrls();
    const decodeFrame = vi.fn(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith(`/${PACKAGE_ID}/render`)
      ? onDemandResponse(fixture, { display })
      : backingFetcher(input));
    const runtime = new BrowserInkRuntimeAdapter({ fetch: fetcher, objectUrls: urls, decodeFrame });
    const before = await runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "online",
      display: BASE_DISPLAY,
    });

    await expect(runtime.prepareOnlinePackage(PACKAGE_ID, {
      display,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(urls.revoke).not.toHaveBeenCalled();

    const after = await runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "online",
      display: BASE_DISPLAY,
    });
    expect(after.page.imageUrl).toBe(before.page.imageUrl);
    expect(urls.create).toHaveBeenCalledOnce();
  });

  it("polls a pending source to completion and activates the job's exact package", async () => {
    const fixture = await makePackage();
    const sourceUrl = "https://example.com/pending";
    const jobId = "00000000-0000-4000-8000-000000000077";
    const statusUrl = `/api/ink/v1/generator/jobs/${jobId}`;
    const backingFetcher = fixtureFetcher(fixture);
    let poll = 0;
    const seen: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith("/sources/resolve")) {
        return Response.json({
          schemaVersion: "inkos.source-resolution/v1",
          normalizedUrl: sourceUrl,
          cached: false,
          status: "queued",
          job: null,
          jobId,
          statusUrl,
        }, { status: 202 });
      }
      if (url === statusUrl) {
        poll += 1;
        const complete = poll === 2;
        return Response.json({
          schemaVersion: "inkos.generator-job/v1",
          jobId,
          status: complete ? "complete" : "running",
          phase: complete ? "complete" : "rendering",
          progress: { completed: complete ? 2 : 1, total: 2, message: complete ? "done" : "rendering" },
          statusUrl,
          ...(complete ? { package: { packageId: PACKAGE_ID } } : {}),
        });
      }
      return backingFetcher(input);
    });
    const runtime = new BrowserInkRuntimeAdapter({
      fetch: fetcher,
      objectUrls: objectUrls(),
      decodeFrame: successfulDecoder(),
      sourcePollIntervalMs: 0,
      sourceMaxPollAttempts: 3,
    });
    const progress: Array<{ phase: string; message: string }> = [];

    const selected = await runtime.prepareOnlineSource(sourceUrl, {
      display: { orientation: "portrait", fontLevel: 0, invert: false },
      onProgress: ({ phase, message }) => progress.push({ phase, message }),
    });
    expect(selected.packageId).toBe(PACKAGE_ID);
    expect(poll).toBe(2);
    expect(seen).not.toContain("/api/ink/v1/packages");
    expect(seen).toContain(`/api/ink/v1/packages/${PACKAGE_ID}/manifest`);
    expect(progress).toEqual([
      { phase: "resolving", message: "正在打开网页内容，请稍等。" },
      { phase: "rendering", message: "正在打开网页内容，请稍等。" },
      { phase: "loading-package", message: "正在打开网页内容，请稍等。" },
      { phase: "ready", message: "正在打开网页内容，请稍等。" },
    ]);
  });

  it("reports failed source jobs and aborts an in-flight status poll", async () => {
    const fixture = await makePackage();
    const jobId = "00000000-0000-4000-8000-000000000078";
    const statusUrl = `/api/ink/v1/generator/jobs/${jobId}`;
    const pending = (sourceUrl: string) => Response.json({
      schemaVersion: "inkos.source-resolution/v1",
      normalizedUrl: sourceUrl,
      cached: false,
      status: "running",
      job: null,
      jobId,
      statusUrl,
    }, { status: 202 });
    const failedRuntime = new BrowserInkRuntimeAdapter({
      fetch: async (input) => String(input).endsWith("/sources/resolve")
        ? pending("https://example.com/fail")
        : Response.json({
            schemaVersion: "inkos.generator-job/v1",
            jobId,
            status: "failed",
            phase: "fetching",
            progress: { completed: 0, total: 1, message: "failed" },
            statusUrl,
            error: { code: "FETCH_FAILED", message: "origin refused", retryable: true },
          }),
      objectUrls: objectUrls(),
      sourcePollIntervalMs: 0,
    });
    await expect(failedRuntime.prepareOnlineSource("https://example.com/fail"))
      .rejects.toThrow(/SOURCE_GENERATION_FAILED.*origin refused/u);

    const controller = new AbortController();
    const abortingRuntime = new BrowserInkRuntimeAdapter({
      fetch: async (input, init) => {
        if (String(input).endsWith("/sources/resolve")) return pending("https://example.com/abort");
        controller.abort();
        return new Promise((_resolve, reject) => {
          if (init?.signal?.aborted) reject(new DOMException("aborted", "AbortError"));
          else init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      },
      objectUrls: objectUrls(),
      sourcePollIntervalMs: 0,
    });
    await expect(abortingRuntime.prepareOnlineSource("https://example.com/abort", {
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(abortingRuntime.getRootUuid("online")).toBeUndefined();
    void fixture;
  });

  it("keeps the active online package and blob URLs when a URL candidate entry frame cannot decode", async () => {
    const fixture = await makePackage();
    const backingFetcher = fixtureFetcher(fixture);
    const sourceUrl = "https://example.com/replacement";
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/sources/resolve")) {
        return Response.json({
          schemaVersion: "inkos.source-resolution/v1",
          normalizedUrl: sourceUrl,
          cached: true,
          status: "complete",
          job: null,
          packageId: PACKAGE_ID,
          entryUuid: ROOT_UUID,
        });
      }
      return backingFetcher(input);
    });
    const urls = objectUrls();
    const runtime = new BrowserInkRuntimeAdapter({
      fetch: fetcher,
      objectUrls: urls,
      decodeFrame: vi.fn().mockRejectedValue(new Error("candidate PNG decode failed")),
    });
    await runtime.resolveRootUuid("online");
    const before = await runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "online",
      display: { orientation: "portrait", fontLevel: 0, invert: false },
    });

    await expect(runtime.prepareOnlineSource(sourceUrl, {
      display: { orientation: "portrait", fontLevel: 0, invert: false },
    })).rejects.toThrow(/candidate PNG decode failed/u);
    expect(urls.revoke).not.toHaveBeenCalled();
    const after = await runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "online",
      display: { orientation: "portrait", fontLevel: 0, invert: false },
    });
    expect(after.page.imageUrl).toBe(before.page.imageUrl);
    expect(after.source.verified).toBe(true);
  });

  it("keeps the active online package when URL activation is aborted during entry decode", async () => {
    const fixture = await makePackage();
    const backingFetcher = fixtureFetcher(fixture);
    const sourceUrl = "https://example.com/abort-candidate";
    const fetcher = async (input: RequestInfo | URL) => String(input).endsWith("/sources/resolve")
      ? Response.json({
          schemaVersion: "inkos.source-resolution/v1",
          normalizedUrl: sourceUrl,
          cached: true,
          status: "complete",
          job: null,
          packageId: PACKAGE_ID,
          entryUuid: ROOT_UUID,
        })
      : backingFetcher(input);
    const urls = objectUrls();
    const controller = new AbortController();
    const runtime = new BrowserInkRuntimeAdapter({
      fetch: fetcher,
      objectUrls: urls,
      decodeFrame: async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      },
    });
    await runtime.resolveRootUuid("online");
    const before = await runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "online",
      display: { orientation: "portrait", fontLevel: 0, invert: false },
    });

    await expect(runtime.prepareOnlineSource(sourceUrl, {
      display: { orientation: "portrait", fontLevel: 0, invert: false },
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(urls.revoke).not.toHaveBeenCalled();
    const after = await runtime.open({
      uuid: ROOT_UUID,
      pageIndex: 0,
      sourceMode: "online",
      display: { orientation: "portrait", fontLevel: 0, invert: false },
    });
    expect(after.page.imageUrl).toBe(before.page.imageUrl);
  });

  it("does not activate an online manifest after its catalog request is aborted", async () => {
    const controller = new AbortController();
    const runtime = new BrowserInkRuntimeAdapter({
      fetch: (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
      objectUrls: objectUrls(),
    });
    const resolving = runtime.resolveRootUuid("online", controller.signal);
    controller.abort();
    await expect(resolving).rejects.toMatchObject({ name: "AbortError" });
    expect(runtime.getRootUuid("online")).toBeUndefined();
  });
});
