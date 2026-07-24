import { createHash } from "node:crypto";
import { lookup as nodeLookup } from "node:dns/promises";
import { isIP } from "node:net";

import { load, type CheerioAPI } from "cheerio";

import {
  captureRenderedPage,
  SourceCaptureError,
  type CaptureRenderedPageOptions,
  type RenderedPageCapture,
} from "./chromium-capture";
import {
  renderedHtmlFragmentToMarkdown,
  renderedHtmlToMarkdown,
} from "./markdown";
import { isDecorativeImage } from "./decorative-image";
import { DEFAULT_RSS_STYLE } from "./rss-style";

const MAX_DEPTH = 4;
const MAX_DOCUMENTS = 64;
const MAX_CHILD_LINKS_PER_PAGE = 48;
const MAX_REDIRECTS = 4;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_JSON_BYTES = 1 * 1024 * 1024;
const MAX_PARSED_NODES = 20_000;
const MAX_BLOCKS_PER_PAGE = 256;
const MAX_IMAGES_PER_PAGE = 24;
const MAX_FEED_ITEMS_PER_PAGE = 48;
const MAX_NAVIGATION_ITEMS_PER_PAGE = 32;
const MAX_TOTAL_TEXT_CHARS = 240_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_URL_LENGTH = 2_048;

export const SOURCE_INGESTION_LIMITS = Object.freeze({
  maxDepth: MAX_DEPTH,
  maxDocuments: MAX_DOCUMENTS,
  maxChildLinksPerPage: MAX_CHILD_LINKS_PER_PAGE,
  maxRedirects: MAX_REDIRECTS,
  maxHtmlBytes: MAX_HTML_BYTES,
  maxJsonBytes: MAX_JSON_BYTES,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
});

export const WIKIMEDIA_USER_AGENT =
  "InkOS-Generator/1.0 (+https://inkos.dev; source-ingestion@inkos.dev)";

export type SourceErrorCode =
  | "INVALID_REQUEST"
  | "SOURCE_BLOCKED"
  | "SOURCE_UNREACHABLE"
  | "SOURCE_TOO_LARGE"
  | "EXTRACTION_EMPTY";

export class SourceIngestionError extends Error {
  readonly code: SourceErrorCode;
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    code: SourceErrorCode,
    message: string,
    options: { cause?: unknown; retryable?: boolean } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "SourceIngestionError";
    this.code = code;
    this.status = code === "INVALID_REQUEST" || code === "SOURCE_BLOCKED"
      ? 400
      : code === "SOURCE_TOO_LARGE"
        ? 413
        : 422;
    this.retryable = options.retryable ?? false;
  }
}

export type SemanticSourceBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "quote"; text: string; attribution?: string }
  | { type: "link"; link: { label: string; url: string } }
  | {
      type: "image";
      image: { url: string; alt: string; caption?: string };
    };

export interface CanonicalSourceLink {
  title: string;
  canonicalUrl: string;
}

export type SyndicationBodySource =
  | "rss-content-encoded"
  | "atom-content"
  | "rss-description"
  | "atom-summary";

export interface SemanticSourceArticleBody {
  source: SyndicationBodySource;
  quality: "substantive" | "teaser";
  blocks: SemanticSourceBlock[];
  links: CanonicalSourceLink[];
}

/**
 * One editorial entry discovered on an index/feed page. This is deliberately
 * semantic source data: it describes the entry and its destination without
 * carrying any device layout or pixel coordinates.
 */
export interface SemanticSourceFeedItem {
  title: string;
  summary?: string;
  author?: string;
  /** Normalized source publication time with an explicit UTC offset. */
  publishedAt?: string;
  image?: { url: string; alt: string };
  canonicalUrl: string;
  /** Inert, normalized RSS/Atom body used for a bounded offline detail fallback. */
  articleBody?: SemanticSourceArticleBody;
}

/**
 * A visible destination from the site's primary navigation. Navigation is
 * kept separate from editorial feed items and crawl edges so a full feed
 * cannot consume the menu's semantic budget.
 */
export interface SemanticSourceNavigationItem {
  title: string;
  canonicalUrl: string;
}

export interface SourceRevision {
  id: string;
  timestamp?: string;
  url?: string;
}

export interface SourceLicense {
  name: string;
  url?: string;
}

export interface SourceAttribution {
  name: string;
  url: string;
}

export interface SourceProvenance {
  provider: "wikimedia" | "web";
  sourceUrl: string;
  canonicalUrl: string;
  retrievedAt: string;
}

export interface SourceSyndicationMetadata {
  author?: string;
  publishedAt?: string;
  summary?: string;
}

export interface CanonicalSourcePage {
  canonicalUrl: string;
  parentCanonicalUrl?: string;
  depth: number;
  title: string;
  locale?: string;
  blocks: SemanticSourceBlock[];
  feedItems?: SemanticSourceFeedItem[];
  navigation?: SemanticSourceNavigationItem[];
  /** Visible content destinations, independent from which pages were crawled. */
  links?: CanonicalSourceLink[];
  childLinks: CanonicalSourceLink[];
  provenance: SourceProvenance;
  revision: SourceRevision | null;
  license: SourceLicense | null;
  attribution: SourceAttribution;
  /** True only for an explicit RSS/Atom channel, not a detected HTML card list. */
  isSyndicationFeed?: true;
  /** Feed-owned editorial metadata merged into a linked or embedded detail. */
  syndication?: SourceSyndicationMetadata;
}

export interface SourceIngestionRequest {
  seedUrl: string;
  maxDepth?: number;
  maxDocuments?: number;
  mode?: "http" | "chromium";
}

