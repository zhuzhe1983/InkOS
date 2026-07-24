import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import sharp from "sharp";

import type { ContentDocument, ContentImage } from "./contracts";
import {
  collectContentImageOccurrences,
  imageSourceKey,
} from "./content-images";

export { imageSourceKey } from "./content-images";

const MAX_REDIRECTS = 4;
const MAX_DOWNLOAD_BYTES = 3 * 1024 * 1024;
const MAX_INPUT_PIXELS = 12_000_000;
const REQUEST_TIMEOUT_MS = 12_000;
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export interface ResolvedContentImage {
  dataUri: string;
  width: number;
  height: number;
  mimeType: "image/jpeg" | "image/png";
}

export type ImageResolution =
  | { status: "resolved"; image: ResolvedContentImage }
  | { status: "unavailable"; reason: string };

export interface AssetResolver {
  resolve(image: ContentImage): Promise<ImageResolution>;
}

export interface ControlledRemoteAssetResolverOptions {
  /** Exact hosts discovered by one already-validated server ingestion job. */
  allowedSourceHosts?: Iterable<string>;
  /** Redirect targets still require HTTPS and exclusively public DNS answers. */
  allowPublicRedirectHosts?: boolean;
  /**
   * Temporary app-only diagnostic normalization. It retains the existing URL,
   * SSRF, byte, pixel, redirect, MIME, and decode boundaries while avoiding
   * the normal photo JPEG transcode before the app emits a true-colour PNG.
   */
  normalization?: "default" | "diagnostic-raw-colour-png";
}

export async function resolveDocumentImages(
  document: ContentDocument,
  resolver: AssetResolver,
): Promise<ReadonlyMap<string, ImageResolution>> {
  const unique = new Map<string, ContentImage>();
  for (const { image } of collectContentImageOccurrences(document)) {
    unique.set(imageSourceKey(image), image);
  }

  const entries = await Promise.all(
    [...unique.entries()].map(async ([key, image]) => [key, await resolver.resolve(image)] as const),
  );
  return new Map(entries);
}

function normalizedHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/u, "");
}

function isAllowedSourceHost(hostname: string, jobHosts: ReadonlySet<string>): boolean {
  const host = hostname.toLowerCase();
  return host === "picsum.photos"
    || host === "covers.openlibrary.org"
    || host === "upload.wikimedia.org"
    || jobHosts.has(normalizedHost(host));
}

function isAllowedRedirectHost(hostname: string, jobHosts: ReadonlySet<string>): boolean {
  const host = hostname.toLowerCase();
  return isAllowedSourceHost(host, jobHosts)
    || host === "fastly.picsum.photos"
    || host === "archive.org"
    || /^ia\d+\.us\.archive\.org$/u.test(host);
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (isIP(normalized) === 4) {
    const [a, b] = normalized.split(".").map(Number);
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || a >= 224;
  }
  if (isIP(normalized) === 6) {
    return normalized === "::"
      || normalized === "::1"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || /^fe[89ab]/u.test(normalized)
      || normalized.startsWith("ff")
      || normalized.startsWith("::ffff:127.")
      || normalized.startsWith("::ffff:10.")
      || normalized.startsWith("::ffff:192.168.");
  }
  return true;
}

function isControlledEgressAddress(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split(".").map(Number);
  // Some managed development networks expose allowlisted public HTTPS hosts
  // through RFC 2544 egress addresses. Arbitrary hosts are still rejected
  // before DNS resolution, and TLS continues to authenticate the real host.
  return a === 198 && (b === 18 || b === 19);
}

async function validateRemoteUrl(
  url: URL,
  isRedirect: boolean,
  jobHosts: ReadonlySet<string>,
  allowPublicRedirectHosts: boolean,
): Promise<void> {
  if (url.protocol !== "https:") throw new Error("only HTTPS images are allowed");
  if (url.username || url.password) throw new Error("image URLs cannot contain credentials");
  const hostAllowed = isRedirect
    ? allowPublicRedirectHosts || isAllowedRedirectHost(url.hostname, jobHosts)
    : isAllowedSourceHost(url.hostname, jobHosts);
  if (!hostAllowed) throw new Error(`host '${url.hostname}' is not allowlisted`);

  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (
    addresses.length === 0
    || addresses.some(({ address }) => {
      return isPrivateAddress(address) && !isControlledEgressAddress(address);
    })
  ) {
    throw new Error(`host '${url.hostname}' did not resolve to a public address`);
  }
}

/**
 * Some image CDNs reject otherwise public assets when a server-side request
 * omits Referer. Send only the already-validated image URL's own origin.
 *
 * Constructing this after validateRemoteUrl keeps the existing HTTPS,
 * credentials, host, DNS, and redirect policy authoritative. URL.origin
 * intentionally excludes username, password, path, query, and fragment, so
 * neither source-page context nor URL-scoped secrets are disclosed.
 */
