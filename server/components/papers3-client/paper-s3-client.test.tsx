import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { fixtureInkRuntime } from "./fixture-runtime";
import {
  downloadPaperS3HomeDemoArchive,
  isPaperS3DisplaySettingsTarget,
  isPaperS3SettingsHotZone,
  paperS3ClientHref,
  paperS3RuntimeDisplay,
  PAPERS3_SETTINGS_HOT_ZONE_RATIO,
  PAPERS3_SETTINGS_LONG_PRESS_MS,
  PAPERS3_SETTINGS_MOVE_TOLERANCE_PX,
  PaperS3Client,
  prepareInkTargetUrl,
  requestNativeFullscreen,
  shouldLoadDefaultOnlineSource,
  shouldContinuePaperS3SettingsHold,
  shouldUseOnlineHomeDisplayVariant,
  sourceUrlForClientHref,
  validateSourceUrl,
} from "./paper-s3-client";

describe("PaperS3 immersive client controls", () => {
  it("defaults a parameter-free launch to the offline application-home Demo in portrait", () => {
    const html = renderToStaticMarkup(<PaperS3Client />);

    expect(html).toContain('data-default-offline-home="true"');
    expect(html).toContain('data-orientation-policy="manual"');
    expect(html).toContain('data-mode="offline"');
    expect(html).toContain("应用首页 Demo");
    expect(html).toContain('aria-label="选择屏幕方向"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("竖屏");
    expect(html).toContain("横屏");
  });

  it("uses an explicit five-second top-20-percent hold with a 12px movement tolerance", () => {
    const rect = { left: 100, top: 200, width: 540, height: 960 };

    expect(PAPERS3_SETTINGS_LONG_PRESS_MS).toBe(5_000);
    expect(PAPERS3_SETTINGS_HOT_ZONE_RATIO).toBe(0.2);
    expect(PAPERS3_SETTINGS_MOVE_TOLERANCE_PX).toBe(12);
    expect(isPaperS3SettingsHotZone({ x: 120, y: 392 }, rect)).toBe(true);
    expect(isPaperS3SettingsHotZone({ x: 120, y: 393 }, rect)).toBe(false);
    expect(shouldContinuePaperS3SettingsHold(
      { x: 120, y: 250 },
      { x: 132, y: 250 },
      rect,
    )).toBe(true);
    expect(shouldContinuePaperS3SettingsHold(
      { x: 120, y: 250 },
      { x: 133, y: 250 },
      rect,
    )).toBe(false);
    expect(shouldContinuePaperS3SettingsHold(
      { x: 120, y: 390 },
      { x: 120, y: 393 },
      rect,
    )).toBe(false);
  });

  it("uses online on-demand rendering only for non-base built-in home display variants", () => {
    const offlineHome = {
      source: {
        mode: "offline" as const,
        label: "离线包",
        detail: "应用首页",
        packageId: "7f12227f-be7f-5092-a73f-6dc57e85af61",
        verified: true,
      },
    };

    expect(shouldUseOnlineHomeDisplayVariant(
      offlineHome,
      { orientation: "landscape", fontLevel: 0 },
    )).toBe(false);
    expect(shouldUseOnlineHomeDisplayVariant(
      offlineHome,
      { orientation: "portrait", fontLevel: 1 },
    )).toBe(true);
    expect(shouldUseOnlineHomeDisplayVariant(
      { source: { ...offlineHome.source, packageId: "10000000-0000-4000-8000-000000000099" } },
      { orientation: "portrait", fontLevel: 1 },
    )).toBe(false);
  });

  it("does not use the offline fallback for an explicit content request", () => {
    const sourceUrl = "https://example.com/article";
    const html = renderToStaticMarkup(
      <PaperS3Client hasExplicitContentRequest initialSourceUrl={sourceUrl} />,
    );

    expect(html).toContain('data-default-offline-home="false"');
    expect(html).toContain('data-mode="online"');
  });

  it("renders only the screen surface without toolbars, controls or hints", () => {
    const html = renderToStaticMarkup(
      <PaperS3Client immersive runtime={fixtureInkRuntime} />,
    );

    expect(html).toContain('data-immersive="true"');
    expect(html).toContain("PaperS3 渲染页");
    expect(html).not.toContain("全屏模式操作");
    expect(html).not.toContain("全屏页面导航");
    expect(html).not.toContain("左滑返回 · 上下滑翻页 · 点按链接");
    expect(html).not.toContain("重新载入");
    expect(html).toContain("正在打开 PaperS3 内容，请稍等");
    expect(html).toContain("正在打开内容，请稍等");
    expect(html).not.toContain("正在校验并载入渲染帧");
    expect(html).toContain("请稍候");
    expect(html).toContain('data-loading-placement="bottom"');
  });

  it("keeps reverse polarity out of browser UI/state/requests and normalizes legacy state", () => {
    const html = renderToStaticMarkup(<PaperS3Client />);

    expect(html).not.toContain("反色显示");
    expect(paperS3RuntimeDisplay({
      orientation: "landscape",
      fontLevel: 2,
      invert: true,
    })).toEqual({ orientation: "landscape", fontLevel: 2, invert: false });
  });

  it("routes only the exact device settings action to the local settings dialog", () => {
    expect(isPaperS3DisplaySettingsTarget("inkos://device/settings")).toBe(true);
    expect(isPaperS3DisplaySettingsTarget("inkos://device/settings/")).toBe(false);
    expect(isPaperS3DisplaySettingsTarget("inkos://app/settings")).toBe(false);
    expect(isPaperS3DisplaySettingsTarget("https://example.com/settings")).toBe(false);
  });

  it("asks the browser to hide native navigation and absorbs denial", async () => {
    const requestFullscreen = vi.fn(() => Promise.reject(new Error("denied")));
    const element = { requestFullscreen } as unknown as HTMLElement;

    expect(() => requestNativeFullscreen(element)).not.toThrow();
    expect(requestFullscreen).toHaveBeenCalledWith({ navigationUI: "hide" });
    await Promise.resolve();
  });

  it("blocks only the initial online catalog load while a deep-linked source owns startup", () => {
    expect(shouldLoadDefaultOnlineSource("online", true)).toBe(false);
    expect(shouldLoadDefaultOnlineSource("online", false)).toBe(true);
    expect(shouldLoadDefaultOnlineSource("offline", true)).toBe(true);
  });

  it("validates HTTPS early and preserves plus, query and fragment characters in deep links", () => {
    const sourceUrl = "https://example.com/a+b?q=x+y#section";
    expect(validateSourceUrl(sourceUrl)).toBeUndefined();
    expect(validateSourceUrl("http://example.com")).toMatch(/HTTPS/u);
    expect(paperS3ClientHref(true, sourceUrl)).toBe(
      "/papers3-client?fullscreen=1&url=https%3A%2F%2Fexample.com%2Fa%2Bb%3Fq%3Dx%2By%23section",
    );
    expect(paperS3ClientHref(true, sourceUrl, {
      packageId: "10000000-0000-4000-8000-000000000099",
      documentUuid: "10000000-0000-4000-8000-000000000002",
      pageIndex: 3,
    })).toBe(
      "/papers3-client?fullscreen=1&url=https%3A%2F%2Fexample.com%2Fa%2Bb%3Fq%3Dx%2By%23section&package=10000000-0000-4000-8000-000000000099&uuid=10000000-0000-4000-8000-000000000002&page=3",
    );
  });

  it("keeps package-only home links independent from a typed or previously visited website URL", () => {
    const homePackageId = "7f12227f-be7f-5092-a73f-6dc57e85af61";
    const homeUuid = "f67a9105-45db-5a99-af84-f07d1ba1ebce";
    const staleWebsiteUrl = "https://jandan.net/";
    const packageView = {
      source: {
        mode: "online" as const,
        label: "在线首页",
        detail: "InkOS 首页 .ink 包",
        packageId: homePackageId,
        verified: true,
      },
    };

    expect(sourceUrlForClientHref(packageView, staleWebsiteUrl)).toBeUndefined();
    expect(paperS3ClientHref(true, sourceUrlForClientHref(packageView, staleWebsiteUrl), {
      packageId: homePackageId,
      documentUuid: homeUuid,
      pageIndex: 0,
    })).toBe(
      `/papers3-client?fullscreen=1&package=${homePackageId}&uuid=${homeUuid}&page=0`,
    );
    expect(sourceUrlForClientHref(null, staleWebsiteUrl)).toBe(staleWebsiteUrl);
  });

  it("downloads the built-in home archive from its package endpoint", async () => {
    const archiveBytes = new Uint8Array([80, 75, 3, 4]);
    const fetcher = vi.fn(async () => new Response(archiveBytes, { status: 200 }));

    const archive = await downloadPaperS3HomeDemoArchive(undefined, fetcher);

    expect(fetcher).toHaveBeenCalledWith(
      "/api/ink/v1/packages/7f12227f-be7f-5092-a73f-6dc57e85af61/download",
      expect.objectContaining({ cache: "no-cache" }),
    );
    expect(new Uint8Array(archive.bytes)).toEqual(archiveBytes);
    expect(archive.filename).toBe("inkos-papers3-home-demo.ink");
  });

  it("surfaces home Demo download failures and rejects empty archives", async () => {
    await expect(downloadPaperS3HomeDemoArchive(
      undefined,
      async () => new Response(null, { status: 503 }),
    )).rejects.toThrow(/HTTP 503/u);
    await expect(downloadPaperS3HomeDemoArchive(
      undefined,
      async () => new Response(new Uint8Array(), { status: 200 }),
    )).rejects.toThrow(/为空/u);
  });

  it("opens an HTTPS target from an offline archive and records a return visit", async () => {
    const offlineRoot = fixtureInkRuntime.getRootUuid("offline")!;
    const current = await fixtureInkRuntime.open({
      uuid: offlineRoot,
      pageIndex: 0,
      sourceMode: "offline",
      display: { orientation: "portrait", fontLevel: 0, invert: false },
    });
    const prepare = vi.fn(async () => true);

    const navigation = await prepareInkTargetUrl(
      "https://example.com/article",
      current,
      prepare,
    );

    expect(prepare).toHaveBeenCalledWith("https://example.com/article");
    expect(navigation).toEqual({
      opened: true,
      previous: {
        sourceMode: "offline",
        documentUuid: offlineRoot,
        pageIndex: 0,
      },
    });
  });

  it("does not record a return visit when linked online generation fails", async () => {
    const current = await fixtureInkRuntime.open({
      uuid: fixtureInkRuntime.getRootUuid("offline")!,
      pageIndex: 0,
      sourceMode: "offline",
      display: { orientation: "portrait", fontLevel: 0, invert: false },
    });

    await expect(prepareInkTargetUrl(
      "https://example.com/failure",
      current,
      async () => false,
    )).resolves.toEqual({ opened: false });
  });
});
