import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import {
  inkFrameSidecarSchema,
  inkPathSchema,
  inkPackageManifestSchema,
  packagedDocumentSchema,
  type InkFrameSidecar,
  type InkPackageManifest,
  type PackagedDocument,
} from "./contracts";

const MANIFEST_PATH = "ink-manifest.json";
// ZIP stores a timezone-free DOS wall-clock value. Constructing this as local
// midnight makes the encoded bytes 1980-01-01 00:00 in every host timezone.
const FIXED_ZIP_TIME = new Date(1980, 0, 1, 0, 0, 0, 0);
const DEFAULT_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 8_192;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_EXTRA_FIELD = 0x0001;

export interface InkArchiveContents {
  manifest: InkPackageManifest;
  documents: ReadonlyMap<string, PackagedDocument>;
  sidecars: ReadonlyMap<string, InkFrameSidecar>;
  files: ReadonlyMap<string, Uint8Array>;
}

export interface InkArchiveLimits {
  maxArchiveBytes?: number;
  maxExpandedBytes?: number;
}

interface PreflightZipEntry {
  path: string;
  flags: number;
  compression: number;
  crc32: number;
  compressedBytes: number;
  expandedBytes: number;
  localHeaderOffset: number;
}

interface PreflightZipResult {
  entries: readonly PreflightZipEntry[];
  expandedBytes: number;
}

function findEndOfCentralDirectory(archive: Uint8Array, view: DataView): number {
  if (archive.byteLength < 22) throw new Error("Ink archive is not a complete ZIP file");
  const firstPossibleOffset = Math.max(0, archive.byteLength - 22 - 65_535);
  for (let offset = archive.byteLength - 22; offset >= firstPossibleOffset; offset -= 1) {
    if (view.getUint32(offset, true) !== ZIP_EOCD_SIGNATURE) continue;
    const commentBytes = view.getUint16(offset + 20, true);
    if (offset + 22 + commentBytes === archive.byteLength) return offset;
  }
  throw new Error("Ink archive has no valid ZIP end-of-directory record");
}

function decodeZipPath(bytes: Uint8Array, flags: number): string {
  const isUtf8 = (flags & 0x0800) !== 0;
  if (!isUtf8 && bytes.some((byte) => byte > 0x7f)) {
    throw new Error("Ink archive paths must be UTF-8 or ASCII");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Ink archive contains an invalid UTF-8 path");
  }
}

function assertSupportedZipExtra(extra: Uint8Array): void {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  let offset = 0;
  while (offset < extra.byteLength) {
    if (offset + 4 > extra.byteLength) throw new Error("Ink archive has a malformed ZIP extra field");
    const kind = view.getUint16(offset, true);
    const bytes = view.getUint16(offset + 2, true);
    offset += 4;
    if (offset + bytes > extra.byteLength) throw new Error("Ink archive has a malformed ZIP extra field");
    if (kind === ZIP64_EXTRA_FIELD) throw new Error("Ink archive uses unsupported ZIP64 metadata");
    offset += bytes;
  }
}

function assertSupportedZipFlags(flags: number): void {
  if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0) {
    throw new Error("Ink archive uses unsupported ZIP encryption");
  }
  if ((flags & 0x0008) !== 0) {
    throw new Error("Ink archive uses unsupported ZIP data descriptors");
  }
}

/**
 * Checks central-directory sizes and paths before any entry is decompressed.
 * Browser clients call this on untrusted local files to avoid allocating a ZIP
 * bomb before the expanded-byte limit can be enforced.
 */