function ownOriginReferer(url: URL): string {
  return `${url.origin}/`;
}

async function readLimitedBody(response: Response): Promise<Buffer> {
  const announcedLength = Number(response.headers.get("content-length") ?? 0);
  if (announcedLength > MAX_DOWNLOAD_BYTES) throw new Error("image exceeds the 3 MB limit");
  if (!response.body) throw new Error("image response had no body");

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DOWNLOAD_BYTES) {
      await reader.cancel();
      throw new Error("image exceeds the 3 MB limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

async function fetchRemoteImage(
  initialUrl: string,
  jobHosts: ReadonlySet<string>,
  allowPublicRedirectHosts: boolean,
  renderIntent: ContentImage["renderIntent"],
  normalization: NonNullable<ControlledRemoteAssetResolverOptions["normalization"]>,
): Promise<ResolvedContentImage> {
  let current = new URL(initialUrl);

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    await validateRemoteUrl(current, redirect > 0, jobHosts, allowPublicRedirectHosts);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "image/webp,image/png,image/jpeg",
          Referer: ownOriginReferer(current),
          "User-Agent": "InkOS-Renderer/0.3",
        },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("image redirect did not include a location");
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) throw new Error(`image server returned HTTP ${response.status}`);

      const mimeType = response.headers.get("content-type")?.split(";", 1)[0].toLowerCase();
      if (!mimeType || !ALLOWED_MIME_TYPES.has(mimeType)) {
        throw new Error(`unsupported image MIME type '${mimeType ?? "unknown"}'`);
      }

      const input = await readLimitedBody(response);
      const pipeline = sharp(input, {
        animated: false,
        failOn: "warning",
        limitInputPixels: MAX_INPUT_PIXELS,
      }).rotate();
      const metadata = await pipeline.metadata();
      if (!metadata.width || !metadata.height) throw new Error("image dimensions are unavailable");
      if (metadata.width * metadata.height > MAX_INPUT_PIXELS) {
        throw new Error("image exceeds the 12 megapixel limit");
      }

      const resized = pipeline.resize({
        width: 1600,
        height: 1600,
        fit: "inside",
        withoutEnlargement: true,
      });
      if (normalization === "diagnostic-raw-colour-png") {
        const normalized = await resized
          .toColourspace("srgb")
          .png({ compressionLevel: 9, palette: false })
          .toBuffer({ resolveWithObject: true });
        return {
          dataUri: `data:image/png;base64,${normalized.data.toString("base64")}`,
          width: normalized.info.width,
          height: normalized.info.height,
          mimeType: "image/png",
        };
      }
      const preserveLineArt = renderIntent === "graphic" || renderIntent === "map";
      const normalized = preserveLineArt
        ? await resized
            .flatten({ background: "#ffffff" })
            .png({ compressionLevel: 9, palette: false })
            .toBuffer({ resolveWithObject: true })
        : await resized
            .jpeg({ quality: 86, chromaSubsampling: "4:4:4", mozjpeg: true })
            .toBuffer({ resolveWithObject: true });
      return {
        dataUri: `data:${preserveLineArt ? "image/png" : "image/jpeg"};base64,${normalized.data.toString("base64")}`,
        width: normalized.info.width,
        height: normalized.info.height,
        mimeType: preserveLineArt ? "image/png" : "image/jpeg",
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`image exceeded ${MAX_REDIRECTS} redirects`);
}

export class ControlledRemoteAssetResolver implements AssetResolver {
  private readonly cache = new Map<string, Promise<ImageResolution>>();
  private readonly allowedSourceHosts: ReadonlySet<string>;
  private readonly allowPublicRedirectHosts: boolean;
  private readonly normalization: NonNullable<
    ControlledRemoteAssetResolverOptions["normalization"]
  >;

  constructor(options: ControlledRemoteAssetResolverOptions = {}) {
    this.allowedSourceHosts = new Set(
      [...(options.allowedSourceHosts ?? [])]
        .map(normalizedHost)
        .filter((host) => host.length > 0),
    );
    this.allowPublicRedirectHosts = options.allowPublicRedirectHosts ?? false;
    this.normalization = options.normalization ?? "default";
  }

  resolve(image: ContentImage): Promise<ImageResolution> {
    const key = imageSourceKey(image);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const pending = this.resolveUncached(image);
    this.cache.set(key, pending);
    return pending;
  }

  private async resolveUncached(image: ContentImage): Promise<ImageResolution> {
    if (image.source.kind === "asset") {
      return { status: "unavailable", reason: "the bundled asset is not registered" };
    }

    try {
      return {
        status: "resolved",
        image: await fetchRemoteImage(
          image.source.url,
          this.allowedSourceHosts,
          this.allowPublicRedirectHosts,
          image.renderIntent,
          this.normalization,
        ),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "remote image resolution failed";
      return { status: "unavailable", reason };
    }
  }
}

export const defaultAssetResolver = new ControlledRemoteAssetResolver();
