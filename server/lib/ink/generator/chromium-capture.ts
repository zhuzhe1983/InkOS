import { lookup as nodeLookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";

import { load } from "cheerio";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type LaunchOptions,
  type Page,
} from "playwright-core";

const MAX_URL_LENGTH = 2_048;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_DOM_NODES = 20_000;
const MAX_SEMANTIC_SNAPSHOT_BYTES = 768 * 1024;
const DEFAULT_DEADLINE_MS = 10_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 6_500;
const DEFAULT_SETTLE_TIMEOUT_MS = 1_200;
const DEFAULT_DNS_TIMEOUT_MS = 1_500;
const DNS_CACHE_TTL_MS = 60_000;
const MAX_WARNINGS = 32;

/**
 * Playwright advertises headless sessions as `HeadlessChrome`, which causes
 * otherwise public editorial sites to return their bot-block page before any
 * JavaScript can run. Keep the real Chromium version while presenting the
 * ordinary Chrome product token. This is not a challenge bypass: cookies,
 * credentials and stealth patches remain disabled, and every subresource is
 * still subject to the existing DNS/SSRF policy.
 */
export function chromiumUserAgent(
  browserVersion: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const version = browserVersion.match(/\d+(?:\.\d+){1,3}/u)?.[0] ?? "120.0.0.0";
  const platformToken = platform === "darwin"
    ? "Macintosh; Intel Mac OS X 10_15_7"
    : platform === "win32"
      ? "Windows NT 10.0; Win64; x64"
      : "X11; Linux x86_64";
  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

function captureUserAgent(browser: Browser): string {
  const configured = process.env.INKOS_CHROMIUM_USER_AGENT?.trim();
  if (configured && configured.length <= 512 && !/[\r\n]/u.test(configured)) {
    return configured;
  }
  return chromiumUserAgent(browser.version());
}

const SYNDICATION_CONTENT_TYPES = new Set([
  "application/atom+xml",
  "application/rss+xml",
  "application/xml",
  "text/xml",
]);

const ALLOWED_RESOURCE_TYPES = new Set([
  "document",
  "script",
  "xhr",
  "fetch",
  "image",
  "stylesheet",
]);

export type SourceCaptureErrorCode =
  | "INVALID_URL"
  | "SOURCE_BLOCKED"
  | "SOURCE_UNREACHABLE"
  | "CAPTURE_TIMEOUT"
  | "CAPTURE_TOO_LARGE"
  | "CAPTURE_FAILED";

export class SourceCaptureError extends Error {
  readonly code: SourceCaptureErrorCode;
  readonly retryable: boolean;

  constructor(
    code: SourceCaptureErrorCode,
    message: string,
    options: { cause?: unknown; retryable?: boolean } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "SourceCaptureError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

export interface CaptureTimings {
  browserAcquireMs: number;
  navigateMs: number;
  domSettleMs: number;
  captureMs: number;
  totalMs: number;
}

export interface RenderedPageCapture {
  requestedUrl: string;
  finalUrl: string;
  html: string;
  title: string;
  locale?: string;
  status?: number;
  partial: boolean;
  warnings: string[];
  timings: CaptureTimings;
}

export interface LookupResult {
  address: string;
  family: number;
}

export type CaptureLookup = (hostname: string) => Promise<readonly LookupResult[]>;
export type ChromiumLaunch = (options: LaunchOptions) => Promise<Browser>;

export interface CaptureRenderedPageOptions {
  /** Wall-clock budget for the complete operation, including browser startup. */
  deadlineMs?: number;
  navigationTimeoutMs?: number;
  settleTimeoutMs?: number;
  dnsTimeoutMs?: number;
  maxScrolls?: number;
  signal?: AbortSignal;
  executablePath?: string;
  launch?: ChromiumLaunch;
  lookup?: CaptureLookup;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface DomActivitySample {
  textLength: number;
  linkCount: number;
  imageCount: number;
  nodeCount: number;
  scrollHeight: number;
  signature?: string;
}

export interface DomStabilityOptions {
  requiredSamples?: number;
  textTolerance?: number;
  nodeTolerance?: number;
  scrollTolerance?: number;
}

export interface ChromiumExecutableSelectionOptions {
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  homeDirectory?: string;
  playwrightExecutablePath?: string;
}

interface DnsCacheEntry {
  expiresAt: number;
  result: Promise<readonly LookupResult[]>;
}

export interface SnapshotResult {
  html: string;
  title: string;
  locale?: string;
  nodeCount: number;
  partial: boolean;
}

export interface SemanticSnapshotLimits {
  maxBytes?: number;
  maxNodes?: number;
}

const defaultLookup: CaptureLookup = async (hostname) => {
  return nodeLookup(hostname, { all: true, verbatim: true });
};
const defaultLaunch: ChromiumLaunch = (options) => chromium.launch(options);
const defaultNow = () => performance.now();
const defaultSleep = (milliseconds: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, milliseconds);
});

const dnsCaches = new WeakMap<CaptureLookup, Map<string, DnsCacheEntry>>();
const browserPools = new WeakMap<ChromiumLaunch, Map<string, Promise<Browser>>>();

function captureError(
  code: SourceCaptureErrorCode,
  message: string,
  options?: { cause?: unknown; retryable?: boolean },
): SourceCaptureError {
  return new SourceCaptureError(code, message, options);
}

function roundedDuration(value: number): number {
  return Math.max(0, Math.round(value * 10) / 10);
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) return fallback;
  return Math.min(maximum, Math.floor(value as number));
}

function normalizeHostname(value: string): string {
  const hostname = value.toLowerCase().replace(/\.$/u, "");
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
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

export function isNonPublicCaptureAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isNonPublicIpv4(address);
  if (family !== 6) return true;

  const lower = address.toLowerCase();
  const mapped = mappedIpv4(lower);
  if (mapped) return isNonPublicIpv4(mapped);

  const firstGroup = Number.parseInt(lower.split(":", 1)[0] || "0", 16);
  return lower === "::"
    || lower === "::1"
    || (firstGroup & 0xfe00) === 0xfc00
    || (firstGroup & 0xffc0) === 0xfe80
    || (firstGroup & 0xff00) === 0xff00
    || lower.startsWith("2001:db8:")
    || lower === "2001:db8::"
    || (firstGroup & 0xe000) !== 0x2000;
}

function dnsCacheFor(lookup: CaptureLookup): Map<string, DnsCacheEntry> {
  let cache = dnsCaches.get(lookup);
  if (!cache) {
    cache = new Map();
    dnsCaches.set(lookup, cache);
  }
  return cache;
}

async function lookupWithCache(
  hostname: string,
  options: { lookup: CaptureLookup; now: () => number; timeoutMs: number },
): Promise<readonly LookupResult[]> {
  const cache = dnsCacheFor(options.lookup);
  const cached = cache.get(hostname);
  const currentTime = options.now();
  if (cached && cached.expiresAt > currentTime) return cached.result;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = Promise.race([
    options.lookup(hostname),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(captureError(
          "SOURCE_UNREACHABLE",
          `DNS lookup timed out after ${options.timeoutMs} ms for '${hostname}'`,
          { retryable: true },
        ));
      }, options.timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });

  cache.set(hostname, { expiresAt: currentTime + DNS_CACHE_TTL_MS, result });
  try {
    return await result;
  } catch (error) {
    cache.delete(hostname);
    if (error instanceof SourceCaptureError) throw error;
    throw captureError("SOURCE_UNREACHABLE", `DNS lookup failed for '${hostname}'`, {
      cause: error,
      retryable: true,
    });
  }
}

