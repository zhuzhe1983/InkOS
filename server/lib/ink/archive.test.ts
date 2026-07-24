import { strFromU8, strToU8, zipSync } from "fflate";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import {
  buildInkArchive,
  encodeInkJson,
  preflightInkZip,
  readInkArchive,
  sha256Hex,
  sha256HexFallback,
  verifyInkArchiveFiles,
} from "./archive";
import { assessInkCompatibility } from "./compatibility";
import {
  inkPackageManifestSchema,
  packagedDocument,
  type InkFrameSidecar,
  type InkPackageManifest,
} from "./contracts";
import { inkVariantId } from "./variants";

const PACKAGE = "00000000-0000-4000-8000-000000000099";
const ROOT = "00000000-0000-4000-8000-000000000001";
const CHILD = "00000000-0000-4000-8000-000000000002";
const displayMeta = { orientation: "portrait", invert: false, fontLevel: 0 } as const;
const variantId = inkVariantId("m5stack-paper-s3-portrait", displayMeta);

const encoder = new TextEncoder();

describe("SHA-256 integrity hashing", () => {
  it.each([
    ["empty", "", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "multi-block",
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
  ])("matches the NIST %s vector", async (_label, text, expected) => {
    const bytes = encoder.encode(text);
    expect(sha256HexFallback(bytes)).toBe(expected);
    expect(await sha256Hex(bytes)).toBe(expected);
  });

  it("hashes exactly the bytes in a non-zero-offset Uint8Array view", async () => {
    const storage = new Uint8Array(128);
    storage.fill(0xa5);
    storage.set(encoder.encode("abc"), 37);
    const view = storage.subarray(37, 40);
    const expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    expect(view.byteOffset).toBeGreaterThan(0);
    expect(sha256HexFallback(view)).toBe(expected);
    expect(await sha256Hex(view)).toBe(expected);
  });

  it("processes a large multi-block input without constructing a padded copy of it", () => {
    const storage = new Uint8Array(1_000_073);
    storage.fill(0x5a);
    const millionAs = storage.subarray(37, 1_000_037);
    millionAs.fill("a".charCodeAt(0));
    expect(millionAs.byteOffset).toBeGreaterThan(0);
    expect(sha256HexFallback(millionAs)).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    );
  });

  it("uses the strict fallback when WebCrypto is absent and matches the WebCrypto result", async () => {
    const bytes = encoder.encode("InkOS LAN HTTP fallback + integrity #1".repeat(257));
    const webCryptoHash = await sha256Hex(bytes);
    const fallbackHash = sha256HexFallback(bytes);
    expect(fallbackHash).toBe(webCryptoHash);

    vi.stubGlobal("crypto", undefined);
    try {
      expect(await sha256Hex(bytes)).toBe(fallbackHash);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

async function fixturePackage(targetUuid = CHILD) {
  const root = packagedDocument({
    uuid: ROOT,
    source: { title: "目录" },
    content: {
      schemaVersion: "inkos.content/v2",
      id: ROOT,
      revision: 1,
      locale: "zh-CN",
      page: {
        kind: "list",
        layout: "list",
        title: "目录",
        items: [{
          id: "child",
          title: "子页面",
          link: { label: "打开", target: { kind: "document", documentId: CHILD } },
        }],
      },
    },
  });
  const child = packagedDocument({
    uuid: CHILD,
    parentUuid: ROOT,
    source: { title: "子页面" },
    content: {
      schemaVersion: "inkos.content/v2",
      id: CHILD,
      revision: 1,
      locale: "zh-CN",
      page: { kind: "reader", content: [{ type: "paragraph", text: "正文" }] },
    },
  });

  const files = new Map<string, Uint8Array>();
  const indices: InkPackageManifest["documents"] = [];
  for (const document of [root, child]) {
    const documentPath = `documents/${document.uuid}.json`;
    const documentBytes = encodeInkJson(document);
    files.set(documentPath, documentBytes);

    const imagePath = `frames/${variantId}/${document.uuid}/0000.png`;
    const image = new Uint8Array(await sharp({
      create: { width: 540, height: 960, channels: 3, background: { r: 255, g: 255, b: 255 } },
    }).png().toBuffer());
    const imageSha256 = await sha256Hex(image);
    files.set(imagePath, image);

    const sidecarPath = `frames/${variantId}/${document.uuid}/0000.json`;
    const sidecar: InkFrameSidecar = {
      schemaVersion: "inkos.frame-sidecar/v1",
      packageId: PACKAGE,
      documentUuid: document.uuid,
      ...(document.parentUuid ? { parentUuid: document.parentUuid } : {}),
      variantId,
      pageIndex: 0,
      pageCount: 1,
      imagePath,
      imageSha256,
      logicalSize: { width: 540, height: 960 },
      interactions: document.uuid === ROOT ? [{
        id: "page.items[0].link",
        contentPath: "page.items[0].link",
        bounds: { x: 20, y: 100, width: 500, height: 100 },
        targetUuid,
      }] : [],
    };
    const sidecarBytes = encodeInkJson(sidecar);
    files.set(sidecarPath, sidecarBytes);

    indices.push({
      uuid: document.uuid,
      ...(document.parentUuid ? { parentUuid: document.parentUuid } : {}),
      title: document.source.title,
      kind: document.content.page.kind,
      documentPath,
      documentBytes: documentBytes.byteLength,
      documentSha256: await sha256Hex(documentBytes),
      variants: [{
        variantId,
        pageCount: 1,
        pages: [{
          pageIndex: 0,
          imagePath,
          imageBytes: image.byteLength,
          imageSha256,
          sidecarPath,
          sidecarBytes: sidecarBytes.byteLength,
          sidecarSha256: await sha256Hex(sidecarBytes),
        }],
      }],
    });
  }

  const manifest = inkPackageManifestSchema.parse({
    schemaVersion: "inkos.package/v1",
    packageId: PACKAGE,
    slug: "fixture",
    revision: 1,
    title: "Fixture",
    entryUuid: ROOT,
    createdAt: "2026-07-16T14:00:00+08:00",
    generator: { name: "inkos-test", version: "1.0.0" },
    compatibility: {
      formatMajor: 1,
      minimumClientVersions: { web: "1.0.0", paperS3: "1.0.0" },
      requiredCapabilities: ["navigation.parent-v1", "navigation.hitbox-v1"],
    },
    provenance: {
      seeds: [{ url: "https://example.com/fixture", title: "Fixture", retrievedAt: "2026-07-16T14:00:00+08:00" }],
      crawl: { maxDepth: 1, maxDocuments: 2 },
    },
    variants: [{
      id: variantId,
      profileId: "m5stack-paper-s3-portrait",
      screenProfileVersion: 2,
      displayMeta,
      logicalSize: { width: 540, height: 960 },
      displayRotation: 90,
      pixelFormat: "gray4",
      codec: "png",
    }],
    documents: indices,
  });
  return { manifest, files };
}

async function sourceImageFixture(progressive = false) {
  const document = packagedDocument({
    uuid: ROOT,
    source: { title: "Source JPEG" },
    content: {
      schemaVersion: "inkos.content/v2",
      id: ROOT,
      revision: 1,
      locale: "zh-CN",
      page: {
        kind: "image",
        layout: "contain",
        image: {
          source: { kind: "asset", assetId: "fixture/source-jpeg" },
          alt: "Source JPEG fixture",
        },
      },
    },
  });
  const documentPath = `documents/${ROOT}.json`;
  const documentBytes = encodeInkJson(document);
  const imagePath = `frames/${variantId}/${ROOT}/0000.png`;
  const fallback = new Uint8Array(await sharp({
    create: { width: 540, height: 960, channels: 3, background: { r: 128, g: 128, b: 128 } },
  }).png().toBuffer());
  const imageSha256 = await sha256Hex(fallback);
  const sourcePath = `sources/${ROOT}/0000.jpg`;
  const source = new Uint8Array(await sharp({
    create: { width: 540, height: 960, channels: 3, background: { r: 96, g: 128, b: 160 } },
  }).jpeg({ progressive }).toBuffer());
  const sourceImage = {
    path: sourcePath,
    bytes: source.byteLength,
    sha256: await sha256Hex(source),
    mediaType: "image/jpeg" as const,
    pixelSize: { width: 540, height: 960 },
    fit: "contain" as const,
  };
  const sidecarPath = `frames/${variantId}/${ROOT}/0000.json`;
  const sidecar: InkFrameSidecar = {
    schemaVersion: "inkos.frame-sidecar/v1",
    packageId: PACKAGE,
    documentUuid: ROOT,
    variantId,
    pageIndex: 0,
    pageCount: 1,
    imagePath,
    imageSha256,
    sourceImage,
    logicalSize: { width: 540, height: 960 },
    interactions: [],
  };
  const sidecarBytes = encodeInkJson(sidecar);
  const files = new Map<string, Uint8Array>([
    [documentPath, documentBytes],
    [imagePath, fallback],
    [sourcePath, source],
    [sidecarPath, sidecarBytes],
  ]);
  const manifest = inkPackageManifestSchema.parse({
    schemaVersion: "inkos.package/v1",
    packageId: PACKAGE,
    slug: "source-image-fixture",
    revision: 1,
    title: "Source image fixture",
    entryUuid: ROOT,
    createdAt: "2026-07-24T14:00:00+08:00",
    generator: { name: "inkos-test", version: "1.0.0" },
    compatibility: {
      formatMajor: 1,
      minimumClientVersions: { web: "1.0.0", paperS3: "1.0.0" },
      requiredCapabilities: [
        "navigation.parent-v1",
        "frame.source-image-jpeg-v1",
      ],
    },
    provenance: {
      seeds: [{
        url: "https://picsum.photos/id/250/540/960?grayscale",
        title: "Source JPEG",
        retrievedAt: "2026-07-24T14:00:00+08:00",
      }],
      crawl: { maxDepth: 0, maxDocuments: 1 },
    },
    variants: [{
      id: variantId,
      profileId: "m5stack-paper-s3-portrait",
      screenProfileVersion: 2,
      displayMeta,
      logicalSize: { width: 540, height: 960 },
      displayRotation: 90,
      pixelFormat: "gray4",
      codec: "png",
    }],
    documents: [{
      uuid: ROOT,
      title: document.source.title,
      kind: "image",
      documentPath,
      documentBytes: documentBytes.byteLength,
      documentSha256: await sha256Hex(documentBytes),
      variants: [{
        variantId,
        pageCount: 1,
        pages: [{
          pageIndex: 0,
          imagePath,
          imageBytes: fallback.byteLength,
          imageSha256,
          sourceImage,
          sidecarPath,
          sidecarBytes: sidecarBytes.byteLength,
          sidecarSha256: await sha256Hex(sidecarBytes),
        }],
      }],
    }],
  });
  return { manifest, files, source, fallback };
}

describe(".ink deterministic archive", () => {
  it("reads legacy normal-polarity capability declarations but rejects inverse variants", async () => {
    const fixture = await fixturePackage();
    const legacyNormal = structuredClone(fixture.manifest);
    legacyNormal.compatibility.requiredCapabilities.push("display.invert-v1");
    const parsedLegacy = inkPackageManifestSchema.parse(legacyNormal);
    expect(parsedLegacy.variants[0].displayMeta.invert).toBe(false);
    expect(assessInkCompatibility(parsedLegacy, {
      client: "web",
      version: "1.0.0",
      formatMajor: 1,
      capabilities: ["navigation.parent-v1", "navigation.hitbox-v1"],
      profileIds: ["m5stack-paper-s3-portrait"],
    })).toEqual({ compatible: true, errors: [] });

    const inverse = structuredClone(legacyNormal);
    inverse.variants[0].displayMeta.invert = true;
    expect(() => inkPackageManifestSchema.parse(inverse)).toThrow(/invert is no longer supported/u);
  });

  it("round-trips documents, frames and navigation sidecars deterministically", async () => {
    const fixture = await fixturePackage();
    const first = await buildInkArchive(fixture.manifest, fixture.files);
    const second = await buildInkArchive(fixture.manifest, fixture.files);
    expect(await sha256Hex(first)).toBe(await sha256Hex(second));

    const unpacked = await readInkArchive(first);
    expect(unpacked.manifest.entryUuid).toBe(ROOT);
    expect(unpacked.documents.get(CHILD)?.parentUuid).toBe(ROOT);
    expect([...unpacked.sidecars.values()][0].interactions[0].targetUuid).toBe(CHILD);
  });

  it("round-trips a baseline source JPEG while retaining the verified PNG fallback", async () => {
    const fixture = await sourceImageFixture();
    const archive = await buildInkArchive(fixture.manifest, fixture.files);
    const unpacked = await readInkArchive(archive);
    const page = unpacked.manifest.documents[0].variants[0].pages[0];
    const sidecar = unpacked.sidecars.get(page.sidecarPath);

    expect(page.imagePath).toMatch(/\.png$/u);
    expect(unpacked.files.get(page.imagePath)).toEqual(fixture.fallback);
    expect(page.sourceImage).toMatchObject({
      mediaType: "image/jpeg",
      pixelSize: { width: 540, height: 960 },
      fit: "contain",
    });
    expect(unpacked.files.get(page.sourceImage!.path)).toEqual(fixture.source);
    expect(sidecar?.sourceImage).toEqual(page.sourceImage);
  });

  it("requires the source-image capability and rejects progressive JPEG input", async () => {
    const baseline = await sourceImageFixture();
    const missingCapability = structuredClone(baseline.manifest);
    missingCapability.compatibility.requiredCapabilities = ["navigation.parent-v1"];
    expect(() => inkPackageManifestSchema.parse(missingCapability)).toThrow(
      /frame\.source-image-jpeg-v1/u,
    );

    const progressive = await sourceImageFixture(true);
    await expect(buildInkArchive(progressive.manifest, progressive.files)).rejects.toThrow(
      /baseline JPEG/u,
    );
  });

  it("encodes a timezone-independent DOS epoch in local and central headers", async () => {
    const fixture = await fixturePackage();
    const archive = await buildInkArchive(fixture.manifest, fixture.files);
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    let eocd = archive.byteLength - 22;
    while (eocd > 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd -= 1;
    const central = view.getUint32(eocd + 16, true);

    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(10, true)).toBe(0); // 00:00:00
    expect(view.getUint16(12, true)).toBe(0x0021); // 1980-01-01
    expect(view.getUint32(central, true)).toBe(0x02014b50);
    expect(view.getUint16(central + 12, true)).toBe(0);
    expect(view.getUint16(central + 14, true)).toBe(0x0021);
  });

  it("rejects content corruption before clients activate the package", async () => {
    const fixture = await fixturePackage();
    const manifestBytes = encodeInkJson(fixture.manifest);
    const files = new Map(fixture.files);
    files.set("ink-manifest.json", manifestBytes);
    const documentPath = fixture.manifest.documents[0].documentPath;
    files.set(documentPath, strToU8(`${strFromU8(files.get(documentPath)!)} `));
    await expect(verifyInkArchiveFiles(fixture.manifest, files)).rejects.toThrow(/bytes|SHA-256/u);
  });

  it("rejects dangling link UUIDs", async () => {
    const fixture = await fixturePackage("00000000-0000-4000-8000-000000000404");
    await expect(buildInkArchive(fixture.manifest, fixture.files)).rejects.toThrow(/links missing UUID/u);
  });

  it("rejects unsafe paths and missing parent relationships", async () => {
    const fixture = await fixturePackage();
    const raw = structuredClone(fixture.manifest) as unknown as Record<string, unknown>;
    const documents = raw.documents as Array<Record<string, unknown>>;
    documents[0].documentPath = "../escape.json";
    expect(() => inkPackageManifestSchema.parse(raw)).toThrow(/normalized relative archive path/u);

    const noParent = structuredClone(fixture.manifest) as unknown as Record<string, unknown>;
    delete (noParent.documents as Array<Record<string, unknown>>)[1].parentUuid;
    expect(() => inkPackageManifestSchema.parse(noParent)).toThrow(/requires a parentUuid/u);
  });

  it("rejects unsafe ZIP entry paths before extraction", () => {
    const archive = zipSync({ "../escape.txt": strToU8("escape") });
    expect(() => preflightInkZip(archive)).toThrow(/unsafe path/u);
  });

  it("rejects a compressed ZIP whose declared expansion exceeds the limit", async () => {
    const archive = zipSync({ "large.txt": new Uint8Array(64 * 1024) }, { level: 9 });
    expect(archive.byteLength).toBeLessThan(1_024);
    expect(() => preflightInkZip(archive, 1_024)).toThrow(/expanded limit/u);
    await expect(readInkArchive(archive, { maxExpandedBytes: 1_024 })).rejects.toThrow(/expanded limit/u);
  });
});

describe(".ink client compatibility", () => {
  it("requires the declared format, version, capabilities and display profile", async () => {
    const { manifest } = await fixturePackage();
    expect(assessInkCompatibility(manifest, {
      client: "web",
      version: "1.0.0",
      formatMajor: 1,
      capabilities: ["navigation.parent-v1", "navigation.hitbox-v1"],
      profileIds: ["m5stack-paper-s3-portrait"],
    })).toEqual({ compatible: true, errors: [] });

    const rejected = assessInkCompatibility(manifest, {
      client: "paperS3",
      version: "0.9.0",
      formatMajor: 2,
      capabilities: ["navigation.parent-v1"],
      profileIds: ["m5stack-xiaozhi-card"],
    });
    expect(rejected.compatible).toBe(false);
    expect(rejected.errors).toHaveLength(4);
  });
});