export function preflightInkZip(
  archive: Uint8Array,
  maxExpandedBytes = DEFAULT_MAX_EXPANDED_BYTES,
): PreflightZipResult {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const eocdOffset = findEndOfCentralDirectory(archive, view);
  const disk = view.getUint16(eocdOffset + 4, true);
  const centralDisk = view.getUint16(eocdOffset + 6, true);
  const diskEntries = view.getUint16(eocdOffset + 8, true);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralBytes = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);

  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount) {
    throw new Error("Ink archive uses unsupported multi-disk ZIP metadata");
  }
  if (
    entryCount === 0xffff ||
    centralBytes === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error("Ink archive uses unsupported ZIP64 metadata");
  }
  if (entryCount > MAX_ZIP_ENTRIES) {
    throw new Error(`Ink archive exceeds the ${MAX_ZIP_ENTRIES} entry limit`);
  }
  if (centralOffset + centralBytes !== eocdOffset) {
    throw new Error("Ink archive has an invalid ZIP central-directory range");
  }

  const entries: PreflightZipEntry[] = [];
  const paths = new Set<string>();
  let expandedBytes = 0;
  let offset = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocdOffset || view.getUint32(offset, true) !== ZIP_CENTRAL_SIGNATURE) {
      throw new Error("Ink archive has a malformed ZIP central directory");
    }
    const madeByHost = view.getUint8(offset + 5);
    const flags = view.getUint16(offset + 8, true);
    const compression = view.getUint16(offset + 10, true);
    const crc32 = view.getUint32(offset + 16, true);
    const compressedBytes = view.getUint32(offset + 20, true);
    const uncompressedBytes = view.getUint32(offset + 24, true);
    const pathBytes = view.getUint16(offset + 28, true);
    const extraBytes = view.getUint16(offset + 30, true);
    const commentBytes = view.getUint16(offset + 32, true);
    const entryDisk = view.getUint16(offset + 34, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const entryEnd = offset + 46 + pathBytes + extraBytes + commentBytes;
    if (entryEnd > eocdOffset) throw new Error("Ink archive has a truncated ZIP entry");

    assertSupportedZipFlags(flags);
    if (compression !== 0 && compression !== 8) {
      throw new Error(`Ink archive uses unsupported ZIP compression method ${compression}`);
    }
    if (
      compressedBytes === 0xffffffff ||
      uncompressedBytes === 0xffffffff ||
      localHeaderOffset === 0xffffffff ||
      entryDisk === 0xffff
    ) {
      throw new Error("Ink archive uses unsupported ZIP64 metadata");
    }
    if (entryDisk !== 0) throw new Error("Ink archive uses unsupported multi-disk ZIP metadata");
    if (compression === 0 && compressedBytes !== uncompressedBytes) {
      throw new Error("Ink archive has an invalid stored ZIP entry");
    }
    const unixMode = externalAttributes >>> 16;
    if (madeByHost === 3 && (unixMode & 0xf000) === 0xa000) {
      throw new Error("Ink archive contains an unsupported symbolic link");
    }

    const encodedPath = archive.subarray(offset + 46, offset + 46 + pathBytes);
    const path = decodeZipPath(encodedPath, flags);
    if (!inkPathSchema.safeParse(path).success) {
      throw new Error(`Ink archive contains unsafe path '${path}'`);
    }
    if (paths.has(path)) throw new Error(`Ink archive contains duplicate path '${path}'`);
    paths.add(path);
    assertSupportedZipExtra(archive.subarray(offset + 46 + pathBytes, offset + 46 + pathBytes + extraBytes));

    expandedBytes += uncompressedBytes;
    if (expandedBytes > maxExpandedBytes) {
      throw new Error(`Ink archive exceeds the ${maxExpandedBytes} byte expanded limit`);
    }
    entries.push({
      path,
      flags,
      compression,
      crc32,
      compressedBytes,
      expandedBytes: uncompressedBytes,
      localHeaderOffset,
    });
    offset = entryEnd;
  }
  if (offset !== eocdOffset) throw new Error("Ink archive has trailing ZIP central-directory data");

  const occupiedRanges: Array<{ start: number; end: number }> = [];
  for (const entry of entries) {
    const local = entry.localHeaderOffset;
    if (local + 30 > centralOffset || view.getUint32(local, true) !== ZIP_LOCAL_SIGNATURE) {
      throw new Error(`Ink archive has an invalid local header for '${entry.path}'`);
    }
    const flags = view.getUint16(local + 6, true);
    const compression = view.getUint16(local + 8, true);
    const crc32 = view.getUint32(local + 14, true);
    const compressedBytes = view.getUint32(local + 18, true);
    const expandedEntryBytes = view.getUint32(local + 22, true);
    const pathBytes = view.getUint16(local + 26, true);
    const extraBytes = view.getUint16(local + 28, true);
    assertSupportedZipFlags(flags);
    const dataOffset = local + 30 + pathBytes + extraBytes;
    const dataEnd = dataOffset + compressedBytes;
    if (dataEnd > centralOffset) throw new Error(`Ink archive has truncated data for '${entry.path}'`);
    if (
      flags !== entry.flags ||
      compression !== entry.compression ||
      crc32 !== entry.crc32 ||
      compressedBytes !== entry.compressedBytes ||
      expandedEntryBytes !== entry.expandedBytes
    ) {
      throw new Error(`Ink archive local header does not match '${entry.path}'`);
    }
    const localPath = decodeZipPath(archive.subarray(local + 30, local + 30 + pathBytes), flags);
    if (localPath !== entry.path) throw new Error(`Ink archive local path does not match '${entry.path}'`);
    assertSupportedZipExtra(archive.subarray(local + 30 + pathBytes, dataOffset));
    occupiedRanges.push({ start: local, end: dataEnd });
  }
  occupiedRanges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < occupiedRanges.length; index += 1) {
    if (occupiedRanges[index].start < occupiedRanges[index - 1].end) {
      throw new Error("Ink archive contains overlapping ZIP entries");
    }
  }

  return { entries, expandedBytes };
}

