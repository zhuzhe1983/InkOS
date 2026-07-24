import { describe, expect, it, vi } from "vitest";

import {
  chromiumUserAgent,
  isDomStable,
  isNonPublicCaptureAddress,
  reduceSemanticSnapshot,
  selectChromiumExecutablePath,
  SourceCaptureError,
  validateCaptureUrl,
  type DomActivitySample,
} from "./chromium-capture";

function publicLookup() {
  return vi.fn(async () => [{ address: "93.184.216.34", family: 4 }] as const);
}

describe("Chromium capture URL policy", () => {
  it("accepts credential-free HTTPS on the default port and caches DNS", async () => {
    const lookup = publicLookup();
    const now = vi.fn(() => 1_000);

    await expect(validateCaptureUrl("https://example.com/page", { lookup, now }))
      .resolves.toMatchObject({ hostname: "example.com", pathname: "/page" });
    await validateCaptureUrl("https://example.com/another", { lookup, now });

    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it.each([
    "http://example.com/",
    "https://user:secret@example.com/",
    "https://example.com:8443/",
    "https://localhost/",
    "https://printer.local/",
    "https://127.0.0.1/",
    "https://10.0.0.8/",
    "https://192.168.1.2/",
    "https://[::1]/",
    "https://[fd00::1]/",
  ])("blocks unsafe source %s", async (url) => {
    const lookup = vi.fn();
    await expect(validateCaptureUrl(url, { lookup })).rejects.toBeInstanceOf(SourceCaptureError);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects a hostname when any DNS answer is private", async () => {
    const lookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "192.168.1.8", family: 4 },
    ] as const);
    await expect(validateCaptureUrl("https://example.net/", { lookup }))
      .rejects.toMatchObject({ code: "SOURCE_BLOCKED" });
  });

  it("allows the RFC 2544 fake-IP range used by trusted local proxy/TUN egress", async () => {
    const lookup = vi.fn(async () => [{ address: "198.18.2.163", family: 4 }] as const);
    await expect(validateCaptureUrl("https://www.cnbeta.com.tw/", { lookup }))
      .resolves.toMatchObject({ hostname: "www.cnbeta.com.tw" });
    expect(isNonPublicCaptureAddress("198.18.0.1")).toBe(false);
    expect(isNonPublicCaptureAddress("198.19.255.254")).toBe(false);
  });

  it("recognizes private, reserved and mapped addresses", () => {
    expect(isNonPublicCaptureAddress("100.64.0.1")).toBe(true);
    expect(isNonPublicCaptureAddress("203.0.113.8")).toBe(true);
    expect(isNonPublicCaptureAddress("::ffff:192.168.1.3")).toBe(true);
    expect(isNonPublicCaptureAddress("fe80::1")).toBe(true);
    expect(isNonPublicCaptureAddress("2606:4700:4700::1111")).toBe(false);
    expect(isNonPublicCaptureAddress("93.184.216.34")).toBe(false);
  });
});

describe("DOM stability", () => {
  const sample = (overrides: Partial<DomActivitySample> = {}): DomActivitySample => ({
    textLength: 10_000,
    linkCount: 30,
    imageCount: 12,
    nodeCount: 800,
    scrollHeight: 4_000,
    signature: "abc",
    ...overrides,
  });

  it("requires a short run of equivalent samples", () => {
    expect(isDomStable([sample(), sample()])).toBe(false);
    expect(isDomStable([
      sample(),
      sample({ textLength: 10_020, nodeCount: 802, scrollHeight: 4_004 }),
      sample({ textLength: 10_030, nodeCount: 803, scrollHeight: 4_006 }),
    ])).toBe(true);
  });

  it("does not treat equal-sized but changing content as stable", () => {
    expect(isDomStable([
      sample({ signature: "a" }),
      sample({ signature: "b" }),
      sample({ signature: "c" }),
    ])).toBe(false);
  });

  it("rejects structural and scrolling growth", () => {
    expect(isDomStable([
      sample(),
      sample({ nodeCount: 950, scrollHeight: 5_000 }),
      sample({ nodeCount: 1_100, scrollHeight: 6_000 }),
    ])).toBe(false);
  });
});