/**
 * Validates both the URL shape and every DNS answer. This function is also
 * used by the request router so redirects and subresources cannot reach a
 * private network after the seed URL was accepted.
 */
export async function validateCaptureUrl(
  value: string | URL,
  options: {
    lookup?: CaptureLookup;
    now?: () => number;
    dnsTimeoutMs?: number;
  } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value) : new URL(value);
  } catch (error) {
    throw captureError("INVALID_URL", "Capture URL must be an absolute HTTPS URL", { cause: error });
  }
  if (url.href.length > MAX_URL_LENGTH) {
    throw captureError("INVALID_URL", `Capture URL exceeds ${MAX_URL_LENGTH} characters`);
  }
  if (url.protocol !== "https:") {
    throw captureError("SOURCE_BLOCKED", "Only HTTPS capture URLs are accepted");
  }
  if (url.username || url.password) {
    throw captureError("SOURCE_BLOCKED", "Capture URLs cannot contain credentials");
  }
  if (url.port && url.port !== "443") {
    throw captureError("SOURCE_BLOCKED", "Capture URLs cannot use a non-default port");
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")) {
    throw captureError("SOURCE_BLOCKED", `Host '${url.hostname}' is not a public capture host`);
  }

  if (isIP(hostname)) {
    if (isNonPublicCaptureAddress(hostname)) {
      throw captureError("SOURCE_BLOCKED", `Host '${url.hostname}' is not a public address`);
    }
    return url;
  }

  const lookup = options.lookup ?? defaultLookup;
  const addresses = await lookupWithCache(hostname, {
    lookup,
    now: options.now ?? defaultNow,
    timeoutMs: positiveInteger(options.dnsTimeoutMs, DEFAULT_DNS_TIMEOUT_MS, DEFAULT_DEADLINE_MS),
  });
  if (addresses.length === 0 || addresses.some(({ address }) => isNonPublicCaptureAddress(address))) {
    throw captureError(
      "SOURCE_BLOCKED",
      `Host '${hostname}' did not resolve exclusively to public addresses`,
    );
  }
  return url;
}