const SHA256_INITIAL_STATE = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function compressSha256Block(
  bytes: Uint8Array,
  offset: number,
  state: Uint32Array,
  words: Uint32Array,
): void {
  for (let index = 0; index < 16; index += 1) {
    const start = offset + index * 4;
    words[index] = (
      (bytes[start] << 24)
      | (bytes[start + 1] << 16)
      | (bytes[start + 2] << 8)
      | bytes[start + 3]
    ) >>> 0;
  }
  for (let index = 16; index < 64; index += 1) {
    const left = words[index - 15];
    const right = words[index - 2];
    const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
    const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
    words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
  }

  let a = state[0];
  let b = state[1];
  let c = state[2];
  let d = state[3];
  let e = state[4];
  let f = state[5];
  let g = state[6];
  let h = state[7];
  for (let index = 0; index < 64; index += 1) {
    const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
    const choose = (e & f) ^ (~e & g);
    const temporary1 = (h + sum1 + choose + SHA256_ROUND_CONSTANTS[index] + words[index]) >>> 0;
    const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
    const majority = (a & b) ^ (a & c) ^ (b & c);
    const temporary2 = (sum0 + majority) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + temporary1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (temporary1 + temporary2) >>> 0;
  }

  state[0] = (state[0] + a) >>> 0;
  state[1] = (state[1] + b) >>> 0;
  state[2] = (state[2] + c) >>> 0;
  state[3] = (state[3] + d) >>> 0;
  state[4] = (state[4] + e) >>> 0;
  state[5] = (state[5] + f) >>> 0;
  state[6] = (state[6] + g) >>> 0;
  state[7] = (state[7] + h) >>> 0;
}

function wordsToHex(words: Uint32Array): string {
  let result = "";
  for (const word of words) result += word.toString(16).padStart(8, "0");
  return result;
}

/**
 * Dependency-free SHA-256 for non-secure browser origins where WebCrypto is
 * unavailable. It streams complete blocks from the supplied view, so neither
 * a non-zero byteOffset nor a large input requires copying the whole payload.
 */