describe("oversized semantic snapshots", () => {
  it("keeps a bounded chapter prefix, the first directory, links and images", () => {
    const chapters = Array.from({ length: 12 }, (_, index) => `
      <p id="chapter-${index + 1}">第${index + 1}卷 第${index + 1}章</p>
      <p>${`第 ${index + 1} 章的正文内容。`.repeat(500)}</p>
    `).join("");
    const snapshot = reduceSemanticSnapshot({
      title: "A very long public-domain book",
      locale: "zh-CN",
      nodeCount: 200,
      partial: false,
      html: `<!doctype html><html lang="zh-CN"><head><title>Book</title></head><body>
        <header class="pg-boilerplate">download chrome</header>
        <nav class="site-nav"><a href="https://example.com/login">Login</a></nav>
        <nav class="table-of-contents"><a href="https://example.com/book#chapter-1">第一卷</a></nav>
        <nav class="table-of-contents"><a href="https://example.com/book#chapter-1">第一卷</a></nav>
        <img src="https://example.com/cover.jpg" alt="封面"
             data-ink-rendered-width="600" data-ink-rendered-height="800">
        ${chapters}
        <footer>full duplicated licence boilerplate</footer>
      </body></html>`,
    }, { maxBytes: 12_000, maxNodes: 80 });

    expect(Buffer.byteLength(snapshot.html, "utf8")).toBeLessThanOrEqual(12_000);
    expect(snapshot.nodeCount).toBeLessThanOrEqual(80);
    expect(snapshot.partial).toBe(true);
    expect(snapshot.html).not.toContain("download chrome");
    expect(snapshot.html).not.toContain("Login");
    expect(snapshot.html).not.toContain("duplicated licence");
    expect(snapshot.html.match(/table-of-contents/gu)).toHaveLength(1);
    expect(snapshot.html).toContain("https://example.com/cover.jpg");
    expect(snapshot.html).toMatch(/<h2 id="chapter-1">第1卷 第1章<\/h2>/u);
    expect(snapshot.html).toContain("第 1 章的正文内容");
    expect(snapshot.html).not.toContain("第 12 章的正文内容");
  });

  it("truncates one enormous leaf without producing invalid or oversized HTML", () => {
    const snapshot = reduceSemanticSnapshot({
      title: "One long paragraph",
      nodeCount: 5,
      partial: false,
      html: `<html><body><article><p>${"今古奇觀正文".repeat(20_000)}</p></article></body></html>`,
    }, { maxBytes: 8_000, maxNodes: 20 });

    expect(Buffer.byteLength(snapshot.html, "utf8")).toBeLessThanOrEqual(8_000);
    expect(snapshot.html).toContain("今古奇觀正文");
    expect(snapshot.html).toContain("…</p>");
    expect(snapshot.html).toMatch(/^<html><head><title>One long paragraph<\/title><\/head><body>/u);
    expect(snapshot.html).toMatch(/<\/body><\/html>$/u);
  });
});

describe("Chromium executable selection", () => {
  it("uses a normal Chrome product token with the actual browser version", () => {
    expect(chromiumUserAgent("150.0.7339.2", "darwin")).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7339.2 Safari/537.36",
    );
    expect(chromiumUserAgent("HeadlessChrome/151.0.1.0", "linux")).toContain(
      "Chrome/151.0.1.0",
    );
    expect(chromiumUserAgent("HeadlessChrome/151.0.1.0", "linux")).not.toContain(
      "HeadlessChrome",
    );
  });

  it("prefers the configured executable and expands the home directory", () => {
    const exists = vi.fn((path: string) => path === "/Users/test/bin/chrome");
    expect(selectChromiumExecutablePath({
      env: { INKOS_CHROMIUM_EXECUTABLE_PATH: "~/bin/chrome" },
      platform: "darwin",
      homeDirectory: "/Users/test",
      exists,
    })).toBe("/Users/test/bin/chrome");
  });

  it("uses the first installed system browser before Playwright's path", () => {
    const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    expect(selectChromiumExecutablePath({
      env: {},
      platform: "darwin",
      homeDirectory: "/Users/test",
      playwrightExecutablePath: "/cache/playwright/chromium",
      exists: (path) => path === chrome || path === "/cache/playwright/chromium",
    })).toBe(chrome);
  });

  it("falls back to an installed Playwright executable", () => {
    expect(selectChromiumExecutablePath({
      env: {},
      platform: "linux",
      playwrightExecutablePath: "/cache/playwright/chromium",
      exists: (path) => path === "/cache/playwright/chromium",
    })).toBe("/cache/playwright/chromium");
  });

  it("returns undefined when a configured path is missing", () => {
    expect(selectChromiumExecutablePath({
      env: { INKOS_CHROMIUM_EXECUTABLE_PATH: "/missing/chrome" },
      exists: () => false,
    })).toBeUndefined();
  });
});