function expandHome(path: string, homeDirectory: string): string {
  if (path === "~") return homeDirectory;
  return path.startsWith("~/") ? `${homeDirectory}/${path.slice(2)}` : path;
}

/** Selects a system Chromium without weakening its sandbox. */
export function selectChromiumExecutablePath(
  options: ChromiumExecutableSelectionOptions = {},
): string | undefined {
  const environment = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const homeDirectory = options.homeDirectory ?? homedir();
  const configured = environment.INKOS_CHROMIUM_EXECUTABLE_PATH?.trim();
  if (configured) {
    const expanded = expandHome(configured, homeDirectory);
    return exists(expanded) ? expanded : undefined;
  }

  const candidates = platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        `${homeDirectory}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
        `${homeDirectory}/Applications/Chromium.app/Contents/MacOS/Chromium`,
      ]
    : platform === "linux"
      ? [
          "/usr/bin/google-chrome-stable",
          "/usr/bin/google-chrome",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
          "/snap/bin/chromium",
        ]
      : [];

  if (options.playwrightExecutablePath) candidates.push(options.playwrightExecutablePath);
  return candidates.find((candidate) => exists(candidate));
}

export function isDomStable(
  samples: readonly DomActivitySample[],
  options: DomStabilityOptions = {},
): boolean {
  const requiredSamples = Math.max(2, Math.floor(options.requiredSamples ?? 3));
  if (samples.length < requiredSamples) return false;
  const recent = samples.slice(-requiredSamples);
  const textTolerance = Math.max(0, options.textTolerance ?? 48);
  const nodeTolerance = Math.max(0, options.nodeTolerance ?? 3);
  const scrollTolerance = Math.max(0, options.scrollTolerance ?? 8);

  for (let index = 1; index < recent.length; index += 1) {
    const previous = recent[index - 1];
    const current = recent[index];
    const relativeTextTolerance = Math.max(textTolerance, Math.floor(previous.textLength * 0.005));
    if (Math.abs(current.textLength - previous.textLength) > relativeTextTolerance
      || Math.abs(current.nodeCount - previous.nodeCount) > nodeTolerance
      || Math.abs(current.linkCount - previous.linkCount) > 1
      || Math.abs(current.imageCount - previous.imageCount) > 1
      || Math.abs(current.scrollHeight - previous.scrollHeight) > scrollTolerance
      || (previous.signature !== undefined
        && current.signature !== undefined
        && previous.signature !== current.signature)) {
      return false;
    }
  }
  return true;
}

function browserPoolFor(launch: ChromiumLaunch): Map<string, Promise<Browser>> {
  let pool = browserPools.get(launch);
  if (!pool) {
    pool = new Map();
    browserPools.set(launch, pool);
  }
  return pool;
}

async function acquireBrowser(launch: ChromiumLaunch, executablePath?: string): Promise<Browser> {
  const pool = browserPoolFor(launch);
  const key = executablePath ?? "playwright-default";
  const current = pool.get(key);
  if (current) {
    try {
      const browser = await current;
      if (browser.isConnected()) return browser;
    } catch {
      // A failed launch is evicted below and retried once by this caller.
    }
    pool.delete(key);
  }

  const browserPromise = launch({
    headless: true,
    executablePath,
    args: [
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-first-run",
    ],
  });
  pool.set(key, browserPromise);
  try {
    const browser = await browserPromise;
    browser.on("disconnected", () => {
      if (pool.get(key) === browserPromise) pool.delete(key);
    });
    return browser;
  } catch (error) {
    if (pool.get(key) === browserPromise) pool.delete(key);
    throw error;
  }
}

async function domActivitySample(page: Page): Promise<DomActivitySample> {
  return page.evaluate(() => {
    const bodyText = document.body?.innerText ?? "";
    const signatureSource = `${document.title}\n${bodyText.slice(0, 512)}\n${bodyText.slice(-512)}`;
    let hash = 2_166_136_261;
    for (let index = 0; index < signatureSource.length; index += 1) {
      hash ^= signatureSource.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
    return {
      textLength: bodyText.length,
      linkCount: document.links.length,
      imageCount: document.images.length,
      nodeCount: document.getElementsByTagName("*").length,
      scrollHeight: document.documentElement.scrollHeight,
      signature: hash.toString(16),
    };
  });
}

async function settleDom(
  page: Page,
  options: {
    timeoutMs: number;
    maxScrolls: number;
    now: () => number;
    sleep: (milliseconds: number) => Promise<void>;
    remaining: () => number;
  },
): Promise<{ stable: boolean; scrolled: number }> {
  const startedAt = options.now();
  const samples: DomActivitySample[] = [];
  let stable = false;
  while (options.now() - startedAt < options.timeoutMs && options.remaining() > 250) {
    samples.push(await domActivitySample(page));
    if (isDomStable(samples)) {
      stable = true;
      break;
    }
    await options.sleep(Math.min(150, Math.max(25, options.remaining() - 100)));
  }

  let scrolled = 0;
  for (let index = 0; index < options.maxScrolls && options.remaining() > 300; index += 1) {
    const moved = await page.evaluate(() => {
      const maximum = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      if (maximum <= window.scrollY + 8) return false;
      window.scrollTo(0, Math.min(maximum, window.scrollY + Math.max(320, window.innerHeight * 0.85)));
      return true;
    });
    if (!moved) break;
    scrolled += 1;
    await options.sleep(Math.min(140, Math.max(25, options.remaining() - 100)));
  }
  if (scrolled > 0 && options.remaining() > 100) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await options.sleep(Math.min(60, Math.max(10, options.remaining() - 50)));
  }
  return { stable, scrolled };
}

async function captureSnapshot(page: Page, forceSemantic = false): Promise<SnapshotResult> {
  return page.evaluate(({ maxNodes, forceSemanticSnapshot }) => {
    for (const image of document.querySelectorAll("img")) {
      const source = image.currentSrc || image.src;
      if (source) {
        image.setAttribute("data-current-src", source);
        image.setAttribute("src", source);
      }
      const bounds = image.getBoundingClientRect();
      const style = getComputedStyle(image);
      const hidden = image.hidden
        || style.display === "none"
        || style.visibility === "hidden"
        || style.visibility === "collapse"
        || Number.parseFloat(style.opacity || "1") === 0;
      image.setAttribute("data-ink-rendered-width", String(Math.max(0, Math.round(bounds.width))));
      image.setAttribute("data-ink-rendered-height", String(Math.max(0, Math.round(bounds.height))));
      image.setAttribute("data-ink-rendered-hidden", hidden ? "true" : "false");
    }
    for (const anchor of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      if (anchor.href) anchor.setAttribute("href", anchor.href);
    }

    const totalNodes = document.getElementsByTagName("*").length;
    const useSemanticRoot = forceSemanticSnapshot || totalNodes > maxNodes;
    const sourceRoot = useSemanticRoot
      ? document.querySelector("main, article, [role='main']") ?? document.body
      : document.documentElement;
    if (!sourceRoot) {
      return {
        html: "<html><head></head><body></body></html>",
        title: document.title || "Untitled",
        locale: document.documentElement.lang || undefined,
        nodeCount: 3,
        partial: true,
      };
    }

    const clone = sourceRoot.cloneNode(true) as Element;
    for (const element of clone.querySelectorAll(
      "script, style, noscript, template, iframe, object, embed, canvas, svg",
    )) {
      element.remove();
    }
    const preservedAttributes = new Set([
      "class",
      "id",
      "href",
      "src",
      "srcset",
      "sizes",
      "data-src",
      "data-srcset",
      "data-original",
      "data-current-src",
      "data-ink-rendered-width",
      "data-ink-rendered-height",
      "data-ink-rendered-hidden",
      "alt",
      "aria-hidden",
      "title",
      "lang",
      "role",
      "aria-label",
      "datetime",
      "itemprop",
      "itemtype",
      "rel",
      "content",
      "name",
      "property",
      "width",
      "height",
    ]);
    for (const element of [clone, ...clone.querySelectorAll("*")]) {
      for (const attribute of [...element.attributes]) {
        if (!preservedAttributes.has(attribute.name.toLowerCase())) {
          element.removeAttribute(attribute.name);
        }
      }
    }

    let partial = useSemanticRoot;
    let descendants = [...clone.querySelectorAll("*")];
    const wrapperNodes = useSemanticRoot ? 5 : 1;
    if (descendants.length + wrapperNodes > maxNodes) {
      partial = true;
      for (const element of descendants.slice(Math.max(0, maxNodes - wrapperNodes)).reverse()) {
        element.remove();
      }
      descendants = [...clone.querySelectorAll("*")];
    }

    const locale = document.documentElement.lang
      || document.querySelector("meta[property='og:locale']")?.getAttribute("content")
      || undefined;
    const title = document.title.trim()
      || document.querySelector("h1")?.textContent?.trim()
      || "Untitled";
    const html = useSemanticRoot
      ? `<html${locale ? ` lang="${locale.replace(/["&<>]/gu, "")}"` : ""}><head><title>${title
          .replace(/&/gu, "&amp;")
          .replace(/</gu, "&lt;")
          .replace(/>/gu, "&gt;")}</title></head><body>${clone.outerHTML}</body></html>`
      : clone.outerHTML;
    return {
      html,
      title,
      locale,
      nodeCount: descendants.length + wrapperNodes,
      partial,
    };
  }, { maxNodes: MAX_DOM_NODES, forceSemanticSnapshot: forceSemantic });
}

function escapedHtmlText(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function escapedHtmlAttribute(value: string): string {
  return escapedHtmlText(value).replace(/"/gu, "&quot;");
}

const CHAPTER_HEADING_PATTERN = /^(?:第[一二三四五六七八九十百千零〇两0-9]+[卷回章节部]|卷之[一二三四五六七八九十百千零〇两0-9]+|chapter\s+[ivxlcdm0-9]+)/iu;
const CHAPTER_NAVIGATION_PATTERN = /(?:chapter|contents?|toc|卷目|回目|目录|章(?:节)?导航)/iu;

/**
 * Reduce a post-render snapshot to a contiguous, semantic prefix without ever
 * raising the hard response or DOM limits. The reducer runs only for oversized
 * pages. It keeps the first in-content chapter directory, meaningful links and
 * images, removes obvious page chrome/licence boilerplate, promotes compact
 * chapter labels to headings, and trims from the tail on block boundaries.
 */
export function reduceSemanticSnapshot(
  snapshot: SnapshotResult,
  limits: SemanticSnapshotLimits = {},
): SnapshotResult {
  const maxBytes = Math.max(1_024, Math.min(
    limits.maxBytes ?? MAX_SEMANTIC_SNAPSHOT_BYTES,
    MAX_HTML_BYTES,
  ));
  const maxNodes = Math.max(8, Math.min(limits.maxNodes ?? MAX_DOM_NODES, MAX_DOM_NODES));
  const $ = load(snapshot.html, { scriptingEnabled: false });
  let sourceRoot = $(".mw-parser-output,main,article,[role='main']").first();
  if (!sourceRoot.length) sourceRoot = $("body").first();
  if (!sourceRoot.length) {
    return {
      ...snapshot,
      html: `<html><head><title>${escapedHtmlText(snapshot.title)}</title></head><body></body></html>`,
      nodeCount: 4,
      partial: true,
    };
  }

  sourceRoot.find(
    "script,style,noscript,template,iframe,object,embed,canvas,svg,aside,footer," +
    ".pg-boilerplate,#pg-header,#pg-footer,[aria-hidden='true']",
  ).remove();

  sourceRoot.find("nav,[role='navigation']").each((_, element) => {
    const node = $(element);
    const marker = `${node.attr("id") ?? ""} ${node.attr("class") ?? ""} `
      + `${node.attr("aria-label") ?? ""} ${node.text().slice(0, 500)}`;
    if (!CHAPTER_NAVIGATION_PATTERN.test(marker)) node.remove();
  });

  const directoryKeys = new Set<string>();
  sourceRoot.find("*").each((_, element) => {
    const node = $(element);
    const marker = `${node.attr("id") ?? ""} ${node.attr("class") ?? ""} ${node.attr("role") ?? ""}`;
    if (!CHAPTER_NAVIGATION_PATTERN.test(marker)) return;
    const key = node.text().replace(/\s+/gu, " ").trim().slice(0, 8_000);
    if (!key) return;
    if (directoryKeys.has(key)) node.remove();
    else directoryKeys.add(key);
  });

  sourceRoot.find("p").each((_, element) => {
    const node = $(element);
    const text = node.text().replace(/\s+/gu, " ").trim();
    if (text.length > 120 || !CHAPTER_HEADING_PATTERN.test(text)) return;
    element.name = "h2";
  });

  const locale = snapshot.locale
    ? ` lang="${escapedHtmlAttribute(snapshot.locale.slice(0, 35))}"`
    : "";
  const title = escapedHtmlText(snapshot.title.slice(0, 500));
  const rootIsBody = sourceRoot.get(0)?.name?.toLocaleLowerCase() === "body";
  const wrapperHtml = (): string => {
    const content = rootIsBody
      ? sourceRoot.html() ?? ""
      : $.html(sourceRoot);
    return `<html${locale}><head><title>${title}</title></head><body>${content}</body></html>`;
  };
  const wrapperNodeCount = rootIsBody ? 4 : 5;

  const descendants = sourceRoot.find("*").toArray();
  const allowedDescendants = Math.max(0, maxNodes - wrapperNodeCount);
  if (descendants.length > allowedDescendants) {
    for (const element of descendants.slice(allowedDescendants).reverse()) $(element).remove();
  }

  const truncateLeafToFit = (leaf: typeof sourceRoot): boolean => {
    const original = leaf.text();
    if (!original.trim()) return false;
    leaf.text("");
    if (Buffer.byteLength(wrapperHtml(), "utf8") > maxBytes) {
      leaf.text(original);
      return false;
    }
    let low = 0;
    let high = original.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      leaf.text(`${original.slice(0, middle).trimEnd()}…`);
      if (Buffer.byteLength(wrapperHtml(), "utf8") <= maxBytes) low = middle;
      else high = middle - 1;
    }
    leaf.text(low > 0 ? `${original.slice(0, low).trimEnd()}…` : "");
    return true;
  };

  const trimTail = (container: typeof sourceRoot): boolean => {
    const last = container.children().last();
    if (!last.length) return truncateLeafToFit(container);
    const nested = last.children();
    if (nested.length && trimTail(last as typeof sourceRoot)) return true;
    if (!nested.length && truncateLeafToFit(last as typeof sourceRoot)) return true;
    last.remove();
    return true;
  };

  let html = wrapperHtml();
  let iterations = 0;
  while (Buffer.byteLength(html, "utf8") > maxBytes && iterations < maxNodes) {
    if (!trimTail(sourceRoot)) break;
    html = wrapperHtml();
    iterations += 1;
  }

  return {
    ...snapshot,
    html,
    nodeCount: sourceRoot.find("*").length + wrapperNodeCount,
    partial: true,
  };
}

function addWarning(warnings: string[], warning: string): void {
  if (warnings.length >= MAX_WARNINGS || warnings.includes(warning)) return;
  warnings.push(warning);
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

async function closeQuietly(context: BrowserContext | undefined): Promise<void> {
  if (!context) return;
  try {
    await context.close();
  } catch {
    // The hard deadline may already have closed the browser context.
  }
}

/**
 * Captures the post-JavaScript DOM in Chromium. The browser process is shared,
 * while cookies, storage, service workers and pages live in a fresh context
 * that is always closed at the end of one request.
 */
export async function captureRenderedPage(
  value: string,
  options: CaptureRenderedPageOptions = {},
): Promise<RenderedPageCapture> {
  const now = options.now ?? defaultNow;
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = now();
  const deadlineMs = positiveInteger(options.deadlineMs, DEFAULT_DEADLINE_MS, 60_000);
  const deadlineAt = startedAt + deadlineMs;
  const remaining = () => Math.max(0, deadlineAt - now());
  const lookup = options.lookup ?? defaultLookup;
  const dnsTimeoutMs = positiveInteger(options.dnsTimeoutMs, DEFAULT_DNS_TIMEOUT_MS, deadlineMs);
  const requested = await validateCaptureUrl(value, { lookup, now, dnsTimeoutMs });
  const requestedUrl = requested.href;
  const warnings: string[] = [];
  const timings: CaptureTimings = {
    browserAcquireMs: 0,
    navigateMs: 0,
    domSettleMs: 0,
    captureMs: 0,
    totalMs: 0,
  };
  let context: BrowserContext | undefined;
  let abortHandler: (() => void) | undefined;
  let rejectCancellation: ((error: SourceCaptureError) => void) | undefined;
  let cancellationCause: SourceCaptureError | undefined;

  const cancellation = new Promise<never>((_, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (error: SourceCaptureError) => {
    if (cancellationCause) return;
    cancellationCause = error;
    void closeQuietly(context);
    rejectCancellation?.(error);
  };
  const deadlineTimer = setTimeout(() => {
    cancel(captureError("CAPTURE_TIMEOUT", `Chromium capture exceeded its ${deadlineMs} ms deadline`, {
      retryable: true,
    }));
  }, Math.max(1, remaining()));
  if (options.signal) {
    abortHandler = () => cancel(captureError("CAPTURE_FAILED", "Chromium capture was aborted", {
      retryable: true,
    }));
    if (options.signal.aborted) abortHandler();
    else options.signal.addEventListener("abort", abortHandler, { once: true });
  }

  const run = async (): Promise<RenderedPageCapture> => {
    const configuredPath = options.executablePath
      ?? selectChromiumExecutablePath({ playwrightExecutablePath: chromium.executablePath() });
    if (!options.executablePath
      && process.env.INKOS_CHROMIUM_EXECUTABLE_PATH
      && !configuredPath) {
      throw captureError(
        "CAPTURE_FAILED",
        "INKOS_CHROMIUM_EXECUTABLE_PATH does not point to an executable file",
      );
    }

    const browserStartedAt = now();
    let browser: Browser;
    try {
      browser = await acquireBrowser(options.launch ?? defaultLaunch, configuredPath);
    } catch (error) {
      throw captureError("CAPTURE_FAILED", "Unable to launch the Chromium capture process", {
        cause: error,
        retryable: true,
      });
    }
    timings.browserAcquireMs = roundedDuration(now() - browserStartedAt);
    if (remaining() <= 0) {
      throw captureError("CAPTURE_TIMEOUT", `Chromium capture exceeded its ${deadlineMs} ms deadline`, {
        retryable: true,
      });
    }

    context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
      ignoreHTTPSErrors: false,
      javaScriptEnabled: true,
      userAgent: captureUserAgent(browser),
      viewport: { width: 720, height: 960 },
      locale: "zh-CN",
    });
    await context.routeWebSocket(/.*/u, (webSocket) => {
      addWarning(warnings, "Blocked websocket resource");
      webSocket.close({ code: 1_008, reason: "WebSockets are disabled during capture" });
    });

    let page: Page;
    try {
      page = await context.newPage();
    } catch (error) {
      throw captureError("CAPTURE_FAILED", "Unable to create an isolated Chromium page", {
        cause: error,
        retryable: true,
      });
    }
    context.on("page", (openedPage) => {
      if (openedPage !== page) void openedPage.close();
    });

    let fatalNavigationError: SourceCaptureError | undefined;
    await context.route("**/*", async (route) => {
      const request = route.request();
      const resourceType = request.resourceType();
      if (!ALLOWED_RESOURCE_TYPES.has(resourceType)) {
        addWarning(warnings, `Blocked ${resourceType} resource`);
        await route.abort("blockedbyclient");
        return;
      }
      try {
        await validateCaptureUrl(request.url(), { lookup, now, dnsTimeoutMs });
        await route.continue();
      } catch (error) {
        const captureFailure = error instanceof SourceCaptureError
          ? error
          : captureError("SOURCE_BLOCKED", `Blocked unsafe resource '${request.url()}'`, { cause: error });
        addWarning(warnings, captureFailure.message);
        if (request.isNavigationRequest() && resourceType === "document") {
          fatalNavigationError = captureFailure;
        }
        await route.abort("blockedbyclient");
      }
    });

    const navigateStartedAt = now();
    const navigationTimeoutMs = Math.max(250, Math.min(
      positiveInteger(
        options.navigationTimeoutMs,
        DEFAULT_NAVIGATION_TIMEOUT_MS,
        deadlineMs,
      ),
      remaining() - 150,
    ));
    let responseStatus: number | undefined;
    let syndicationXml: string | undefined;
    let partial = false;
    try {
      const response = await page.goto(requestedUrl, {
        waitUntil: "domcontentloaded",
        timeout: navigationTimeoutMs,
      });
      responseStatus = response?.status();
      const responseContentType = response?.headers()["content-type"]
        ?.split(";", 1)[0]
        .trim()
        .toLocaleLowerCase();
      if (response && SYNDICATION_CONTENT_TYPES.has(responseContentType ?? "")) {
        try {
          const bytes = await response.body();
          if (bytes.byteLength > MAX_HTML_BYTES) {
            throw captureError(
              "CAPTURE_TOO_LARGE",
              `Syndication XML exceeds the ${MAX_HTML_BYTES} byte capture limit`,
            );
          }
          const value = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
          if (/^\s*(?:<\?xml[^>]*>\s*)?<(?:rss|feed)(?:\s|>)/iu.test(value)) {
            syndicationXml = value;
          }
        } catch (error) {
          if (error instanceof SourceCaptureError) throw error;
          // Some browser adapters cannot replay the main response body after
          // DOMContentLoaded. The ordinary DOM snapshot remains a safe fallback.
        }
      }
    } catch (error) {
      if (fatalNavigationError) throw fatalNavigationError;
      if (!isTimeoutError(error)) {
        throw captureError("SOURCE_UNREACHABLE", `Chromium could not navigate to '${requestedUrl}'`, {
          cause: error,
          retryable: true,
        });
      }
      partial = true;
      addWarning(warnings, `Navigation did not reach DOMContentLoaded within ${navigationTimeoutMs} ms`);
    }
    timings.navigateMs = roundedDuration(now() - navigateStartedAt);

    const finalUrl = page.url() || requestedUrl;
    await validateCaptureUrl(finalUrl, { lookup, now, dnsTimeoutMs });
    if (syndicationXml) {
      timings.totalMs = roundedDuration(now() - startedAt);
      return {
        requestedUrl,
        finalUrl,
        html: syndicationXml,
        title: "Syndication feed",
        status: responseStatus,
        partial: false,
        warnings,
        timings,
      };
    }
    const settleStartedAt = now();
    const settleResult = await settleDom(page, {
      timeoutMs: Math.min(
        positiveInteger(options.settleTimeoutMs, DEFAULT_SETTLE_TIMEOUT_MS, deadlineMs),
        Math.max(100, remaining() - 250),
      ),
      maxScrolls: Math.min(2, Math.max(0, Math.floor(options.maxScrolls ?? 2))),
      now,
      sleep,
      remaining,
    });
    timings.domSettleMs = roundedDuration(now() - settleStartedAt);
    if (!settleResult.stable) {
      partial = true;
      addWarning(warnings, "Rendered DOM was still changing when the settle budget expired");
    }

    const captureStartedAt = now();
    let snapshot = await captureSnapshot(page);
    if (
      Buffer.byteLength(snapshot.html, "utf8") > MAX_SEMANTIC_SNAPSHOT_BYTES
      || snapshot.nodeCount > MAX_DOM_NODES
    ) {
      snapshot = reduceSemanticSnapshot(snapshot);
    }
    timings.captureMs = roundedDuration(now() - captureStartedAt);
    const htmlBytes = Buffer.byteLength(snapshot.html, "utf8");
    if (snapshot.nodeCount > MAX_DOM_NODES || htmlBytes > MAX_HTML_BYTES) {
      throw captureError(
        "CAPTURE_TOO_LARGE",
        `Rendered DOM exceeds the ${MAX_DOM_NODES} node / ${MAX_HTML_BYTES} byte capture limits`,
      );
    }
    if (snapshot.partial) {
      partial = true;
      addWarning(warnings, "Rendered DOM was reduced to a bounded semantic snapshot");
    }
    timings.totalMs = roundedDuration(now() - startedAt);
    return {
      requestedUrl,
      finalUrl,
      html: snapshot.html,
      title: snapshot.title,
      locale: snapshot.locale,
      status: responseStatus,
      partial,
      warnings,
      timings,
    };
  };

  try {
    if (cancellationCause) throw cancellationCause;
    return await Promise.race([run(), cancellation]);
  } catch (error) {
    if (error instanceof SourceCaptureError) throw error;
    throw captureError("CAPTURE_FAILED", "Chromium capture failed", {
      cause: error,
      retryable: true,
    });
  } finally {
    clearTimeout(deadlineTimer);
    if (options.signal && abortHandler) options.signal.removeEventListener("abort", abortHandler);
    await closeQuietly(context);
  }
}