export function sha256HexFallback(data: Uint8Array): string {
  const state = new Uint32Array(SHA256_INITIAL_STATE);
  const words = new Uint32Array(64);
  let offset = 0;
  while (offset + 64 <= data.byteLength) {
    compressSha256Block(data, offset, state, words);
    offset += 64;
  }

  const remaining = data.byteLength - offset;
  const finalBytes = remaining < 56 ? 64 : 128;
  const finalBlock = new Uint8Array(finalBytes);
  finalBlock.set(data.subarray(offset), 0);
  finalBlock[remaining] = 0x80;
  const bitLength = data.byteLength * 8;
  const finalView = new DataView(finalBlock.buffer);
  finalView.setUint32(finalBytes - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  finalView.setUint32(finalBytes - 4, bitLength >>> 0, false);
  compressSha256Block(finalBlock, 0, state, words);
  if (finalBytes === 128) compressSha256Block(finalBlock, 64, state, words);
  return wordsToHex(state);
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle && typeof subtle.digest === "function") {
    try {
      const digest = await subtle.digest("SHA-256", data as BufferSource);
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    } catch {
      // Some HTTP/non-secure browser contexts expose crypto but reject subtle;
      // the strict implementation below still performs the full verification.
    }
  }
  return sha256HexFallback(data);
}

function declaredArtifacts(manifest: InkPackageManifest): Array<{ path: string; bytes: number; sha256: string }> {
  return manifest.documents.flatMap((document) => [
    { path: document.documentPath, bytes: document.documentBytes, sha256: document.documentSha256 },
    ...document.variants.flatMap((variant) => variant.pages.flatMap((page) => [
      { path: page.imagePath, bytes: page.imageBytes, sha256: page.imageSha256 },
      ...(page.sourceImage ? [{
        path: page.sourceImage.path,
        bytes: page.sourceImage.bytes,
        sha256: page.sourceImage.sha256,
      }] : []),
      { path: page.sidecarPath, bytes: page.sidecarBytes, sha256: page.sidecarSha256 },
    ])),
  ]);
}

async function verifyDeclaredFiles(
  manifest: InkPackageManifest,
  files: ReadonlyMap<string, Uint8Array>,
): Promise<void> {
  const declared = declaredArtifacts(manifest);
  const expectedPaths = new Set([MANIFEST_PATH, ...declared.map((artifact) => artifact.path)]);
  const actualPaths = new Set(files.keys());

  for (const path of expectedPaths) {
    if (!actualPaths.has(path)) throw new Error(`Ink archive is missing '${path}'`);
  }
  for (const path of actualPaths) {
    if (!expectedPaths.has(path)) throw new Error(`Ink archive contains undeclared file '${path}'`);
  }

  for (const artifact of declared) {
    const data = files.get(artifact.path);
    if (!data) throw new Error(`Ink archive is missing '${artifact.path}'`);
    if (data.byteLength !== artifact.bytes) {
      throw new Error(`Ink artifact '${artifact.path}' has ${data.byteLength} bytes; expected ${artifact.bytes}`);
    }
    const hash = await sha256Hex(data);
    if (hash !== artifact.sha256) throw new Error(`Ink artifact '${artifact.path}' failed SHA-256 verification`);
  }
}