export interface SourceIngestionResult {
  seedUrl: string;
  entryCanonicalUrl: string;
  pages: CanonicalSourcePage[];
  limits: { maxDepth: number; maxDocuments: number };
  /** Millisecond stage timings aggregated across the bounded crawl. */
  timings?: Record<string, number>;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type LookupResult = { address: string; family: number };
type LookupLike = (hostname: string) => Promise<readonly LookupResult[]>;

export interface SourceIngestionDependencies {
  fetch?: FetchLike;
  lookup?: LookupLike;
  now?: () => Date;
  userAgent?: string;
  capture?: (
    url: string,
    options?: CaptureRenderedPageOptions,
  ) => Promise<RenderedPageCapture>;
}

interface RuntimeDependencies {
  fetch: FetchLike;
  lookup: LookupLike;
  now: () => Date;
  userAgent: string;
  capture: NonNullable<SourceIngestionDependencies["capture"]>;
}

interface DiscoveredLink {
  title: string;
  url: string;
}

interface IngestedPage extends Omit<CanonicalSourcePage, "parentCanonicalUrl" | "depth" | "childLinks"> {
  discoveredLinks: DiscoveredLink[];
  timings?: Record<string, number>;
}

interface QueueItem {
  url: string;
  depth: number;
  parentCanonicalUrl?: string;
  linkTitle?: string;
  syndicationItem?: SemanticSourceFeedItem;
}

interface SafeResponse {
  response: Response;
  body: Uint8Array;
  finalUrl: URL;
}

interface WikimediaMetadata {
  endpoint: URL;
  canonicalTitle: string;
  canonicalUrl: string;
  pageId: number;
  locale?: string;
  siteName: string;
  revision: SourceRevision | null;
  license: SourceLicense | null;
}

interface WikimediaSection {
  index: string;
  line: string;
  anchor: string;
}

interface WikimediaLink {
  ns?: number;
  title?: string;
  exists?: boolean;
}

function sourceError(
  code: SourceErrorCode,
  message: string,
  options?: { cause?: unknown; retryable?: boolean },
): SourceIngestionError {
  return new SourceIngestionError(code, message, options);
}

function normalizedText(value: string, maxLength = 20_000): string {
  return value
    .replace(/\u00a0/gu, " ")
    .replace(/[\t\r\n ]+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

function parseSeedUrl(value: string): URL {
  if (value.length > MAX_URL_LENGTH) {
    throw sourceError("INVALID_REQUEST", `seedUrl exceeds ${MAX_URL_LENGTH} characters`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw sourceError("INVALID_REQUEST", "seedUrl must be an absolute HTTPS URL", { cause: error });
  }
  if (url.protocol !== "https:") {
    throw sourceError("SOURCE_BLOCKED", "Only HTTPS source URLs are accepted");
  }
  if (url.username || url.password) {
    throw sourceError("SOURCE_BLOCKED", "Source URLs cannot contain credentials");
  }
  if (url.port && url.port !== "443") {
    throw sourceError("SOURCE_BLOCKED", "Source URLs cannot use a non-default port");
  }
  return url;
}

function normalizeRequestLimits(request: SourceIngestionRequest): {
  maxDepth: number;
  maxDocuments: number;
} {
  const requestedDepth = request.maxDepth ?? 1;
  const requestedDocuments = request.maxDocuments ?? 8;
  if (!Number.isInteger(requestedDepth) || requestedDepth < 0) {
    throw sourceError("INVALID_REQUEST", "maxDepth must be a non-negative integer");
  }
  if (!Number.isInteger(requestedDocuments) || requestedDocuments < 1) {
    throw sourceError("INVALID_REQUEST", "maxDocuments must be a positive integer");
  }
  return {
    maxDepth: Math.min(requestedDepth, MAX_DEPTH),
    maxDocuments: Math.min(requestedDocuments, MAX_DOCUMENTS),
  };
}

function ipv4Parts(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

function isNonPublicIpv4(address: string): boolean {
  const parts = ipv4Parts(address);
  if (!parts) return true;
  const [a, b, c] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 168)
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function mappedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  if (!lower.startsWith("::ffff:")) return null;
  const tail = lower.slice("::ffff:".length);
  if (isIP(tail) === 4) return tail;
  const groups = tail.split(":");
  if (groups.length !== 2 || groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))) return null;
  const high = Number.parseInt(groups[0], 16);
  const low = Number.parseInt(groups[1], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function isNonPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isNonPublicIpv4(address);
  if (family !== 6) return true;

  const lower = address.toLowerCase();
  const mapped = mappedIpv4(lower);
  if (mapped) return isNonPublicIpv4(mapped);

  const firstGroup = Number.parseInt(lower.split(":", 1)[0] || "0", 16);
  return lower === "::"
    || lower === "::1"
    || (firstGroup & 0xfe00) === 0xfc00 // fc00::/7 unique local
    || (firstGroup & 0xffc0) === 0xfe80 // fe80::/10 link local
    || (firstGroup & 0xff00) === 0xff00 // multicast
    || lower.startsWith("2001:db8:")
    || lower === "2001:db8::";
}

async function validatePublicUrl(url: URL, dependencies: RuntimeDependencies): Promise<void> {
  if (url.href.length > MAX_URL_LENGTH) {
    throw sourceError("SOURCE_BLOCKED", `Source URL exceeds ${MAX_URL_LENGTH} characters`);
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw sourceError("SOURCE_BLOCKED", "Source and redirect URLs must use credential-free HTTPS on port 443");
  }

  const rawHostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  const hostname = rawHostname.startsWith("[") && rawHostname.endsWith("]")
    ? rawHostname.slice(1, -1)
    : rawHostname;
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw sourceError("SOURCE_BLOCKED", `Host '${url.hostname}' is not a public source host`);
  }

  if (isIP(hostname)) {
    if (isNonPublicAddress(hostname)) {
      throw sourceError("SOURCE_BLOCKED", `Host '${url.hostname}' is not a public address`);
    }
    return;
  }

  let addresses: readonly LookupResult[];
  let dnsTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    addresses = await Promise.race([
      dependencies.lookup(hostname),
      new Promise<never>((_, reject) => {
        dnsTimeout = setTimeout(() => {
          reject(sourceError(
            "SOURCE_UNREACHABLE",
            `DNS lookup timed out after ${REQUEST_TIMEOUT_MS} ms for '${hostname}'`,
            { retryable: true },
          ));
        }, REQUEST_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    if (error instanceof SourceIngestionError) throw error;
    throw sourceError("SOURCE_UNREACHABLE", `DNS lookup failed for '${hostname}'`, {
      cause: error,
      retryable: true,
    });
  } finally {
    if (dnsTimeout) clearTimeout(dnsTimeout);
  }
  if (addresses.length === 0 || addresses.some(({ address }) => isNonPublicAddress(address))) {
    throw sourceError("SOURCE_BLOCKED", `Host '${hostname}' did not resolve exclusively to public addresses`);
  }
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const announcedLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(announcedLength) && announcedLength > maxBytes) {
    throw sourceError("SOURCE_TOO_LARGE", `Source response exceeds the ${maxBytes} byte limit`);
  }
  if (!response.body) {
    throw sourceError("SOURCE_UNREACHABLE", "Source response did not include a body");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw sourceError("SOURCE_TOO_LARGE", `Source response exceeds the ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function fetchSafely(
  initialUrl: URL,
  dependencies: RuntimeDependencies,
  options: { accept: string; maxBytes: number },
): Promise<SafeResponse> {
  let current = new URL(initialUrl);
  current.hash = "";

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    await validatePublicUrl(current, dependencies);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await dependencies.fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: options.accept,
          "User-Agent": dependencies.userAgent,
        },
      });
      if (response.redirected) {
        throw sourceError("SOURCE_BLOCKED", "The fetch adapter followed a redirect without validation");
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw sourceError("SOURCE_UNREACHABLE", "Source redirect did not include a Location header");
        }
        if (redirectCount === MAX_REDIRECTS) {
          throw sourceError("SOURCE_UNREACHABLE", `Source exceeded ${MAX_REDIRECTS} redirects`);
        }
        await response.body?.cancel();
        try {
          current = new URL(location, current);
        } catch (error) {
          throw sourceError("SOURCE_BLOCKED", "Source returned an invalid redirect URL", { cause: error });
        }
        current.hash = "";
        continue;
      }
      if (!response.ok) {
        throw sourceError("SOURCE_UNREACHABLE", `Source returned HTTP ${response.status}`, {
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        });
      }

      return {
        response,
        body: await readLimitedBody(response, options.maxBytes),
        finalUrl: current,
      };
    } catch (error) {
      if (error instanceof SourceIngestionError) throw error;
      const timedOut = controller.signal.aborted;
      throw sourceError(
        "SOURCE_UNREACHABLE",
        timedOut ? `Source request timed out after ${REQUEST_TIMEOUT_MS} ms` : "Source request failed",
        { cause: error, retryable: true },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  throw sourceError("SOURCE_UNREACHABLE", `Source exceeded ${MAX_REDIRECTS} redirects`);
}

function decodeBytes(body: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(body);
}

function isWikimediaHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return /^(?:[a-z0-9-]+\.)+(?:wikipedia|wikimedia|wiktionary|wikibooks|wikiquote|wikinews|wikiversity|wikivoyage)\.org$/u.test(host)
    || host === "mediawiki.org";
}

function isWikimediaArticleUrl(url: URL): boolean {
  return isWikimediaHost(url.hostname) && url.pathname.startsWith("/wiki/");
}

function articleTitleFromUrl(url: URL): string {
  try {
    const title = decodeURIComponent(url.pathname.slice("/wiki/".length)).replace(/_/gu, " ").trim();
    if (!title) throw new Error("missing title");
    return title;
  } catch (error) {
    throw sourceError("INVALID_REQUEST", "Wikimedia source URL contains an invalid article title", { cause: error });
  }
}

function mediawikiEndpoint(articleUrl: URL): URL {
  return new URL("/w/api.php", articleUrl.origin);
}

async function fetchJson(
  endpoint: URL,
  parameters: Record<string, string>,
  dependencies: RuntimeDependencies,
): Promise<Record<string, unknown>> {
  const url = new URL(endpoint);
  const commonParameters: Record<string, string> = {
    format: "json",
    formatversion: "2",
    maxlag: "5",
    ...parameters,
  };
  for (const [key, value] of Object.entries(commonParameters)) url.searchParams.set(key, value);

  const { response, body } = await fetchSafely(url, dependencies, {
    accept: "application/json",
    maxBytes: MAX_JSON_BYTES,
  });
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType && contentType !== "application/json") {
    throw sourceError("SOURCE_UNREACHABLE", `Wikimedia API returned unsupported MIME type '${contentType}'`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBytes(body));
  } catch (error) {
    throw sourceError("SOURCE_UNREACHABLE", "Wikimedia API returned invalid JSON", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw sourceError("SOURCE_UNREACHABLE", "Wikimedia API returned an invalid response object");
  }

  const json = parsed as Record<string, unknown>;
  const apiError = json.error;
  if (apiError && typeof apiError === "object") {
    const code = String((apiError as Record<string, unknown>).code ?? "unknown");
    const info = String((apiError as Record<string, unknown>).info ?? "Wikimedia API request failed");
    throw sourceError("SOURCE_UNREACHABLE", `Wikimedia API error '${code}': ${info}`, {
      retryable: code === "maxlag" || code === "ratelimited",
    });
  }
  return json;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function getWikimediaMetadata(
  articleUrl: URL,
  dependencies: RuntimeDependencies,
): Promise<WikimediaMetadata> {
  const endpoint = mediawikiEndpoint(articleUrl);
  const json = await fetchJson(endpoint, {
    action: "query",
    prop: "info|revisions",
    inprop: "url",
    rvprop: "ids|timestamp",
    rvlimit: "1",
    titles: articleTitleFromUrl(articleUrl),
    redirects: "1",
    converttitles: "1",
    meta: "siteinfo",
    siprop: "general|rightsinfo",
  }, dependencies);

  const query = asRecord(json.query);
  const page = asRecord(asArray(query?.pages)[0]);
  if (!page || page.missing === true || page.invalid === true) {
    throw sourceError("SOURCE_UNREACHABLE", `Wikimedia article '${articleTitleFromUrl(articleUrl)}' does not exist`);
  }
  if (page.ns !== 0) {
    throw sourceError("SOURCE_BLOCKED", "Only Wikimedia namespace-0 article pages can be ingested");
  }

  const canonicalTitle = typeof page.title === "string" ? normalizedText(page.title, 500) : "";
  const canonicalUrl = typeof page.canonicalurl === "string"
    ? page.canonicalurl
    : typeof page.fullurl === "string"
      ? page.fullurl
      : "";
  const pageId = typeof page.pageid === "number" ? page.pageid : Number.NaN;
  if (!canonicalTitle || !canonicalUrl || !Number.isSafeInteger(pageId)) {
    throw sourceError("SOURCE_UNREACHABLE", "Wikimedia metadata omitted canonical page identity");
  }

  const canonical = parseSeedUrl(canonicalUrl);
  if (canonical.origin !== articleUrl.origin || !canonical.pathname.startsWith("/wiki/")) {
    throw sourceError("SOURCE_BLOCKED", "Wikimedia API returned a canonical URL outside the requested wiki");
  }

  const revisionValue = asRecord(asArray(page.revisions)[0]);
  const revisionId = revisionValue?.revid ?? page.lastrevid;
  const revisionTimestamp = typeof revisionValue?.timestamp === "string" ? revisionValue.timestamp : undefined;
  const revisionUrl = new URL(canonical);
  if (typeof revisionId === "number" || typeof revisionId === "string") {
    revisionUrl.searchParams.set("oldid", String(revisionId));
  }

  const general = asRecord(query?.general);
  const rightsInfo = asRecord(query?.rightsinfo);
  const licenseName = typeof rightsInfo?.text === "string" ? normalizedText(rightsInfo.text, 160) : "";
  const licenseUrl = typeof rightsInfo?.url === "string" ? rightsInfo.url : undefined;

  return {
    endpoint,
    canonicalTitle,
    canonicalUrl: canonical.href,
    pageId,
    locale: typeof page.pagelanguagehtmlcode === "string"
      ? page.pagelanguagehtmlcode
      : typeof page.pagelanguage === "string"
        ? page.pagelanguage
        : undefined,
    siteName: typeof general?.sitename === "string" ? normalizedText(general.sitename, 160) : "Wikipedia",
    revision: revisionId === undefined
      ? null
      : {
          id: String(revisionId),
          ...(revisionTimestamp ? { timestamp: revisionTimestamp } : {}),
          url: revisionUrl.href,
        },
    license: licenseName
      ? { name: licenseName, ...(licenseUrl ? { url: licenseUrl } : {}) }
      : null,
  };
}

function normalizeFragment(value: string): string {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // MediaWiki also emits legacy dot-escaped anchors; try that form below.
  }
  if (/^(?:[^.]|\.[0-9a-fA-F]{2})+$/u.test(decoded) && /\.[0-9a-fA-F]{2}/u.test(decoded)) {
    try {
      decoded = decodeURIComponent(decoded.replace(/\.([0-9a-fA-F]{2})/gu, "%$1"));
    } catch {
      // Keep the normally decoded value if the legacy form is malformed.
    }
  }
  return decoded
    .normalize("NFC")
    .replace(/_/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase();
}

function tocSections(json: Record<string, unknown>): WikimediaSection[] {
  const parse = asRecord(json.parse);
  const tocData = asRecord(parse?.tocdata);
  const rawSections = asArray(tocData?.sections ?? parse?.sections);
  const sections: WikimediaSection[] = [];
  for (const raw of rawSections) {
    const section = asRecord(raw);
    const index = section?.index;
    const line = section?.line;
    const anchor = section?.anchor;
    if ((typeof index === "string" || typeof index === "number") && typeof line === "string" && typeof anchor === "string") {
      sections.push({ index: String(index), line: normalizedText(line, 500), anchor });
    }
  }
  return sections;
}

async function resolveWikimediaSection(
  metadata: WikimediaMetadata,
  fragment: string,
  dependencies: RuntimeDependencies,
): Promise<WikimediaSection> {
  const json = await fetchJson(metadata.endpoint, {
    action: "parse",
    pageid: String(metadata.pageId),
    prop: "tocdata",
    redirects: "1",
  }, dependencies);
  const wanted = normalizeFragment(fragment);
  const section = tocSections(json).find((candidate) => {
    return normalizeFragment(candidate.anchor) === wanted || normalizeFragment(candidate.line) === wanted;
  });
  if (!section) {
    throw sourceError("SOURCE_UNREACHABLE", `Wikimedia article does not contain section '#${fragment}'`);
  }
  return section;
}

function htmlText(html: string): string {
  const $ = load(`<body>${html}</body>`);
  return normalizedText($("body").text(), 500);
}

function safeImageUrl(value: string | undefined, baseUrl: URL): string | null {
  if (!value || value.length > MAX_URL_LENGTH || value.startsWith("data:")) return null;
  try {
    const url = new URL(value, baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function firstSrcsetUrl(value: string | undefined): string | undefined {
  const firstCandidate = value?.split(",", 1)[0]?.trim();
  return firstCandidate?.split(/\s+/u, 1)[0];
}

function imageSourceValue(image: { attr(name: string): string | undefined }): string | undefined {
  return image.attr("data-current-src")
    ?? image.attr("data-src")
    ?? image.attr("data-original")
    ?? firstSrcsetUrl(image.attr("data-srcset"))
    ?? firstSrcsetUrl(image.attr("srcset"))
    ?? image.attr("src");
}

function safeContentUrl(value: string | undefined, baseUrl: URL): string | null {
  if (!value || value.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(value, baseUrl);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || (url.port && url.port !== "443")
    ) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

/**
 * A number of long-running feeds were published before HTTPS and still emit
 * same-host `http://` permalinks even though those exact paths are available
 * over HTTPS. Upgrade only that narrow legacy case; cross-host cleartext URLs,
 * credentials and non-default ports remain rejected.
 */
function safeSyndicationContentUrl(
  value: string | undefined,
  baseUrl: URL,
  legacyUpgradeHost = baseUrl,
): string | null {
  const direct = safeContentUrl(value, baseUrl);
  if (direct || !value || value.length > MAX_URL_LENGTH) return direct;
  try {
    const legacy = new URL(value, baseUrl);
    if (
      legacy.protocol !== "http:"
      || legacy.hostname.toLocaleLowerCase() !== legacyUpgradeHost.hostname.toLocaleLowerCase()
      || legacy.username
      || legacy.password
      || legacy.port
    ) return null;
    legacy.protocol = "https:";
    legacy.hash = "";
    return safeContentUrl(legacy.href, baseUrl);
  } catch {
    return null;
  }
}

const SYNDICATION_MIME_TYPES = new Set([
  "application/atom+xml",
  "application/rss+xml",
  "application/xml",
  "text/xml",
]);

function looksLikeSyndicationXml(value: string): boolean {
  return /^\s*(?:<\?xml[^>]*>\s*)?<(?:rss|feed)(?:\s|>)/iu.test(value);
}

function feedMarkupText(
  value: string,
  maxLength = 2_000,
  stripTrailingCallToAction = false,
): string {
  if (!value) return "";
  const $ = load(`<body>${value}</body>`, { scriptingEnabled: false });
  $("script,style,noscript,template,iframe,object,embed,form").remove();
  if (stripTrailingCallToAction) {
    $("a").each((_, element) => {
      const anchor = $(element);
      const label = normalizedText(anchor.text(), 80);
      if (!/^(?:查看全文|阅读全文|阅读原文|read\s+more|continue\s+reading)(?:\s*[»›→>.…]*)$/iu.test(label)) {
        return;
      }
      const bodyText = normalizedText($("body").text(), maxLength + 100);
      if (bodyText.toLocaleLowerCase().endsWith(label.toLocaleLowerCase())) {
        anchor.remove();
      }
    });
  }
  return normalizedText($("body").text(), maxLength);
}

function explicitSyndicationBaseUrl(
  value: string | undefined,
  inheritedBase: URL,
  legacyUpgradeHost = inheritedBase,
): URL | undefined {
  const safe = safeSyndicationContentUrl(value, inheritedBase, legacyUpgradeHost);
  return safe ? new URL(safe) : undefined;
}

function safeSyndicationFragmentUrl(
  value: string | undefined,
  baseUrl: URL,
  legacyUpgradeHost = baseUrl,
): string | undefined {
  if (!value || value.length > MAX_URL_LENGTH || value.startsWith("data:")) return undefined;
  try {
    const url = new URL(value, baseUrl);
    if (url.protocol === "http:") {
      if (
        url.hostname.toLocaleLowerCase() !== legacyUpgradeHost.hostname.toLocaleLowerCase()
        || url.username
        || url.password
        || url.port
      ) return undefined;
      url.protocol = "https:";
    }
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || (url.port && url.port !== "443")
    ) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function resolvedSyndicationSrcset(
  value: string | undefined,
  baseUrl: URL,
): string | undefined {
  if (!value) return undefined;
  const candidates = value.split(",").flatMap((candidate) => {
    const [rawUrl, ...descriptors] = candidate.trim().split(/\s+/u);
    const url = safeSyndicationFragmentUrl(rawUrl, baseUrl, baseUrl);
    return url ? [`${url}${descriptors.length ? ` ${descriptors.join(" ")}` : ""}`] : [];
  });
  return candidates.length ? candidates.join(", ") : undefined;
}

/**
 * XML Base applies at every ancestor, including an XHTML div nested inside an
 * Atom content element. Rewrite only URL-bearing attributes to safe absolute
 * HTTPS values before the shared HTML/Markdown normalizer sees the fragment.
 */
function resolveSyndicationFragmentUrls(
  html: string,
  inheritedBase: URL,
): string {
  const $ = load(`<body>${html}</body>`, { scriptingEnabled: false });
  const baseByElement = new Map<object, URL>();
  $("body *").each((_, element) => {
    const node = $(element);
    const parentBase = element.parent && typeof element.parent === "object"
      ? baseByElement.get(element.parent) ?? inheritedBase
      : inheritedBase;
    const currentBase = explicitSyndicationBaseUrl(
      node.attr("xml:base"),
      parentBase,
      inheritedBase,
    ) ?? parentBase;
    baseByElement.set(element, currentBase);
    node.removeAttr("xml:base");

    if (element.type !== "tag") return;
    const tag = element.tagName.toLocaleLowerCase();
    if (tag === "a" && node.attr("href")) {
      const href = safeSyndicationFragmentUrl(
        node.attr("href"),
        currentBase,
        inheritedBase,
      );
      if (href) node.attr("href", href);
      else node.removeAttr("href");
      return;
    }
    if (tag !== "img" && tag !== "source") return;
    for (const attribute of [
      "src",
      "data-current-src",
      "data-src",
      "data-original",
    ] as const) {
      const raw = node.attr(attribute);
      if (!raw) continue;
      const url = safeSyndicationFragmentUrl(raw, currentBase, inheritedBase);
      if (url) node.attr(attribute, url);
      else node.removeAttr(attribute);
    }
    for (const attribute of ["srcset", "data-srcset"] as const) {
      const resolved = resolvedSyndicationSrcset(node.attr(attribute), currentBase);
      if (resolved) node.attr(attribute, resolved);
      else node.removeAttr(attribute);
    }
  });
  return $("body").html() ?? "";
}

function semanticBodyText(block: SemanticSourceBlock): string {
  switch (block.type) {
    case "heading":
    case "paragraph":
    case "quote":
      return block.text;
    case "list":
      return block.items.join(" ");
    case "link":
    case "image":
      return "";
  }
}

function semanticBodyLede(blocks: readonly SemanticSourceBlock[]): string {
  const value = blocks
    .filter((block) => block.type !== "heading")
    .map(semanticBodyText)
    .find((text) => text.length > 0)
    ?? blocks.map(semanticBodyText).find((text) => text.length > 0)
    ?? "";
  return normalizedText(value, 2_000);
}

function sourceUrlLabel(url: URL): string {
  const encoded = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
  try {
    return normalizedText(decodeURIComponent(encoded), 500);
  } catch {
    return normalizedText(encoded, 500);
  }
}

function syndicationBodyQuality(
  blocks: readonly SemanticSourceBlock[],
): "substantive" | "teaser" {
  const prose = blocks.map(semanticBodyText).filter(Boolean);
  const characters = prose.join(" ").length;
  const proseBlockCount = blocks.filter((block) =>
    block.type === "paragraph" || block.type === "quote" || block.type === "list"
  ).length;
  const hasStructure = blocks.some((block) =>
    block.type === "heading" || block.type === "list" || block.type === "quote"
  );
  const hasImage = blocks.some((block) => block.type === "image");
  return characters >= 420
      || (proseBlockCount >= 2 && characters >= 160)
      || (hasStructure && characters >= 120)
      || (hasImage && characters >= 160)
    ? "substantive"
    : "teaser";
}

function normalizedSyndicationBody(
  source: SyndicationBodySource,
  value: string,
  baseUrl: URL,
  plainText = false,
): SemanticSourceArticleBody | undefined {
  if (!value.trim()) return undefined;
  if (plainText) {
    // Atom text constructs are literal character data. Routing them through
    // HTML -> Markdown makes values such as `<T>` look like markup and drops
    // them during sanitization, changing the author's content.
    const text = normalizedText(value, MAX_TOTAL_TEXT_CHARS);
    if (!text) return undefined;
    const blocks: SemanticSourceBlock[] = [{ type: "paragraph", text }];
    return {
      source,
      quality: syndicationBodyQuality(blocks),
      blocks,
      links: [],
    };
  }
  const html = value;
  const normalized = renderedHtmlFragmentToMarkdown(
    resolveSyndicationFragmentUrls(html, baseUrl),
    baseUrl,
  );
  if (!normalized.blocks.length) return undefined;
  const blocks = normalized.blocks.slice(0, MAX_BLOCKS_PER_PAGE);
  return {
    source,
    quality: syndicationBodyQuality(blocks),
    blocks,
    links: normalized.links.map((link) => ({
      title: link.label,
      canonicalUrl: link.url,
    })),
  };
}

function firstBodyImage(
  body: SemanticSourceArticleBody | undefined,
): { url: string; alt: string } | undefined {
  const image = body?.blocks.find(
    (block): block is Extract<SemanticSourceBlock, { type: "image" }> =>
      block.type === "image",
  )?.image;
  return image ? { url: image.url, alt: image.alt } : undefined;
}

function normalizedFeedDate(value: string): string | undefined {
  const timestamp = Date.parse(normalizedText(value, 100));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function firstNormalizedFeedDate(values: readonly string[]): string | undefined {
  for (const value of values) {
    const normalized = normalizedFeedDate(value);
    if (normalized) return normalized;
  }
  return undefined;
}

function firstNonBlankSyndicationValue(
  values: readonly string[],
  maxLength = 20_000,
): string {
  for (const value of values) {
    const normalized = normalizedText(value, maxLength);
    if (normalized) return normalized;
  }
  return "";
}

function firstImageFromFeedMarkup(value: string, baseUrl: URL): string | undefined {
  if (!value) return undefined;
  const $ = load(`<body>${value}</body>`, { scriptingEnabled: false });
  const image = $("img").first();
  return safeImageUrl(imageSourceValue(image), baseUrl) ?? undefined;
}

/**
 * Parse explicit RSS 2.0 and Atom feeds as semantic editorial lists. XML is
 * treated strictly as inert data; no stylesheet, embedded markup or script is
 * executed. Only credential-free HTTPS item/image destinations survive.
 */
function ingestSyndicationXml(
  sourceUrl: URL,
  fetchedUrl: URL,
  xml: string,
  dependencies: RuntimeDependencies,
  timings?: Record<string, number>,
): IngestedPage {
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) {
    throw sourceError("SOURCE_BLOCKED", "Syndication XML cannot declare a DTD or entity");
  }
  if (!looksLikeSyndicationXml(xml)) {
    throw sourceError("SOURCE_UNREACHABLE", "XML source is not an RSS 2.0 or Atom feed");
  }
  const $ = load(xml, { xmlMode: true, scriptingEnabled: false });
  const rss = $("rss").first();
  const atom = $("feed").first();
  const isRss = rss.length > 0;
  if (!isRss && atom.length === 0) {
    throw sourceError("SOURCE_UNREACHABLE", "XML source is not an RSS 2.0 or Atom feed");
  }

  const root = isRss ? rss.children("channel").first() : atom;
  if (!root.length) throw sourceError("EXTRACTION_EMPTY", "Feed does not contain a channel");
  const title = normalizedText(root.children("title").first().text(), 500);
  if (!title) throw sourceError("EXTRACTION_EMPTY", "Feed does not contain a usable title");
  const rssDocumentBase = isRss
    ? explicitSyndicationBaseUrl(rss.attr("xml:base"), fetchedUrl)
    : undefined;
  const explicitFeedBase = explicitSyndicationBaseUrl(
    root.attr("xml:base"),
    rssDocumentBase ?? fetchedUrl,
  ) ?? rssDocumentBase;
  const feedXmlBase = explicitFeedBase ?? new URL(fetchedUrl.href);
  const atomFeedAuthor = !isRss
    ? normalizedText(
        root.children("author").first().children("name").first().text(),
        500,
      )
    : "";

  const descriptionNode = isRss
    ? root.children("description").first()
    : root.children("subtitle").first();
  const descriptionMarkup = descriptionNode.text();
  const description = !isRss
      && (descriptionNode.attr("type") ?? "text").toLocaleLowerCase() === "text"
    ? normalizedText(descriptionMarkup, 2_000)
    : feedMarkupText(descriptionMarkup);
  const locale = normalizedText(
    isRss
      ? root.children("language").first().text()
      : atom.attr("xml:lang") ?? "",
    35,
  );
  const updated = firstNormalizedFeedDate(isRss
    ? [
        root.children("lastBuildDate").first().text(),
        root.children("pubDate").first().text(),
      ]
    : [root.children("updated").first().text()]);

  const itemNodes = isRss ? root.children("item") : root.children("entry");
  const feedItems: SemanticSourceFeedItem[] = [];
  itemNodes.each((_, element) => {
    if (feedItems.length >= MAX_FEED_ITEMS_PER_PAGE) return false;
    const node = $(element);
    const explicitEntryBase = explicitSyndicationBaseUrl(
      node.attr("xml:base"),
      feedXmlBase,
    );
    const entryXmlBase = explicitEntryBase ?? feedXmlBase;
    const hasInheritedXmlBase = Boolean(explicitEntryBase || explicitFeedBase);
    const contentNode = isRss
      ? node.children("content\\:encoded").first()
      : node.children("content").first();

    let destination: string | null = null;
    if (isRss) {
      const linkNode = node.children("link").first();
      const linkBase = explicitSyndicationBaseUrl(
        linkNode.attr("xml:base"),
        entryXmlBase,
      ) ?? entryXmlBase;
      destination = safeSyndicationContentUrl(
        linkNode.text(),
        linkBase,
        fetchedUrl,
      );
      if (!destination) {
        const guid = node.children("guid").first();
        if (guid.attr("isPermaLink")?.toLocaleLowerCase() !== "false") {
          const guidBase = explicitSyndicationBaseUrl(
            guid.attr("xml:base"),
            entryXmlBase,
          ) ?? entryXmlBase;
          destination = safeSyndicationContentUrl(
            guid.text(),
            guidBase,
            fetchedUrl,
          );
        }
      }
    } else {
      const links = node.children("link");
      const alternate = links.filter((__, linkElement) => {
        const rel = ($(linkElement).attr("rel") ?? "alternate").toLocaleLowerCase();
        return rel === "alternate";
      }).first();
      const alternateBase = explicitSyndicationBaseUrl(
        alternate.attr("xml:base"),
        entryXmlBase,
      ) ?? entryXmlBase;
      destination = safeSyndicationContentUrl(
        alternate.attr("href"),
        alternateBase,
        fetchedUrl,
      );
    }

    const provisionalDestinationUrl = destination ? new URL(destination) : undefined;
    const contentXmlBase = explicitSyndicationBaseUrl(
      contentNode.attr("xml:base"),
      entryXmlBase,
      provisionalDestinationUrl ?? fetchedUrl,
    );
    const contentSrc = !isRss
      ? safeSyndicationContentUrl(
          contentNode.attr("src"),
          contentXmlBase ?? entryXmlBase,
          provisionalDestinationUrl ?? fetchedUrl,
        )
      : null;
    if (!destination && contentSrc) destination = contentSrc;
    if (!destination && !isRss) {
      const idNode = node.children("id").first();
      const idBase = explicitSyndicationBaseUrl(
        idNode.attr("xml:base"),
        entryXmlBase,
      ) ?? entryXmlBase;
      destination = safeSyndicationContentUrl(
        idNode.text(),
        idBase,
        fetchedUrl,
      );
    }
    if (!destination) return;

    const destinationUrl = new URL(destination);
    const entryContentBase = hasInheritedXmlBase ? entryXmlBase : destinationUrl;
    const teaserNode = isRss
      ? node.children("description").first()
      : node.children("summary").first();
    const contentBase = contentXmlBase ?? entryContentBase;
    const teaserBase = explicitSyndicationBaseUrl(
      teaserNode.attr("xml:base"),
      entryXmlBase,
      destinationUrl,
    ) ?? entryContentBase;
    const atomContentType = (contentNode.attr("type") ?? "text").toLocaleLowerCase();
    const atomSummaryType = (teaserNode.attr("type") ?? "text").toLocaleLowerCase();
    const contentMarkup = isRss
      ? contentNode.text()
      : atomContentType === "xhtml"
        ? contentNode.html() ?? ""
        : contentNode.text();
    const teaserMarkup = isRss
      ? teaserNode.text()
      : atomSummaryType === "xhtml"
        ? teaserNode.html() ?? ""
        : teaserNode.text();
    const contentBody = normalizedSyndicationBody(
      isRss ? "rss-content-encoded" : "atom-content",
      contentMarkup,
      contentBase,
      !isRss ? atomContentType === "text" : false,
    );
    const teaserBody = normalizedSyndicationBody(
      isRss ? "rss-description" : "atom-summary",
      teaserMarkup,
      teaserBase,
      !isRss ? atomSummaryType === "text" : false,
    );
    const bodyBySource = new Map<SyndicationBodySource, SemanticSourceArticleBody>(
      [contentBody, teaserBody]
        .filter((body): body is SemanticSourceArticleBody => Boolean(body))
        .map((body) => [body.source, body]),
    );
    const bodyCandidates = DEFAULT_RSS_STYLE.article.bodySourceOrder
      .map((source) => source === "linked-chromium"
        ? undefined
        : bodyBySource.get(source))
      .filter((body): body is SemanticSourceArticleBody => Boolean(body));
    let articleBody = bodyCandidates.find((body) => body.quality === "substantive")
      ?? bodyCandidates[0];
    if (articleBody && contentSrc && contentSrc !== destination) {
      articleBody = {
        ...articleBody,
        links: [
          ...articleBody.links,
          { title: "查看订阅正文", canonicalUrl: contentSrc },
        ].filter((link, index, links) =>
          links.findIndex((candidate) =>
            candidate.canonicalUrl === link.canonicalUrl
          ) === index
        ),
      };
    }
    const explicitTitle = normalizedText(node.children("title").first().text(), 500);
    const bodyHeading = articleBody?.blocks.find(
      (block): block is Extract<SemanticSourceBlock, { type: "heading" }> =>
        block.type === "heading",
    )?.text;
    const urlTitle = sourceUrlLabel(destinationUrl);
    const itemTitle = explicitTitle || bodyHeading || urlTitle;
    if (!itemTitle) return;

    const teaserText = !isRss && atomSummaryType === "text"
      ? normalizedText(teaserMarkup, 2_000)
      : feedMarkupText(teaserMarkup, 2_000, true);
    const summary = teaserText || (articleBody ? semanticBodyLede(articleBody.blocks) : "");
    const author = isRss
      ? firstNonBlankSyndicationValue([
          node.children("author").first().text(),
          node.children("dc\\:creator").first().text(),
        ], 500)
      : firstNonBlankSyndicationValue([
          node.children("author").first().children("name").first().text(),
          node.children("source").first().children("author").first()
            .children("name").first().text(),
          atomFeedAuthor,
        ], 500);
    const publishedAt = firstNormalizedFeedDate(isRss
      ? [
          node.children("pubDate").first().text(),
          node.children("dc\\:date").first().text(),
        ]
      : [
          node.children("published").first().text(),
          node.children("updated").first().text(),
        ]);

    let imageUrl: string | undefined;
    node.find("media\\:content,media\\:thumbnail,enclosure").each((__, mediaElement) => {
      if (imageUrl) return false;
      const media = $(mediaElement);
      const tag = mediaElement.type === "tag" ? mediaElement.tagName.toLocaleLowerCase() : "";
      const mediaType = (media.attr("type") ?? "").toLocaleLowerCase();
      if (tag === "enclosure" && mediaType && !mediaType.startsWith("image/")) return;
      const mediaBase = explicitSyndicationBaseUrl(
        media.attr("xml:base"),
        entryXmlBase,
        destinationUrl,
      ) ?? entryContentBase;
      imageUrl = safeImageUrl(
        media.attr("url") ?? media.attr("href"),
        mediaBase,
      ) ?? undefined;
    });
    if (!imageUrl && !isRss) {
      const enclosure = node.children("link").filter((__, linkElement) => {
        const link = $(linkElement);
        return link.attr("rel")?.toLocaleLowerCase() === "enclosure"
          && (link.attr("type") ?? "").toLocaleLowerCase().startsWith("image/");
      }).first();
      const enclosureBase = explicitSyndicationBaseUrl(
        enclosure.attr("xml:base"),
        entryXmlBase,
        destinationUrl,
      ) ?? entryContentBase;
      imageUrl = safeImageUrl(enclosure.attr("href"), enclosureBase) ?? undefined;
    }
    imageUrl ??= firstBodyImage(contentBody)?.url;
    imageUrl ??= firstBodyImage(teaserBody)?.url;
    imageUrl ??= firstImageFromFeedMarkup(teaserMarkup, teaserBase);

    feedItems.push({
      title: itemTitle,
      ...(summary && summary !== itemTitle ? { summary } : {}),
      ...(author ? { author } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      ...(imageUrl ? { image: { url: imageUrl, alt: itemTitle } } : {}),
      canonicalUrl: destination,
      ...(articleBody && (
        articleBody.quality === "substantive"
        || articleBody === contentBody
        || Boolean(contentSrc)
      )
        ? { articleBody }
        : {}),
    });
  });
  if (feedItems.length === 0) {
    throw sourceError("EXTRACTION_EMPTY", "Feed does not contain any safe HTTPS entries");
  }

  let attributionUrl = fetchedUrl.href;
  if (isRss) {
    const channelLink = root.children("link").first();
    const channelLinkBase = explicitSyndicationBaseUrl(
      channelLink.attr("xml:base"),
      feedXmlBase,
    ) ?? feedXmlBase;
    attributionUrl = safeSyndicationContentUrl(
      channelLink.text(),
      channelLinkBase,
      fetchedUrl,
    )
      ?? fetchedUrl.href;
  } else {
    const alternate = root.children("link").filter((_, element) => {
      const rel = ($(element).attr("rel") ?? "alternate").toLocaleLowerCase();
      return rel === "alternate";
    }).first();
    const alternateBase = explicitSyndicationBaseUrl(
      alternate.attr("xml:base"),
      feedXmlBase,
    ) ?? feedXmlBase;
    attributionUrl = safeSyndicationContentUrl(
      alternate.attr("href"),
      alternateBase,
      fetchedUrl,
    ) ?? fetchedUrl.href;
  }
  const retrievedAt = dependencies.now().toISOString();
  const revisionId = updated
    ? String(Date.parse(updated))
    : `xml-sha256:${createHash("sha256").update(xml).digest("hex")}`;
  return {
    canonicalUrl: fetchedUrl.href,
    title,
    ...(locale ? { locale } : {}),
    blocks: [{ type: "paragraph", text: description || `${title} RSS/Atom feed` }],
    feedItems,
    links: feedItems.map((item) => ({ title: item.title, canonicalUrl: item.canonicalUrl })),
    provenance: {
      provider: "web",
      sourceUrl: sourceUrl.href,
      canonicalUrl: fetchedUrl.href,
      retrievedAt,
    },
    revision: {
      id: revisionId,
      ...(updated ? { timestamp: updated } : {}),
      url: fetchedUrl.href,
    },
    license: null,
    attribution: { name: title, url: attributionUrl },
    isSyndicationFeed: true,
    discoveredLinks: feedItems.map((item) => ({
      title: item.title,
      url: item.canonicalUrl,
    })).slice(0, MAX_CHILD_LINKS_PER_PAGE),
    ...(timings ? { timings } : {}),
  };
}

function isTiebaLandingUrl(url: URL): boolean {
  return url.hostname.toLocaleLowerCase() === "tieba.baidu.com"
    && (url.pathname === "/" || url.pathname === "/index.html")
    && !url.search;
}

/**
 * Tieba intentionally returns a security-verification 403 for its HTML home
 * page in server-side browsers, while its public hot-topic JSON endpoint is
 * available without credentials. Treat that endpoint as inert provider data
 * and keep the user-facing canonical identity at the requested Tieba URL.
 */
async function ingestTiebaLanding(
  sourceUrl: URL,
  dependencies: RuntimeDependencies,
): Promise<IngestedPage> {
  const startedAt = performance.now();
  const endpoint = new URL("/hottopic/browse/topicList", sourceUrl.origin);
  const { response, body } = await fetchSafely(endpoint, dependencies, {
    accept: "application/json",
    maxBytes: MAX_JSON_BYTES,
  });
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType && contentType !== "application/json") {
    throw sourceError("SOURCE_UNREACHABLE", `Tieba topic API returned unsupported MIME type '${contentType}'`);
  }

  let json: Record<string, unknown>;
  try {
    const parsed = JSON.parse(decodeBytes(body));
    const record = asRecord(parsed);
    if (!record) throw new Error("response is not an object");
    json = record;
  } catch (error) {
    throw sourceError("SOURCE_UNREACHABLE", "Tieba topic API returned invalid JSON", { cause: error });
  }

  const data = asRecord(json.data);
  const topicModule = asRecord(data?.bang_topic);
  const rawTopics = asArray(topicModule?.topic_list);
  const feedItems: SemanticSourceFeedItem[] = [];
  for (const rawTopic of rawTopics) {
    if (feedItems.length >= MAX_FEED_ITEMS_PER_PAGE) break;
    const topic = asRecord(rawTopic);
    const title = normalizedText(typeof topic?.topic_name === "string" ? topic.topic_name : "", 500);
    const rawDestination = typeof topic?.topic_url === "string"
      ? topic.topic_url.replace(/&amp;/giu, "&")
      : "";
    const canonicalUrl = safeContentUrl(rawDestination, sourceUrl);
    if (!title || !canonicalUrl) continue;

    const description = normalizedText(
      typeof topic?.topic_desc === "string"
        ? topic.topic_desc
        : typeof topic?.abstract === "string"
          ? topic.abstract
          : "",
      2_000,
    );
    const discussions = typeof topic?.discuss_num === "number" && Number.isFinite(topic.discuss_num)
      ? Math.max(0, Math.trunc(topic.discuss_num))
      : undefined;
    const summary = normalizedText([
      description,
      discussions !== undefined ? `${discussions.toLocaleString("zh-CN")} 次讨论` : "",
    ].filter(Boolean).join(" · "), 2_000);
    const imageUrl = safeImageUrl(
      typeof topic?.topic_pic === "string" ? topic.topic_pic : undefined,
      sourceUrl,
    );
    const createdDate = typeof topic?.create_time === "number"
      && Number.isFinite(topic.create_time)
      && topic.create_time > 0
      ? new Date(topic.create_time * 1_000)
      : undefined;
    const createdAt = createdDate && Number.isFinite(createdDate.getTime())
      ? createdDate.toISOString()
      : undefined;
    feedItems.push({
      title,
      ...(summary ? { summary } : {}),
      ...(createdAt ? { publishedAt: createdAt } : {}),
      ...(imageUrl ? { image: { url: imageUrl, alt: title } } : {}),
      canonicalUrl,
    });
  }
  if (!feedItems.length) {
    throw sourceError("EXTRACTION_EMPTY", "Tieba topic API did not contain any safe topics");
  }

  const canonicalUrl = new URL(sourceUrl);
  canonicalUrl.hash = "";
  const retrievedAt = dependencies.now().toISOString();
  return {
    canonicalUrl: canonicalUrl.href,
    title: "百度贴吧 · 热议话题",
    locale: "zh-CN",
    blocks: [{ type: "paragraph", text: "来自百度贴吧公开热议榜，选择话题继续阅读。" }],
    feedItems,
    links: feedItems.map((item) => ({ title: item.title, canonicalUrl: item.canonicalUrl })),
    provenance: {
      provider: "web",
      sourceUrl: sourceUrl.href,
      canonicalUrl: canonicalUrl.href,
      retrievedAt,
    },
    revision: {
      id: `json-sha256:${createHash("sha256").update(body).digest("hex")}`,
      url: endpoint.href,
    },
    license: null,
    attribution: { name: "百度贴吧", url: canonicalUrl.href },
    discoveredLinks: feedItems.map((item) => ({
      title: item.title,
      url: item.canonicalUrl,
    })).slice(0, MAX_CHILD_LINKS_PER_PAGE),
    timings: { http_fetch_extract_ms: performance.now() - startedAt },
  };
}

function semanticTokens(value: string): Set<string> {
  return new Set(value
    .toLocaleLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean));
}

function hasAnyToken(tokens: ReadonlySet<string>, values: readonly string[]): boolean {
  return values.some((value) => tokens.has(value));
}

const EDITORIAL_TOKENS = ["article", "entry", "feed", "news", "post", "result", "story"] as const;
const ITEM_TOKENS = ["card", "item", "preview", "summary", "teaser"] as const;
const NAVIGATION_REGION_NOISE_PATTERN = /(?:^|[-_\s])(breadcrumb|footer|legal|pagination|pager|social)(?:[-_\s]|$)/iu;
const NAVIGATION_PRIMARY_PATTERN = /(?:^|[-_\s])(global|main|nav|navbar|primary|site|top)(?:[-_\s]|$)/iu;
const NAVIGATION_AUTH_PATTERN = /(?:account|auth|log[-_\s]?(?:in|out)|member|message|notice|notification|profile|register|sign[-_\s]?(?:in|out|up)|user|wp-admin|wp-login|个人中心|信息|消息|用户中心|注册|登录|登出|退出)/iu;
const PAGINATION_REGION_PATTERN = /(?:^|[-_\s])(pagination|pager|paging|statusline)(?:[-_\s]|$)/iu;
const PAGINATION_LABEL_PATTERN = /^(?:next|previous|prev|older|newer|next\s+page|previous\s+page|下一页|下页|上一页|上页|后页|前页|‹|›|«|»|\d+)$/iu;
const PAGINATION_ACCESSIBLE_PATTERN = /(?:next|previous|prev|older|newer|下一页|下页|上一页|上页).{0,32}(?:page|页|results?)|(?:page|页|results?).{0,32}(?:next|previous|prev|older|newer|下一页|下页|上一页|上页)/iu;

/**
 * Detect the strongest repeated editorial group, rather than treating every
 * image and navigation link on an index page as article content. Repetition,
 * a headline link and either semantic markup or useful preview content are
 * all required; an ordinary detail page therefore keeps its detail semantics.
 */
function extractSemanticFeedItems(
  $: CheerioAPI,
  rootUrl: URL,
): SemanticSourceFeedItem[] {
  interface Candidate {
    group: object;
    item: SemanticSourceFeedItem;
    score: number;
  }

  const candidates: Candidate[] = [];
  const root = $("main,[role='main']").first().length
    ? $("main,[role='main']").first()
    : $("body").first();

  root.find("article,li,section,div,[itemprop='itemListElement']").each((_, element) => {
    const node = $(element);
    if (
      node.parents("nav,header,footer,aside,[role='navigation']").length
      || node.closest(
        ".breadcrumb,[aria-label='breadcrumb'],[itemtype$='BreadcrumbList']",
      ).length
    ) return;

    const semanticHeadlineAnchors = node.find(
      "h1 a[href],h2 a[href],h3 a[href],h4 a[href]," +
      "[itemprop='headline'][href],a[itemprop='url']," +
      "a[class*='title'][href],a[class*='headline'][href]",
    );
    // Many catalog/search pages make the whole card clickable and put the
    // actual title in a descendant (for example <a><span class="title">).
    // Accept that shape only when the candidate has one direct destination;
    // the repeated-sibling and useful-preview checks below still prevent an
    // ordinary menu or detail-page link from becoming a feed item.
    const directCardAnchors = node.children("a[href]");
    const rawHeadlineAnchors = semanticHeadlineAnchors.length > 0
      ? semanticHeadlineAnchors
      : directCardAnchors.length === 1
        ? directCardAnchors
        : semanticHeadlineAnchors;
    const headlineLinks = new Map<string, { title: string; url: string }>();
    rawHeadlineAnchors.each((__, anchorElement) => {
      const anchor = $(anchorElement);
      const url = safeContentUrl(anchor.attr("href"), rootUrl);
      let explicitHeadline = anchor.find(
        "h1,h2,h3,h4,[itemprop='headline'],[class~='title'],[class~='headline']",
      ).first();
      if (!explicitHeadline.length) {
        explicitHeadline = anchor.find("[class*='title'],[class*='headline']")
          .filter((___, headlineElement) => {
            const className = $(headlineElement).attr("class") ?? "";
            return !/(?:^|[-_\s])(?:sub|secondary)[-_\s]?title(?:[-_\s]|$)/iu.test(className);
          })
          .first();
      }
      const title = normalizedText(
        explicitHeadline.text()
          || anchor.attr("aria-label")
          || anchor.attr("title")
          || anchor.text(),
        500,
      );
      if (url && title.length >= 2 && !headlineLinks.has(url)) {
        headlineLinks.set(url, { title, url });
      }
    });
    // A feed container itself usually contains many headline destinations. It
    // is not an item, and accepting it would blend unrelated preview images.
    if (headlineLinks.size !== 1) return;

    const [{ title, url }] = [...headlineLinks.values()];
    const tagName = element.type === "tag" ? element.tagName.toLocaleLowerCase() : "";
    const descriptor = [
      node.attr("class") ?? "",
      node.attr("id") ?? "",
      node.attr("itemprop") ?? "",
      node.attr("itemtype") ?? "",
    ].join(" ");
    const tokens = semanticTokens(descriptor);
    const semanticArticle = tagName === "article"
      || /(?:^|\/)Article$/iu.test(node.attr("itemtype") ?? "")
      || node.attr("itemprop") === "itemListElement";
    const itemNamed = hasAnyToken(tokens, EDITORIAL_TOKENS)
      && hasAnyToken(tokens, ITEM_TOKENS);

    const summaryNode = node.find(
      "[itemprop='description'],[class*='excerpt'],[class*='summary']," +
      "[class*='description'],[class*='deck'],[class*='lede'],[class*='intro'],p",
    ).filter((__, summaryElement) => {
      return $(summaryElement).find(rawHeadlineAnchors).length === 0;
    }).first();
    let summaryText = normalizedText(summaryNode.text(), 2_000);
    if (!summaryText) {
      const supportingParts: string[] = [];
      node.find(
        "[class~='subtitle'],[class~='byline'],[class~='author']," +
        "[class~='extra'],[class~='meta'],[class~='metadata']",
      ).each((__, supportingElement) => {
        if (supportingParts.length >= 3) return false;
        const part = normalizedText($(supportingElement).text(), 500);
        if (part && part !== title && !supportingParts.includes(part)) supportingParts.push(part);
      });
      summaryText = normalizedText(supportingParts.join(" · "), 2_000);
    }
    const summary = summaryText && summaryText !== title ? summaryText : undefined;

    let primaryImage: SemanticSourceFeedItem["image"];
    let primaryImageScore = Number.NEGATIVE_INFINITY;
    node.find("picture img,img[itemprop='image'],img").each((__, imageElement) => {
      const image = $(imageElement);
      const imageDescriptor = [
        image.attr("class") ?? "",
        image.attr("id") ?? "",
        image.attr("alt") ?? "",
        image.attr("src") ?? "",
        image.parent().attr("class") ?? "",
      ].join(" ");
      const width = Number.parseInt(image.attr("width") ?? "", 10);
      const height = Number.parseInt(image.attr("height") ?? "", 10);
      const imageUrl = safeImageUrl(imageSourceValue(image), rootUrl);
      if (!imageUrl) return;
      if (isDecorativeImage({
        alt: image.attr("alt"),
        ariaHidden: image.attr("aria-hidden"),
        className: image.attr("class"),
        height: image.attr("height"),
        id: image.attr("id"),
        parentClassName: image.parent().attr("class"),
        renderedHeight: image.attr("data-ink-rendered-height"),
        renderedHidden: image.attr("data-ink-rendered-hidden"),
        renderedWidth: image.attr("data-ink-rendered-width"),
        role: image.attr("role"),
        source: imageUrl,
        width: image.attr("width"),
      })) return;
      const imageTokens = semanticTokens(imageDescriptor);
      let score = primaryImage ? 0 : 1;
      if (hasAnyToken(imageTokens, ["cover", "featured", "hero", "photo", "thumb", "thumbnail"])) score += 4;
      if (Number.isFinite(width) && Number.isFinite(height)) score += Math.min(3, (width * height) / 100_000);
      if (score <= primaryImageScore) return;
      primaryImageScore = score;
      const alt = normalizedText(image.attr("alt") ?? "", 500);
      primaryImage = { url: imageUrl, alt: alt && alt.toLocaleLowerCase() !== "thumbnail" ? alt : title };
    });

    let score = 3; // one unambiguous linked headline
    if (semanticArticle) score += 4;
    if (itemNamed) score += 3;
    if (summary) score += 2;
    if (primaryImage) score += 2;
    // A plain navigation entry with only a linked heading is not a feed item.
    if (score < 5 || (!semanticArticle && !itemNamed && !summary && !primaryImage)) return;
    const group = element.parent;
    if (!group || typeof group !== "object") return;
    candidates.push({
      group,
      score,
      item: {
        title,
        ...(summary ? { summary } : {}),
        ...(primaryImage ? { image: primaryImage } : {}),
        canonicalUrl: url,
      },
    });
  });

  const groups = new Map<object, Candidate[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.group) ?? [];
    group.push(candidate);
    groups.set(candidate.group, group);
  }
  const bestGroup = [...groups.values()]
    .map((group) => {
      const unique = [...new Map(group.map((candidate) => [candidate.item.canonicalUrl, candidate])).values()];
      return unique;
    })
    .filter((group) => group.length >= 2)
    .sort((left, right) => {
      const leftScore = left.length * 100 + left.reduce((sum, candidate) => sum + candidate.score, 0);
      const rightScore = right.length * 100 + right.reduce((sum, candidate) => sum + candidate.score, 0);
      return rightScore - leftScore;
    })[0];

  return (bestGroup ?? [])
    .slice(0, MAX_FEED_ITEMS_PER_PAGE)
    .map((candidate) => candidate.item);
}

function navigationUrl(value: string | undefined, rootUrl: URL): string | null {
  if (!value || value.length > MAX_URL_LENGTH) return null;
  try {
    const target = new URL(value, rootUrl);
    if (
      target.protocol !== "https:"
      || target.origin !== rootUrl.origin
      || target.username
      || target.password
      || (target.port && target.port !== "443")
    ) return null;
    target.hash = "";
    return target.href;
  } catch {
    return null;
  }
}

/**
 * Extract one best primary-navigation region. Only visible, same-origin HTTPS
 * anchors are retained; breadcrumbs, footer/legal clusters, authentication
 * controls and icon-only entries are intentionally excluded.
 */
function extractPrimaryNavigation(
  $: CheerioAPI,
  rootUrl: URL,
): SemanticSourceNavigationItem[] {
  interface Candidate {
    items: SemanticSourceNavigationItem[];
    score: number;
  }

  const candidates: Candidate[] = [];
  const candidateNodes = $(
    "header nav,body > nav,nav,[role='navigation'],[class~='main-nav'],[class*='navbar'],[id='nav']",
  );
  candidateNodes.each((_, element) => {
    const node = $(element);
    const descriptor = normalizedText([
      node.attr("id") ?? "",
      node.attr("class") ?? "",
      node.attr("role") ?? "",
      node.attr("aria-label") ?? "",
    ].join(" "), 1_000);
    if (
      NAVIGATION_REGION_NOISE_PATTERN.test(descriptor)
      || node.closest("footer,.breadcrumb,[aria-label='breadcrumb']").length
    ) return;

    const items: SemanticSourceNavigationItem[] = [];
    const seen = new Set<string>();
    node.find("a[href]").each((__, anchorElement) => {
      if (items.length >= MAX_NAVIGATION_ITEMS_PER_PAGE) return false;
      const anchor = $(anchorElement);
      const enclosingDescriptor = normalizedText([
        anchor.parent().attr("class") ?? "",
        anchor.parent().attr("id") ?? "",
        anchor.attr("class") ?? "",
        anchor.attr("id") ?? "",
      ].join(" "), 1_000);
      if (
        NAVIGATION_REGION_NOISE_PATTERN.test(enclosingDescriptor)
        || anchor.closest("footer,.breadcrumb,[aria-label='breadcrumb']").length
      ) return;

      // Attribute-only labels and icon markup are not visible menu titles.
      const title = normalizedText(anchor.text(), 500);
      if (!title || !/[\p{L}\p{N}]/u.test(title)) return;
      const url = navigationUrl(anchor.attr("href"), rootUrl);
      if (!url || seen.has(url) || NAVIGATION_AUTH_PATTERN.test(`${title} ${url}`)) return;
      seen.add(url);
      items.push({ title, canonicalUrl: url });
    });
    if (items.length === 0) return;

    let score = items.length * 100;
    if (NAVIGATION_PRIMARY_PATTERN.test(descriptor)) score += 10_000;
    if (element.type === "tag" && element.tagName.toLocaleLowerCase() === "nav") score += 1_000;
    if (node.parents("header").length) score += 500;
    candidates.push({ items, score });
  });

  return candidates.sort((left, right) => right.score - left.score)[0]?.items ?? [];
}

/**
 * Keep bounded previous/next controls distinct from site menus and editorial
 * entries. Pagination remains navigation in inkos.content/v2, and because it
 * is not a feed item it cannot jump ahead of article cards in the crawl queue.
 */
function extractPaginationNavigation(
  $: CheerioAPI,
  rootUrl: URL,
): SemanticSourceNavigationItem[] {
  const root = $("main,[role='main'],#content").first().length
    ? $("main,[role='main'],#content").first()
    : $("body").first();
  const items: SemanticSourceNavigationItem[] = [];
  const seen = new Set<string>();

  root.find("a[href]").each((_, anchorElement) => {
    if (items.length >= MAX_NAVIGATION_ITEMS_PER_PAGE) return false;
    const anchor = $(anchorElement);
    const title = normalizedText(anchor.text(), 500);
    if (!title || !PAGINATION_LABEL_PATTERN.test(title)) return;

    const rel = normalizedText(anchor.attr("rel") ?? "", 100);
    const accessibleLabel = normalizedText(
      `${anchor.attr("aria-label") ?? ""} ${anchor.attr("title") ?? ""}`,
      500,
    );
    const regionDescriptor = normalizedText(
      anchor.parents().slice(0, 4).map((__, ancestor) => {
        const node = $(ancestor);
        return `${node.attr("id") ?? ""} ${node.attr("class") ?? ""} ${node.attr("role") ?? ""}`;
      }).get().join(" "),
      1_000,
    );
    const hasSemanticRel = /(?:^|\s)(?:next|prev|previous)(?:\s|$)/iu.test(rel);
    if (
      !hasSemanticRel
      && !PAGINATION_REGION_PATTERN.test(regionDescriptor)
      && !PAGINATION_ACCESSIBLE_PATTERN.test(accessibleLabel)
    ) return;

    const url = navigationUrl(anchor.attr("href"), rootUrl);
    if (!url || seen.has(url)) return;
    seen.add(url);
    items.push({ title, canonicalUrl: url });
  });

  return items;
}

function extractSemanticBlocks(html: string, baseUrl: URL): SemanticSourceBlock[] {
  const $ = load(html, { scriptingEnabled: false });
  if ($("*").length > MAX_PARSED_NODES) {
    throw sourceError("SOURCE_TOO_LARGE", `Parsed HTML exceeds ${MAX_PARSED_NODES} nodes`);
  }

  $(
    "script,style,noscript,template,iframe,object,embed,form,input,button,svg,canvas," +
    ".mw-editsection,.reference,.reflist,.mw-references-wrap,.navbox,.metadata,.noprint",
  ).remove();
  const root = $(".mw-parser-output").first().length
    ? $(".mw-parser-output").first()
    : $("main,article,[role='main']").first().length
      ? $("main,article,[role='main']").first()
      : $("body").first();

  const blocks: SemanticSourceBlock[] = [];
  let imageCount = 0;
  let totalTextChars = 0;
  const push = (block: SemanticSourceBlock, textCharacters = 0) => {
    if (blocks.length >= MAX_BLOCKS_PER_PAGE) return;
    if (totalTextChars + textCharacters > MAX_TOTAL_TEXT_CHARS) {
      throw sourceError("SOURCE_TOO_LARGE", `Extracted text exceeds ${MAX_TOTAL_TEXT_CHARS} characters`);
    }
    totalTextChars += textCharacters;
    blocks.push(block);
  };

  root.find("h1,h2,h3,h4,h5,h6,p,ol,ul,blockquote,figure,img").each((_, element) => {
    if (blocks.length >= MAX_BLOCKS_PER_PAGE) return false;
    const node = $(element);
    if (node.closest("nav,[role='navigation'],.breadcrumb").length) return;
    const tag = element.type === "tag" ? element.tagName.toLowerCase() : "";

    if (/^h[1-6]$/u.test(tag)) {
      const text = normalizedText(node.text(), 500);
      if (text) {
        const level = Number(tag.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6;
        push({ type: "heading", level, text }, text.length);
      }
      return;
    }

    if (tag === "p") {
      if (node.parents("blockquote,li,figcaption,figure").length) return;
      const text = normalizedText(node.text());
      if (text) push({ type: "paragraph", text }, text.length);
      return;
    }

    if (tag === "ol" || tag === "ul") {
      if (node.parents("ol,ul,blockquote,figure").length) return;
      const items = node.children("li").map((__, item) => {
        const clone = $(item).clone();
        clone.find("ol,ul").remove();
        return normalizedText(clone.text(), 500);
      }).get().filter(Boolean).slice(0, 64);
      if (items.length) {
        push({ type: "list", ordered: tag === "ol", items }, items.reduce((sum, item) => sum + item.length, 0));
      }
      return;
    }

    if (tag === "blockquote") {
      if (node.parents("blockquote").length) return;
      const clone = node.clone();
      const attribution = normalizedText(clone.find("cite,footer").first().text(), 500);
      clone.find("cite,footer").remove();
      const text = normalizedText(clone.text());
      if (text) {
        push(
          { type: "quote", text, ...(attribution ? { attribution } : {}) },
          text.length + attribution.length,
        );
      }
      return;
    }

    if (tag === "figure") {
      if (node.parents("figure").length || imageCount >= MAX_IMAGES_PER_PAGE) return;
      const image = node.find("img").first();
      const url = safeImageUrl(imageSourceValue(image), baseUrl);
      if (!url) return;
      const alt = normalizedText(image.attr("alt") ?? "", 500);
      const caption = normalizedText(node.find("figcaption").first().text(), 500);
      if (isDecorativeImage({
        alt,
        ariaHidden: image.attr("aria-hidden"),
        caption,
        className: image.attr("class"),
        height: image.attr("height"),
        id: image.attr("id"),
        parentClassName: image.parent().attr("class"),
        role: image.attr("role"),
        source: url,
        width: image.attr("width"),
      })) return;
      imageCount += 1;
      push({ type: "image", image: { url, alt, ...(caption ? { caption } : {}) } });
      return;
    }

    if (tag === "img" && !node.parents("figure").length && imageCount < MAX_IMAGES_PER_PAGE) {
      const url = safeImageUrl(imageSourceValue(node), baseUrl);
      if (!url) return;
      if (isDecorativeImage({
        alt: node.attr("alt"),
        ariaHidden: node.attr("aria-hidden"),
        className: node.attr("class"),
        height: node.attr("height"),
        id: node.attr("id"),
        parentClassName: node.parent().attr("class"),
        role: node.attr("role"),
        source: url,
        width: node.attr("width"),
      })) return;
      imageCount += 1;
      push({ type: "image", image: { url, alt: normalizedText(node.attr("alt") ?? "", 500) } });
    }
  });

  return blocks;
}

function pageUrlForTitle(origin: string, title: string): string {
  const pathTitle = encodeURIComponent(title.replace(/ /gu, "_")).replace(/%2F/giu, "/");
  return new URL(`/wiki/${pathTitle}`, origin).href;
}

function isNookEInkSection(metadata: WikimediaMetadata, section?: WikimediaSection): boolean {
  return new URL(metadata.canonicalUrl).hostname === "zh.wikipedia.org"
    && metadata.canonicalTitle.toLocaleLowerCase() === "nook"
    && section !== undefined
    && normalizeFragment(section.anchor) === normalizeFragment("电子墨水屏系列");
}

async function ingestWikimediaPage(
  sourceUrl: URL,
  dependencies: RuntimeDependencies,
): Promise<IngestedPage> {
  const metadata = await getWikimediaMetadata(sourceUrl, dependencies);
  const fragment = sourceUrl.hash ? sourceUrl.hash.slice(1) : "";
  const section = fragment
    ? await resolveWikimediaSection(metadata, fragment, dependencies)
    : undefined;

  const parseJson = await fetchJson(metadata.endpoint, {
    action: "parse",
    pageid: String(metadata.pageId),
    ...(section ? { section: section.index } : {}),
    prop: "text|links|displaytitle|revid",
    redirects: "1",
  }, dependencies);
  const parsed = asRecord(parseJson.parse);
  const html = typeof parsed?.text === "string" ? parsed.text : "";
  const canonical = new URL(metadata.canonicalUrl);
  if (section) canonical.hash = section.anchor;
  const blocks = extractSemanticBlocks(html, canonical);
  if (!blocks.length) {
    throw sourceError("EXTRACTION_EMPTY", `No semantic content was extracted from '${canonical.href}'`);
  }

  const parsedTitle = typeof parsed?.displaytitle === "string"
    ? htmlText(parsed.displaytitle)
    : metadata.canonicalTitle;
  const title = section ? `${parsedTitle} — ${section.line}` : parsedTitle;
  const candidates: DiscoveredLink[] = [];
  const candidateKeys = new Set<string>();
  for (const rawLink of asArray(parsed?.links)) {
    const link = asRecord(rawLink) as WikimediaLink | undefined;
    if (!link || link.ns !== 0 || link.exists === false || typeof link.title !== "string") continue;
    const candidateUrl = pageUrlForTitle(canonical.origin, link.title);
    if (candidateUrl === metadata.canonicalUrl || candidateKeys.has(candidateUrl)) continue;
    candidateKeys.add(candidateUrl);
    candidates.push({ title: normalizedText(link.title, 500), url: candidateUrl });
    if (candidates.length >= MAX_CHILD_LINKS_PER_PAGE) break;
  }

  // The Chinese Nook section names Nook Simple Touch as its main article, but
  // that local title is currently a red link. The English namespace-0 article
  // is the canonical, reusable child for the requested seed collection.
  if (isNookEInkSection(metadata, section) && candidates.length < MAX_CHILD_LINKS_PER_PAGE) {
    const fallbackUrl = "https://en.wikipedia.org/wiki/Nook_Simple_Touch";
    if (!candidateKeys.has(fallbackUrl)) {
      candidates.unshift({ title: "Nook Simple Touch", url: fallbackUrl });
    }
  }

  const retrievedAt = dependencies.now().toISOString();
  const revisionAttributionUrl = metadata.revision?.url ?? canonical.href;
  return {
    canonicalUrl: canonical.href,
    title: title || metadata.canonicalTitle,
    ...(metadata.locale ? { locale: metadata.locale } : {}),
    blocks,
    provenance: {
      provider: "wikimedia",
      sourceUrl: sourceUrl.href,
      canonicalUrl: canonical.href,
      retrievedAt,
    },
    revision: metadata.revision,
    license: metadata.license,
    attribution: {
      name: `${metadata.siteName} contributors`,
      url: revisionAttributionUrl,
    },
    discoveredLinks: candidates.slice(0, MAX_CHILD_LINKS_PER_PAGE),
  };
}

function sameOriginChildLinks(
  $: CheerioAPI,
  rootUrl: URL,
  excludedUrls: ReadonlySet<string> = new Set(),
): DiscoveredLink[] {
  const links: DiscoveredLink[] = [];
  const seen = new Set<string>();
  $("main a[href],article a[href],[role='main'] a[href],body a[href]").each((_, element) => {
    if (links.length >= MAX_CHILD_LINKS_PER_PAGE) return false;
    const href = $(element).attr("href");
    if (!href) return;
    let target: URL;
    try {
      target = new URL(href, rootUrl);
    } catch {
      return;
    }
    if (
      target.href.length > MAX_URL_LENGTH
      || target.protocol !== "https:"
      || target.origin !== rootUrl.origin
      || target.username
      || target.password
    ) return;
    target.hash = "";
    if (target.href === rootUrl.href || seen.has(target.href) || excludedUrls.has(target.href)) return;
    const title = normalizedText($(element).text() || $(element).attr("title") || "", 500);
    if (!title) return;
    seen.add(target.href);
    links.push({ title, url: target.href });
  });
  return links;
}

function genericCanonicalUrl($: CheerioAPI, fetchedUrl: URL): URL {
  const href = $("link[rel~='canonical']").first().attr("href");
  if (!href) return fetchedUrl;
  try {
    const candidate = new URL(href, fetchedUrl);
    if (
      candidate.href.length > MAX_URL_LENGTH
      || candidate.protocol !== "https:"
      || candidate.origin !== fetchedUrl.origin
      || candidate.username
      || candidate.password
      || (candidate.port && candidate.port !== "443")
    ) {
      return fetchedUrl;
    }
    candidate.hash = "";
    return candidate;
  } catch {
    return fetchedUrl;
  }
}

function genericLicense($: CheerioAPI, canonicalUrl: URL): SourceLicense | null {
  const link = $("link[rel~='license'],a[rel~='license']").first();
  const href = link.attr("href");
  const metaName = $("meta[name='license'],meta[property='license']").first().attr("content");
  const name = normalizedText(metaName || link.attr("title") || link.text() || "", 160);
  let url: string | undefined;
  if (href) {
    try {
      const candidate = new URL(href, canonicalUrl);
      if (
        candidate.href.length <= MAX_URL_LENGTH
        && candidate.protocol === "https:"
        && !candidate.username
        && !candidate.password
      ) url = candidate.href;
    } catch {
      // A malformed optional license URL does not invalidate otherwise safe content.
    }
  }
  return name || url ? { name: name || "Source license", ...(url ? { url } : {}) } : null;
}

interface GenericPageInput {
  sourceUrl: URL;
  fetchedUrl: URL;
  html: string;
  dependencies: RuntimeDependencies;
  blocks: SemanticSourceBlock[];
  visibleLinks?: readonly { label: string; url: string }[];
  titleHint?: string;
  localeHint?: string;
  revisionId?: string;
  revisionTimestamp?: string;
  timings?: Record<string, number>;
}

function safeVisibleContentLinks(
  values: readonly { label: string; url: string }[],
): CanonicalSourceLink[] {
  const links: CanonicalSourceLink[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (links.length >= MAX_CHILD_LINKS_PER_PAGE) break;
    let url: URL;
    try {
      url = new URL(value.url);
    } catch {
      continue;
    }
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || (url.port && url.port !== "443")
    ) continue;
    const title = normalizedText(value.label, 500);
    if (!title || seen.has(url.href)) continue;
    seen.add(url.href);
    links.push({ title, canonicalUrl: url.href });
  }
  return links;
}

function genericPageFromHtml(input: GenericPageInput): IngestedPage {
  const $ = load(input.html, { scriptingEnabled: false });
  const canonical = genericCanonicalUrl($, input.fetchedUrl);
  const title = normalizedText(
    $("main h1,article h1,[role='main'] h1,h1").first().text()
      || input.titleHint
      || $("title").first().text(),
    500,
  );
  if (!title) throw sourceError("EXTRACTION_EMPTY", "Source page does not contain a usable title");
  if (!input.blocks.length) {
    throw sourceError("EXTRACTION_EMPTY", `No semantic content was extracted from '${canonical.href}'`);
  }

  const author = normalizedText(
    $("meta[name='author'],meta[property='article:author']").first().attr("content") ?? "",
    500,
  );
  const locale = normalizedText(input.localeHint || $("html").attr("lang") || "", 35);
  const retrievedAt = input.dependencies.now().toISOString();
  const feedItems = extractSemanticFeedItems($, canonical);
  const primaryNavigation = extractPrimaryNavigation($, canonical);
  const paginationNavigation = extractPaginationNavigation($, canonical);
  const navigation = [...paginationNavigation, ...primaryNavigation]
    .filter((item, index, items) => items.findIndex(
      (candidate) => candidate.canonicalUrl === item.canonicalUrl,
    ) === index)
    .slice(0, MAX_NAVIGATION_ITEMS_PER_PAGE);
  const ordinaryLinks = sameOriginChildLinks(
    $,
    canonical,
    new Set(navigation.map((item) => item.canonicalUrl)),
  );
  const contentLinks = safeVisibleContentLinks(input.visibleLinks ?? ordinaryLinks.map((link) => ({
    label: link.title,
    url: link.url,
  })));
  const discoveredLinks: DiscoveredLink[] = [];
  const discoveredUrls = new Set<string>();
  for (const feedItem of feedItems) {
    const target = new URL(feedItem.canonicalUrl);
    if (target.origin !== canonical.origin || discoveredUrls.has(target.href)) continue;
    discoveredUrls.add(target.href);
    discoveredLinks.push({ title: feedItem.title, url: target.href });
  }
  for (const link of ordinaryLinks) {
    if (discoveredLinks.length >= MAX_CHILD_LINKS_PER_PAGE) break;
    if (discoveredUrls.has(link.url)) continue;
    discoveredUrls.add(link.url);
    discoveredLinks.push(link);
  }

  return {
    canonicalUrl: canonical.href,
    title,
    ...(locale ? { locale } : {}),
    blocks: input.blocks,
    ...(feedItems.length >= 2 ? { feedItems } : {}),
    ...(navigation.length ? { navigation } : {}),
    ...(contentLinks.length ? { links: contentLinks } : {}),
    provenance: {
      provider: "web",
      sourceUrl: input.sourceUrl.href,
      canonicalUrl: canonical.href,
      retrievedAt,
    },
    revision: input.revisionId
      ? {
          id: input.revisionId,
          ...(input.revisionTimestamp ? { timestamp: input.revisionTimestamp } : {}),
          url: canonical.href,
        }
      : null,
    license: genericLicense($, canonical),
    attribution: { name: author || canonical.hostname, url: canonical.href },
    discoveredLinks: discoveredLinks.slice(0, MAX_CHILD_LINKS_PER_PAGE),
    ...(input.timings ? { timings: input.timings } : {}),
  };
}

function captureSourceError(error: SourceCaptureError): SourceIngestionError {
  switch (error.code) {
    case "INVALID_URL":
      return sourceError("INVALID_REQUEST", error.message, { cause: error });
    case "SOURCE_BLOCKED":
      return sourceError("SOURCE_BLOCKED", error.message, { cause: error });
    case "CAPTURE_TOO_LARGE":
      return sourceError("SOURCE_TOO_LARGE", error.message, { cause: error });
    case "SOURCE_UNREACHABLE":
    case "CAPTURE_TIMEOUT":
    case "CAPTURE_FAILED":
      return sourceError("SOURCE_UNREACHABLE", error.message, {
        cause: error,
        retryable: error.retryable,
      });
  }
}

const CHALLENGE_PAGE_PATTERN = /(?:access denied|attention required|captcha|forbidden|just a moment|security check|人机验证|安全验证|验证码|访问被拒绝)/iu;

async function ingestChromiumPage(
  sourceUrl: URL,
  dependencies: RuntimeDependencies,
): Promise<IngestedPage> {
  let captured: RenderedPageCapture;
  try {
    captured = await dependencies.capture(sourceUrl.href, { lookup: dependencies.lookup });
  } catch (error) {
    if (error instanceof SourceCaptureError) throw captureSourceError(error);
    throw sourceError("SOURCE_UNREACHABLE", "Chromium capture failed", {
      cause: error,
      retryable: true,
    });
  }
  if (captured.status !== undefined && captured.status >= 400) {
    throw sourceError("SOURCE_UNREACHABLE", `Source returned HTTP ${captured.status}`, {
      retryable: captured.status === 408 || captured.status === 429 || captured.status >= 500,
    });
  }

  if (looksLikeSyndicationXml(captured.html)) {
    return ingestSyndicationXml(
      sourceUrl,
      new URL(captured.finalUrl),
      captured.html,
      dependencies,
      {
        browser_acquire_ms: captured.timings.browserAcquireMs,
        navigate_ms: captured.timings.navigateMs,
        dom_settle_ms: captured.timings.domSettleMs,
        dom_capture_ms: captured.timings.captureMs,
        chromium_total_ms: captured.timings.totalMs,
      },
    );
  }

  const markdownStartedAt = performance.now();
  const converted = renderedHtmlToMarkdown(captured.html, captured.finalUrl);
  const markdownMs = performance.now() - markdownStartedAt;
  if (
    CHALLENGE_PAGE_PATTERN.test(captured.title)
    && converted.stats.textCharacters < 2_000
  ) {
    throw sourceError("SOURCE_UNREACHABLE", "Source returned an access challenge instead of page content", {
      retryable: true,
    });
  }
  if (
    converted.stats.textCharacters < 80
    && converted.stats.imageCount === 0
    && converted.stats.linkCount < 2
  ) {
    throw sourceError("EXTRACTION_EMPTY", "Rendered page did not contain enough semantic content");
  }
  const revisionId = `dom-sha256:${createHash("sha256").update(converted.markdown).digest("hex")}`;
  return genericPageFromHtml({
    sourceUrl,
    fetchedUrl: new URL(captured.finalUrl),
    html: captured.html,
    dependencies,
    blocks: converted.blocks,
    visibleLinks: converted.links,
    titleHint: captured.title,
    localeHint: captured.locale,
    revisionId,
    timings: {
      browser_acquire_ms: captured.timings.browserAcquireMs,
      navigate_ms: captured.timings.navigateMs,
      dom_settle_ms: captured.timings.domSettleMs,
      dom_capture_ms: captured.timings.captureMs,
      chromium_total_ms: captured.timings.totalMs,
      markdown_ms: markdownMs,
    },
  });
}

async function ingestHttpPage(
  sourceUrl: URL,
  dependencies: RuntimeDependencies,
): Promise<IngestedPage> {
  const startedAt = performance.now();
  const fetched = await fetchSafely(sourceUrl, dependencies, {
    accept: "application/rss+xml,application/atom+xml,application/xml;q=0.95,text/xml;q=0.9,text/html;q=0.8,application/xhtml+xml;q=0.8",
    maxBytes: MAX_HTML_BYTES,
  });
  const contentType = fetched.response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  const body = decodeBytes(fetched.body);
  if (SYNDICATION_MIME_TYPES.has(contentType ?? "") || looksLikeSyndicationXml(body)) {
    return ingestSyndicationXml(sourceUrl, fetched.finalUrl, body, dependencies, {
      http_fetch_extract_ms: performance.now() - startedAt,
    });
  }
  if (contentType !== "text/html" && contentType !== "application/xhtml+xml") {
    throw sourceError("SOURCE_UNREACHABLE", `Source returned unsupported MIME type '${contentType || "unknown"}'`);
  }
  const html = body;
  const etag = fetched.response.headers.get("etag");
  const lastModified = fetched.response.headers.get("last-modified");
  const revisionId = etag ? `etag:${etag}` : lastModified ? `last-modified:${lastModified}` : undefined;
  const timestamp = lastModified && !Number.isNaN(Date.parse(lastModified))
    ? new Date(lastModified).toISOString()
    : undefined;
  return genericPageFromHtml({
    sourceUrl,
    fetchedUrl: fetched.finalUrl,
    html,
    dependencies,
    blocks: extractSemanticBlocks(html, fetched.finalUrl),
    revisionId,
    revisionTimestamp: timestamp,
    timings: { http_fetch_extract_ms: performance.now() - startedAt },
  });
}

async function ingestOnePage(
  sourceUrl: URL,
  dependencies: RuntimeDependencies,
  mode: "http" | "chromium",
): Promise<IngestedPage> {
  if (isTiebaLandingUrl(sourceUrl)) return ingestTiebaLanding(sourceUrl, dependencies);
  if (mode === "chromium") return ingestChromiumPage(sourceUrl, dependencies);
  return isWikimediaArticleUrl(sourceUrl)
    ? ingestWikimediaPage(sourceUrl, dependencies)
    : ingestHttpPage(sourceUrl, dependencies);
}

function requestKey(value: string): string {
  const url = new URL(value);
  // A section fragment is meaningful only for the seed; discovered child links
  // are normalized without fragments before they enter the queue.
  return url.href;
}

function embeddedSyndicationDetail(
  item: SemanticSourceFeedItem,
  parent: CanonicalSourcePage,
): IngestedPage {
  const body = item.articleBody;
  const blocks = body?.blocks.length
    ? body.blocks
    : item.summary
      ? [{ type: "paragraph" as const, text: item.summary }]
      : [{
          type: "link" as const,
          link: {
            label: "查看原文",
            url: item.canonicalUrl,
          },
        }];
  const bodyLinks = body?.links ?? [];
  const links = [
    ...bodyLinks,
    { title: "查看原文", canonicalUrl: item.canonicalUrl },
  ].filter((link, index, all) => all.findIndex((candidate) =>
    candidate.canonicalUrl === link.canonicalUrl
  ) === index);
  const publishedAt = item.publishedAt;
  return {
    canonicalUrl: item.canonicalUrl,
    title: item.title,
    ...(parent.locale ? { locale: parent.locale } : {}),
    blocks,
    links,
    provenance: {
      provider: "web",
      sourceUrl: parent.provenance.sourceUrl,
      canonicalUrl: item.canonicalUrl,
      retrievedAt: parent.provenance.retrievedAt,
    },
    revision: {
      id: publishedAt
        ? String(Date.parse(publishedAt))
        : `feed-item-sha256:${createHash("sha256")
          .update(`${item.canonicalUrl}\0${item.title}\0${item.summary ?? ""}`)
          .digest("hex")}`,
      ...(publishedAt ? { timestamp: publishedAt } : {}),
      url: item.canonicalUrl,
    },
    license: parent.license,
    attribution: {
      name: item.author || parent.attribution.name,
      url: item.canonicalUrl,
    },
    syndication: {
      ...(item.author ? { author: item.author } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      ...(item.summary ? { summary: item.summary } : {}),
    },
    discoveredLinks: [],
  };
}

function mergeSyndicationMetadata(
  page: IngestedPage,
  item: SemanticSourceFeedItem,
): IngestedPage {
  return {
    ...page,
    title: item.title || page.title,
    attribution: {
      ...page.attribution,
      name: item.author || page.attribution.name,
    },
    revision: item.publishedAt
      ? {
          ...(page.revision ?? { id: String(Date.parse(item.publishedAt)) }),
          timestamp: item.publishedAt,
          url: page.revision?.url ?? item.canonicalUrl,
        }
      : page.revision,
    syndication: {
      ...(item.author ? { author: item.author } : {}),
      ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
      ...(item.summary ? { summary: item.summary } : {}),
    },
  };
}

export async function ingestSource(
  request: SourceIngestionRequest,
  dependencyOverrides: SourceIngestionDependencies = {},
): Promise<SourceIngestionResult> {
  const seed = parseSeedUrl(request.seedUrl);
  const limits = normalizeRequestLimits(request);
  const mode = request.mode ?? "http";
  const dependencies: RuntimeDependencies = {
    fetch: dependencyOverrides.fetch ?? ((input, init) => fetch(input, init)),
    lookup: dependencyOverrides.lookup ?? (async (hostname) => {
      return nodeLookup(hostname, { all: true, verbatim: true });
    }),
    now: dependencyOverrides.now ?? (() => new Date()),
    userAgent: dependencyOverrides.userAgent ?? WIKIMEDIA_USER_AGENT,
    capture: dependencyOverrides.capture ?? captureRenderedPage,
  };

  const queue: QueueItem[] = [{ url: seed.href, depth: 0 }];
  const queued = new Set<string>([requestKey(seed.href)]);
  const pages: CanonicalSourcePage[] = [];
  const pageByCanonical = new Map<string, CanonicalSourcePage>();
  const timings: Record<string, number> = {};

  while (queue.length && pages.length < limits.maxDocuments) {
    const current = queue.shift()!;
    let ingested: IngestedPage;
    const parent = current.parentCanonicalUrl
      ? pageByCanonical.get(current.parentCanonicalUrl)
      : undefined;
    const embeddedFallback = current.syndicationItem && parent
      ? embeddedSyndicationDetail(current.syndicationItem, parent)
      : undefined;
    try {
      if (
        embeddedFallback
        && current.syndicationItem?.articleBody?.quality === "substantive"
      ) {
        ingested = embeddedFallback;
      } else {
        ingested = await ingestOnePage(parseSeedUrl(current.url), dependencies, mode);
      }
    } catch (error) {
      if (current.depth === 0) throw error;
      if (!embeddedFallback) {
        // A failed child is omitted rather than making the entire bounded
        // crawl unusable. It cannot become an offline link because no edge is
        // committed.
        continue;
      }
      ingested = embeddedFallback;
    }
    if (current.syndicationItem) {
      ingested = mergeSyndicationMetadata(ingested, current.syndicationItem);
    }

    for (const [stage, duration] of Object.entries(ingested.timings ?? {})) {
      timings[stage] = (timings[stage] ?? 0) + duration;
    }

    const existing = pageByCanonical.get(ingested.canonicalUrl);
    const page = existing ?? {
      canonicalUrl: ingested.canonicalUrl,
      ...(current.parentCanonicalUrl ? { parentCanonicalUrl: current.parentCanonicalUrl } : {}),
      depth: current.depth,
      title: ingested.title,
      ...(ingested.locale ? { locale: ingested.locale } : {}),
      blocks: ingested.blocks,
      ...(ingested.feedItems && ingested.feedItems.length > 0
        ? { feedItems: ingested.feedItems }
        : {}),
      ...(ingested.navigation?.length ? { navigation: ingested.navigation } : {}),
      ...(ingested.links?.length ? { links: ingested.links } : {}),
      childLinks: [],
      provenance: ingested.provenance,
      revision: ingested.revision,
      license: ingested.license,
      attribution: ingested.attribution,
      ...(ingested.isSyndicationFeed ? { isSyndicationFeed: true as const } : {}),
      ...(ingested.syndication ? { syndication: ingested.syndication } : {}),
    } satisfies CanonicalSourcePage;

    if (!existing) {
      pages.push(page);
      pageByCanonical.set(page.canonicalUrl, page);
    }
    if (current.parentCanonicalUrl && current.linkTitle) {
      const parent = pageByCanonical.get(current.parentCanonicalUrl);
      if (
        parent
        && parent.canonicalUrl !== page.canonicalUrl
        && !parent.childLinks.some((link) => link.canonicalUrl === page.canonicalUrl)
      ) {
        parent.childLinks.push({ title: current.linkTitle, canonicalUrl: page.canonicalUrl });
      }
    }
    if (existing || current.depth >= limits.maxDepth) continue;

    for (const child of ingested.discoveredLinks.slice(0, MAX_CHILD_LINKS_PER_PAGE)) {
      if (queue.length + pages.length >= limits.maxDocuments * 4) break;
      let childUrl: URL;
      try {
        childUrl = parseSeedUrl(child.url);
      } catch {
        continue;
      }
      childUrl.hash = "";
      const key = requestKey(childUrl.href);
      if (queued.has(key)) continue;
      queued.add(key);
      queue.push({
        url: childUrl.href,
        depth: current.depth + 1,
        parentCanonicalUrl: page.canonicalUrl,
        linkTitle: child.title,
        ...(page.isSyndicationFeed && page.feedItems
          ? {
              syndicationItem: page.feedItems.find((item) =>
                item.canonicalUrl === childUrl.href
              ),
            }
          : {}),
      });
    }
  }

  const entry = pages[0];
  if (!entry) {
    throw sourceError("EXTRACTION_EMPTY", "No source documents were extracted");
  }
  return {
    seedUrl: seed.href,
    entryCanonicalUrl: entry.canonicalUrl,
    pages,
    limits,
    ...(Object.keys(timings).length ? { timings } : {}),
  };
}

export const ingestWebSource = ingestSource;