function pngSize(data: Uint8Array): { width: number; height: number } {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (signature.some((byte, index) => data[index] !== byte) || data.length < 24) {
    throw new Error("Frame artifact is not a PNG image");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function jpegSize(data: Uint8Array): { width: number; height: number } {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
    throw new Error("Source-image artifact is not a JPEG image");
  }
  const isStartOfFrame = (marker: number) =>
    marker >= 0xc0
    && marker <= 0xcf
    && marker !== 0xc4
    && marker !== 0xc8
    && marker !== 0xcc;
  let offset = 2;
  while (offset < data.length) {
    if (data[offset] !== 0xff) {
      throw new Error("Source-image artifact has malformed JPEG markers");
    }
    while (offset < data.length && data[offset] === 0xff) offset += 1;
    if (offset >= data.length) break;
    const marker = data[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > data.length) {
      throw new Error("Source-image artifact has a truncated JPEG segment");
    }
    const segmentBytes = (data[offset] << 8) | data[offset + 1];
    if (segmentBytes < 2 || offset + segmentBytes > data.length) {
      throw new Error("Source-image artifact has an invalid JPEG segment length");
    }
    if (isStartOfFrame(marker)) {
      if (segmentBytes < 8) throw new Error("Source-image artifact has a truncated JPEG frame header");
      if (marker !== 0xc0 || data[offset + 2] !== 8) {
        throw new Error("Source-image artifact must be an 8-bit baseline JPEG (SOF0)");
      }
      const height = (data[offset + 3] << 8) | data[offset + 4];
      const width = (data[offset + 5] << 8) | data[offset + 6];
      const components = data[offset + 7];
      if ((components !== 1 && components !== 3) || segmentBytes !== 8 + components * 3) {
        throw new Error("Source-image artifact must use one or three JPEG components");
      }
      if (width < 1 || height < 1) {
        throw new Error("Source-image artifact has invalid JPEG dimensions");
      }
      return { width, height };
    }
    offset += segmentBytes;
  }
  throw new Error("Source-image artifact has no JPEG frame header");
}

function sameSourceImage(
  left: InkFrameSidecar["sourceImage"],
  right: InkPackageManifest["documents"][number]["variants"][number]["pages"][number]["sourceImage"],
): boolean {
  if (!left || !right) return left === right;
  return left.path === right.path
    && left.bytes === right.bytes
    && left.sha256 === right.sha256
    && left.mediaType === right.mediaType
    && left.pixelSize.width === right.pixelSize.width
    && left.pixelSize.height === right.pixelSize.height
    && left.fit === right.fit;
}

async function parseAndCrossCheck(
  manifest: InkPackageManifest,
  files: ReadonlyMap<string, Uint8Array>,
): Promise<{
  documents: Map<string, PackagedDocument>;
  sidecars: Map<string, InkFrameSidecar>;
}> {
  const documents = new Map<string, PackagedDocument>();
  const sidecars = new Map<string, InkFrameSidecar>();
  const documentUuids = new Set(manifest.documents.map((document) => document.uuid));
  const variants = new Map(manifest.variants.map((variant) => [variant.id, variant]));

  for (const entry of manifest.documents) {
    const document = packagedDocumentSchema.parse(JSON.parse(strFromU8(files.get(entry.documentPath)!)));
    if (document.uuid !== entry.uuid || document.parentUuid !== entry.parentUuid) {
      throw new Error(`Document envelope '${entry.documentPath}' does not match its manifest index`);
    }
    if (document.content.page.kind !== entry.kind) {
      throw new Error(`Document '${entry.uuid}' kind does not match its manifest index`);
    }
    documents.set(document.uuid, document);

    for (const frameSet of entry.variants) {
      const variant = variants.get(frameSet.variantId);
      if (!variant) throw new Error(`Unknown frame variant '${frameSet.variantId}'`);
      for (const artifact of frameSet.pages) {
        const sidecar = inkFrameSidecarSchema.parse(JSON.parse(strFromU8(files.get(artifact.sidecarPath)!)));
        if (
          sidecar.packageId !== manifest.packageId ||
          sidecar.documentUuid !== entry.uuid ||
          sidecar.parentUuid !== entry.parentUuid ||
          sidecar.variantId !== frameSet.variantId ||
          sidecar.pageIndex !== artifact.pageIndex ||
          sidecar.pageCount !== frameSet.pageCount ||
          sidecar.imagePath !== artifact.imagePath ||
          sidecar.imageSha256 !== artifact.imageSha256 ||
          !sameSourceImage(sidecar.sourceImage, artifact.sourceImage)
        ) {
          throw new Error(`Frame sidecar '${artifact.sidecarPath}' does not match its manifest index`);
        }
        if (
          sidecar.logicalSize.width !== variant.logicalSize.width ||
          sidecar.logicalSize.height !== variant.logicalSize.height
        ) {
          throw new Error(`Frame sidecar '${artifact.sidecarPath}' has the wrong logical size`);
        }
        for (const interaction of sidecar.interactions) {
          if (!documentUuids.has(interaction.targetUuid)) {
            throw new Error(`Frame sidecar '${artifact.sidecarPath}' links missing UUID '${interaction.targetUuid}'`);
          }
        }
        const image = files.get(artifact.imagePath)!;
        const dimensions = pngSize(image);
        if (dimensions.width !== variant.logicalSize.width || dimensions.height !== variant.logicalSize.height) {
          throw new Error(`Frame '${artifact.imagePath}' does not match variant logical size`);
        }
        if (artifact.sourceImage) {
          const source = files.get(artifact.sourceImage.path)!;
          const sourceDimensions = jpegSize(source);
          if (
            sourceDimensions.width !== artifact.sourceImage.pixelSize.width
            || sourceDimensions.height !== artifact.sourceImage.pixelSize.height
          ) {
            throw new Error(`Source-image '${artifact.sourceImage.path}' does not match its declared pixelSize`);
          }
        }
        sidecars.set(artifact.sidecarPath, sidecar);
      }
    }
  }

  return { documents, sidecars };
}

export async function verifyInkArchiveFiles(
  rawManifest: unknown,
  files: ReadonlyMap<string, Uint8Array>,
): Promise<InkArchiveContents> {
  const manifest = inkPackageManifestSchema.parse(rawManifest);
  await verifyDeclaredFiles(manifest, files);
  const { documents, sidecars } = await parseAndCrossCheck(manifest, files);
  return { manifest, documents, sidecars, files };
}

export async function buildInkArchive(
  rawManifest: unknown,
  rawFiles: ReadonlyMap<string, Uint8Array>,
): Promise<Uint8Array> {
  const manifest = inkPackageManifestSchema.parse(rawManifest);
  const manifestBytes = strToU8(`${JSON.stringify(manifest, null, 2)}\n`);
  const files = new Map(rawFiles);
  files.set(MANIFEST_PATH, manifestBytes);
  await verifyInkArchiveFiles(manifest, files);

  const zipInput: Record<string, [Uint8Array, { level: 0 | 9; mtime: Date }]> = {};
  for (const path of [...files.keys()].sort()) {
    // PNG payloads are already compressed. Storing them avoids wasting CPU and
    // RAM on constrained clients; JPEG source images are already compressed as
    // well, while JSON still benefits from Deflate.
    const level = path.endsWith(".png") || path.endsWith(".jpg") ? 0 : 9;
    zipInput[path] = [files.get(path)!, { level, mtime: FIXED_ZIP_TIME }];
  }
  return zipSync(zipInput, { level: 9 });
}

export async function readInkArchive(
  archive: Uint8Array,
  limits: InkArchiveLimits = {},
): Promise<InkArchiveContents> {
  const maxArchiveBytes = limits.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
  const maxExpandedBytes = limits.maxExpandedBytes ?? DEFAULT_MAX_EXPANDED_BYTES;
  if (archive.byteLength > maxArchiveBytes) {
    throw new Error(`Ink archive exceeds the ${maxArchiveBytes} byte input limit`);
  }

  const preflight = preflightInkZip(archive, maxExpandedBytes);
  const extracted = unzipSync(archive);
  let expandedBytes = 0;
  const files = new Map<string, Uint8Array>();
  for (const [path, data] of Object.entries(extracted)) {
    expandedBytes += data.byteLength;
    if (expandedBytes > maxExpandedBytes) {
      throw new Error(`Ink archive exceeds the ${maxExpandedBytes} byte expanded limit`);
    }
    files.set(path, data);
  }
  if (files.size !== preflight.entries.length) {
    throw new Error("Ink archive extraction does not match its ZIP central directory");
  }
  for (const entry of preflight.entries) {
    const data = files.get(entry.path);
    if (!data || data.byteLength !== entry.expandedBytes) {
      throw new Error(`Ink archive extraction does not match '${entry.path}'`);
    }
  }

  const manifestBytes = files.get(MANIFEST_PATH);
  if (!manifestBytes) throw new Error(`Ink archive is missing '${MANIFEST_PATH}'`);
  const manifest = JSON.parse(strFromU8(manifestBytes));
  return verifyInkArchiveFiles(manifest, files);
}

export function encodeInkJson(value: unknown): Uint8Array {
  return strToU8(`${JSON.stringify(value, null, 2)}\n`);
}
