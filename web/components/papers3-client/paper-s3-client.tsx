"use client";

import Image from "next/image";
import Link from "next/link";
import {
  type CSSProperties,
  type ChangeEvent,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  PAPERS3_HOME_DEMO_FILENAME,
  PAPERS3_HOME_DOWNLOAD_URL,
  PAPERS3_HOME_PACKAGE_ID,
} from "@/lib/ink/builtin/papers3-home-identity";
import {
  isInkClientDeviceUrl,
  isInkClientAppUrl,
  type InkClientAppUrl,
} from "@/lib/ink/app-actions";

import { BrowserInkRuntimeAdapter } from "./browser-runtime";
import {
  clockTextPlacement,
  fetchServerTimeOffset,
  formatClockTime,
  startAlignedClock,
} from "./clock-runtime";
import {
  hitboxAt,
  intentFromKeyboard,
  intentFromReleasedPaperS3Swipe,
  PAPERS3_SWIPE_DOMINANCE_RATIO,
  PAPERS3_SWIPE_MIN_DISTANCE_PX,
  PAPERS3_SWIPE_SHORT_EDGE_RATIO,
  requestsPreviousLayer,
  resolveNavigation,
  type NavigationIntent,
} from "./navigation";
import {
  paperS3FrameSize,
  type InkArchiveInstallResult,
  type InkClientRuntimeAdapter,
  type InkDisplayPreferences,
  type InkFontLevel,
  type InkOnlineSourceProgress,
  type InkOnlineSourceResult,
  type InkLinkHitbox,
  type InkRuntimeView,
  type InkScreenOrientation,
  type InkSourceMode,
} from "./runtime-adapter";
import { observeScreenOrientation } from "./screen-orientation";
import styles from "./paper-s3-client.module.css";

type IconName =
  | "archive"
  | "arrow-left"
  | "chevron-down"
  | "chevron-up"
  | "cloud"
  | "close"
  | "link"
  | "landscape"
  | "maximize"
  | "minimize"
  | "minus"
  | "portrait"
  | "plus"
  | "refresh"
  | "type";

interface LineIconProps {
  readonly name: IconName;
  readonly size?: number;
}

function LineIcon({ name, size = 20 }: LineIconProps) {
  const paths: Record<IconName, React.ReactNode> = {
    archive: <><path d="M4 7.5h16v12H4z"/><path d="M3 4.5h18v3H3zM9 11h6"/></>,
    "arrow-left": <><path d="m10 6-6 6 6 6"/><path d="M4 12h16"/></>,
    "chevron-down": <path d="m7 9 5 5 5-5"/>,
    "chevron-up": <path d="m7 15 5-5 5 5"/>,
    cloud: <path d="M7.5 18H18a4 4 0 0 0 .8-7.9A7 7 0 0 0 5.3 8.2 5 5 0 0 0 7.5 18Z"/>,
    close: <><path d="m6 6 12 12"/><path d="M18 6 6 18"/></>,
    landscape: <><rect x="3" y="6" width="18" height="12" rx="1"/><path d="M8 16h8"/></>,
    link: <><path d="M14 5h5v5"/><path d="m11 13 8-8"/><path d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></>,
    maximize: <><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></>,
    minimize: <><path d="M8 8H3V3M16 8h5V3M8 16H3v5M16 16h5v5"/></>,
    minus: <path d="M5 12h14"/>,
    portrait: <><rect x="6" y="3" width="12" height="18" rx="1"/><path d="M10 18h4"/></>,
    plus: <><path d="M5 12h14"/><path d="M12 5v14"/></>,
    refresh: <><path d="M20 6v5h-5"/><path d="M18.2 15.5A7 7 0 1 1 19 9l1 2"/></>,
    type: <><path d="M5 5h14M9 19h6M12 5v14"/></>,
  };

  return (
    <svg
      aria-hidden="true"
      className={styles.icon}
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
    >
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8">
        {paths[name]}
      </g>
    </svg>
  );
}

const FONT_LEVELS: readonly InkFontLevel[] = [-2, -1, 0, 1, 2];

const fontLevelLabels: Record<InkFontLevel, string> = {
  [-2]: "小两号",
  [-1]: "小一号",
  0: "标准",
  1: "大一号",
  2: "大两号",
};

const noNavigationMessages = {
  root: "已经位于内容根目录。",
  "first-page": "已经是第一页，且当前内容没有上一层。",
  "last-page": "已经是最后一页，且当前内容没有上一层。",
} as const;

export const PAPERS3_SETTINGS_LONG_PRESS_MS = 5_000;
export const PAPERS3_SETTINGS_HOT_ZONE_RATIO = 0.2;
export const PAPERS3_SETTINGS_MOVE_TOLERANCE_PX = 12;

export type PaperS3OrientationPolicy = "auto" | "manual";

export interface PaperS3PointerPoint {
  readonly x: number;
  readonly y: number;
}

export interface PaperS3ScreenRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface PaperS3DisplaySettingsDraft {
  readonly orientationPolicy: PaperS3OrientationPolicy;
  readonly display: PaperS3DisplayPreferences;
}

export type PaperS3DisplayPreferences = Pick<
  InkDisplayPreferences,
  "orientation" | "fontLevel"
>;

/** Legacy browser state may still contain `invert: true`; it is never retained or requested. */
export function paperS3RuntimeDisplay(
  display: PaperS3DisplayPreferences | InkDisplayPreferences,
): InkDisplayPreferences {
  return {
    orientation: display.orientation,
    fontLevel: display.fontLevel,
    invert: false,
  };
}

export function isPaperS3DisplaySettingsTarget(targetUrl?: string): boolean {
  return typeof targetUrl === "string" && isInkClientDeviceUrl(targetUrl);
}

export function isPaperS3SettingsHotZone(
  point: PaperS3PointerPoint,
  rect: PaperS3ScreenRect,
): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false;
  return point.x >= rect.left
    && point.x <= rect.left + rect.width
    && point.y >= rect.top
    && point.y <= rect.top + rect.height * PAPERS3_SETTINGS_HOT_ZONE_RATIO;
}

export function shouldContinuePaperS3SettingsHold(
  start: PaperS3PointerPoint,
  current: PaperS3PointerPoint,
  rect: PaperS3ScreenRect,
): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y)
      <= PAPERS3_SETTINGS_MOVE_TOLERANCE_PX
    && isPaperS3SettingsHotZone(current, rect);
}

export function shouldUseOnlineHomeDisplayVariant(
  current: Pick<InkRuntimeView, "source"> | null,
  display: PaperS3DisplayPreferences,
): boolean {
  return current?.source.mode === "offline"
    && current.source.packageId === PAPERS3_HOME_PACKAGE_ID
    && display.fontLevel !== 0;
}

interface PaperS3ClientProps {
  /** Dependency-injection seam used by conformance tests and alternate stores. */
  readonly runtime?: InkClientRuntimeAdapter;
  /** Removes the website chrome and fits the PaperS3 frame to the viewport. */
  readonly immersive?: boolean;
  /** Deep-linked HTTPS page to resolve before any default catalog request. */
  readonly initialSourceUrl?: string;
  /** Exact catalog/document/page deep link used by copyable simulator URLs. */
  readonly initialPackageId?: string;
  readonly initialDocumentUuid?: string;
  readonly initialPageIndex?: number;
  /** Distinguishes an explicit `page=0` request from a parameter-free launch. */
  readonly hasExplicitContentRequest?: boolean;
}

interface ActivePointer {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly startedAt: number;
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    && Boolean(target.closest("button, a, input, select, textarea, [role='switch']"));
}

type InstallState =
  | { readonly status: "empty" }
  | { readonly status: "downloading"; readonly filename: string }
  | { readonly status: "verifying"; readonly filename: string }
  | { readonly status: "installed"; readonly package: InkArchiveInstallResult }
  | { readonly status: "error"; readonly filename: string; readonly message: string };

interface LoadOptions {
  readonly focusScreen?: boolean;
  readonly sourceMode?: InkSourceMode;
  readonly display?: PaperS3DisplayPreferences;
  readonly commitDisplay?: boolean;
}

type OnlineSourceState =
  | { readonly status: "idle" }
  | { readonly status: "preparing"; readonly progress: InkOnlineSourceProgress }
  | { readonly status: "ready"; readonly result: InkOnlineSourceResult }
  | { readonly status: "error"; readonly message: string };

interface ClockOverlayEntry {
  readonly text: string;
  readonly visualResetEpoch: number;
}

interface ClockOverlayState {
  readonly viewKey: string;
  readonly entries: Readonly<Record<string, ClockOverlayEntry>>;
}

export interface OnlineVisit {
  readonly sourceMode: "online";
  readonly packageId: string;
  readonly sourceUrl?: string;
  readonly documentUuid: string;
  readonly pageIndex: number;
}

export interface OfflineVisit {
  readonly sourceMode: "offline";
  readonly documentUuid: string;
  readonly pageIndex: number;
}

export type SourceVisit = OnlineVisit | OfflineVisit;

export interface InkTargetNavigationResult {
  readonly opened: boolean;
  readonly previous?: SourceVisit;
}

export type PaperS3ArchiveFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface DownloadedInkArchive {
  readonly bytes: ArrayBuffer;
  readonly filename: string;
}

export async function downloadPaperS3HomeDemoArchive(
  signal?: AbortSignal,
  fetcher: PaperS3ArchiveFetcher = globalThis.fetch,
): Promise<DownloadedInkArchive> {
  const response = await fetcher(PAPERS3_HOME_DOWNLOAD_URL, {
    cache: "no-cache",
    headers: { Accept: "application/vnd.inkos.package+zip, application/zip" },
    signal,
  });
  if (!response.ok) {
    throw new Error(`应用首页 Demo 下载失败（HTTP ${response.status}）。`);
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength === 0) throw new Error("应用首页 Demo 下载结果为空。");
  return { bytes, filename: PAPERS3_HOME_DEMO_FILENAME };
}

export function sourceVisitForView(view: InkRuntimeView | null): SourceVisit | undefined {
  if (!view) return undefined;
  if (view.source.mode === "offline") {
    return {
      sourceMode: "offline",
      documentUuid: view.document.uuid,
      pageIndex: view.page.index,
    };
  }
  if (!view.source.packageId) return undefined;
  return {
    sourceMode: "online",
    packageId: view.source.packageId,
    ...(view.source.sourceUrl ? { sourceUrl: view.source.sourceUrl } : {}),
    documentUuid: view.document.uuid,
    pageIndex: view.page.index,
  };
}

export async function prepareInkTargetUrl(
  targetUrl: string,
  current: InkRuntimeView | null,
  prepare: (url: string) => Promise<boolean>,
): Promise<InkTargetNavigationResult> {
  const previous = sourceVisitForView(current);
  const opened = await prepare(targetUrl);
  return opened ? { opened: true, ...(previous ? { previous } : {}) } : { opened: false };
}

export function validateSourceUrl(value: string): string | undefined {
  if (!value) return "请输入需要生成的网页地址。";
  if (value !== value.trim()) return "请移除网址首尾的空格。";
  if (value.length > 2048) return "网址不能超过 2048 个字符。";
  try {
    if (new URL(value).protocol !== "https:") return "只支持完整的 HTTPS 网址。";
  } catch {
    return "请输入完整的 HTTPS 网址。";
  }
  return undefined;
}

export interface PaperS3DeepLink {
  readonly packageId?: string;
  readonly documentUuid?: string;
  readonly pageIndex?: number;
}

export function paperS3ClientHref(
  fullscreen: boolean,
  sourceUrl?: string,
  deepLink: PaperS3DeepLink = {},
): string {
  const parameters = new URLSearchParams();
  if (fullscreen) parameters.set("fullscreen", "1");
  if (sourceUrl) parameters.set("url", sourceUrl);
  if (deepLink.packageId) parameters.set("package", deepLink.packageId);
  if (deepLink.documentUuid) parameters.set("uuid", deepLink.documentUuid);
  if (deepLink.pageIndex !== undefined) parameters.set("page", String(deepLink.pageIndex));
  const query = parameters.toString();
  return `/papers3-client${query ? `?${query}` : ""}`;
}

/**
 * Once a verified package is visible its own source metadata is authoritative.
 * In particular, do not attach a merely typed (or previously visited) URL to a
 * package-only deep link: that would make reload resolve the wrong URL while
 * asserting the current package UUID.
 */
export function sourceUrlForClientHref(
  view: Pick<InkRuntimeView, "source"> | null,
  formSourceUrl?: string,
): string | undefined {
  return view ? view.source.sourceUrl : formSourceUrl;
}

export function shouldLoadDefaultOnlineSource(
  sourceMode: InkSourceMode,
  initialSourcePending: boolean,
): boolean {
  return sourceMode !== "online" || !initialSourcePending;
}

function isAbortError(caught: unknown): boolean {
  return caught instanceof DOMException && caught.name === "AbortError";
}

function decodeFrameImage(url: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = new window.Image();
    const cleanup = () => {
      probe.onload = null;
      probe.onerror = null;
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      probe.src = "";
      reject(signal.reason instanceof Error
        ? signal.reason
        : new DOMException("The request was aborted", "AbortError"));
    };
    probe.onload = () => {
      cleanup();
      resolve();
    };
    probe.onerror = () => {
      cleanup();
      reject(new Error("渲染帧不是浏览器可解码的 PNG 图片。"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else probe.src = url;
  });
}

interface WebkitFullscreenElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

/**
 * Fullscreen requests must happen inside a user-activation event. Keep this
 * helper deliberately silent: immersive mode still works when a browser (or
 * an insecure LAN origin) declines the native fullscreen request.
 */
export function requestNativeFullscreen(element: WebkitFullscreenElement): void {
  try {
    const result = element.requestFullscreen
      ? element.requestFullscreen({ navigationUI: "hide" })
      : element.webkitRequestFullscreen?.();
    void Promise.resolve(result).catch(() => undefined);
  } catch {
    // Fullscreen is a progressive enhancement; the rendered screen remains usable.
  }
}

export function PaperS3Client({
  runtime: suppliedRuntime,
  immersive = false,
  initialSourceUrl,
  initialPackageId,
  initialDocumentUuid,
  initialPageIndex = 0,
  hasExplicitContentRequest,
}: PaperS3ClientProps) {
  const [ownedRuntime] = useState(() => new BrowserInkRuntimeAdapter());
  const runtime = suppliedRuntime ?? ownedRuntime;
  const explicitContentRequest = hasExplicitContentRequest
    ?? Boolean(initialSourceUrl || initialPackageId || initialDocumentUuid || initialPageIndex !== 0);
  const useDefaultOfflineHome = !explicitContentRequest;
  const invalidStandaloneDeepLink = explicitContentRequest && !initialSourceUrl && !initialPackageId;
  const invalidStandaloneDeepLinkMessage = "内容直达参数缺少 url 或 package，无法确定要打开的内容包。";
  const [sourceMode, setSourceMode] = useState<InkSourceMode>(
    useDefaultOfflineHome ? "offline" : "online",
  );
  const [display, setDisplay] = useState<PaperS3DisplayPreferences>({
    orientation: "portrait",
    fontLevel: 0,
  });
  const [orientationPolicy, setOrientationPolicy] = useState<PaperS3OrientationPolicy>("manual");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<PaperS3DisplaySettingsDraft>({
    orientationPolicy: "manual",
    display: { orientation: "portrait", fontLevel: 0 },
  });
  const [view, setView] = useState<InkRuntimeView | null>(null);
  const [loading, setLoading] = useState(!invalidStandaloneDeepLink);
  const [error, setError] = useState<string | null>(
    invalidStandaloneDeepLink ? invalidStandaloneDeepLinkMessage : null,
  );
  const [announcement, setAnnouncement] = useState(
    invalidStandaloneDeepLink
      ? `内容直达失败：${invalidStandaloneDeepLinkMessage}`
      : "正在打开 PaperS3 内容，请稍等。",
  );
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [installState, setInstallState] = useState<InstallState>({ status: "empty" });
  const [packageEpoch, setPackageEpoch] = useState(0);
  const [sourceUrl, setSourceUrl] = useState(initialSourceUrl ?? "");
  const [sourceUrlError, setSourceUrlError] = useState<string>();
  const [onlineSourceState, setOnlineSourceState] = useState<OnlineSourceState>({ status: "idle" });
  const [sourceHistoryDepth, setSourceHistoryDepth] = useState(0);
  const [loadingElapsedSeconds, setLoadingElapsedSeconds] = useState(0);
  const [clockOverlay, setClockOverlay] = useState<ClockOverlayState>({
    viewKey: "",
    entries: {},
  });

  const viewRef = useRef<InkRuntimeView | null>(null);
  const sourceModeRef = useRef<InkSourceMode>(sourceMode);
  const displayRef = useRef<PaperS3DisplayPreferences>(display);
  const orientationPolicyRef = useRef<PaperS3OrientationPolicy>(orientationPolicy);
  const requestSequence = useRef(0);
  const requestAbort = useRef<AbortController | null>(null);
  const archiveInstallAbort = useRef<AbortController | null>(null);
  const sourcePreparationSequence = useRef<number | null>(null);
  const activePointer = useRef<ActivePointer | null>(null);
  const navigationInFlight = useRef(false);
  const lastPageByUuid = useRef(new Map<string, number>());
  const sourceHistory = useRef<SourceVisit[]>([]);
  const screenRef = useRef<HTMLDivElement | null>(null);
  const sourceUrlInputRef = useRef<HTMLInputElement | null>(null);
  const initialSourceStarted = useRef(false);
  const initialSourcePending = useRef(Boolean(initialSourceUrl || initialPackageId));
  const defaultOfflineHomePending = useRef(useDefaultOfflineHome);
  const defaultOfflineHomeStarted = useRef(false);
  const nativeFullscreenAttempted = useRef(false);
  const settingsHoldTimer = useRef<number | null>(null);
  const settingsCloseButtonRef = useRef<HTMLButtonElement | null>(null);

  const cancelSettingsHold = useCallback(() => {
    if (settingsHoldTimer.current === null) return;
    window.clearTimeout(settingsHoldTimer.current);
    settingsHoldTimer.current = null;
  }, []);

  const openDisplaySettings = useCallback(() => {
    cancelSettingsHold();
    activePointer.current = null;
    setDragOffset({ x: 0, y: 0 });
    setSettingsDraft({
      orientationPolicy: orientationPolicyRef.current,
      display: {
        orientation: displayRef.current.orientation,
        fontLevel: displayRef.current.fontLevel,
      },
    });
    setSettingsOpen(true);
  }, [cancelSettingsHold]);

  const closeDisplaySettings = useCallback(() => {
    setSettingsOpen(false);
    window.requestAnimationFrame(() => screenRef.current?.focus({ preventScroll: true }));
  }, []);

  useEffect(() => {
    if (!settingsOpen) return;
    const focusFrame = window.requestAnimationFrame(() => {
      settingsCloseButtonRef.current?.focus({ preventScroll: true });
    });
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeDisplaySettings();
    };
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [closeDisplaySettings, settingsOpen]);

  const resetNavigation = useCallback((): void => {
    requestAbort.current?.abort();
    requestSequence.current += 1;
    viewRef.current = null;
    setView(null);
    setError(null);
    lastPageByUuid.current.clear();
  }, []);

  const loadView = useCallback(async (
    uuid: string | undefined,
    pageIndex: number,
    options: LoadOptions = {},
  ): Promise<boolean> => {
    const sequence = ++requestSequence.current;
    requestAbort.current?.abort();
    const controller = new AbortController();
    requestAbort.current = controller;
    const requestedSource = options.sourceMode ?? sourceModeRef.current;
    const requestedDisplay = options.display ?? displayRef.current;
    setLoading(true);
    setError(null);

    try {
      const resolvedUuid = uuid
        ?? runtime.getRootUuid(requestedSource)
        ?? await runtime.resolveRootUuid?.(requestedSource, controller.signal);
      if (!resolvedUuid) throw new Error(`${requestedSource === "offline" ? "离线包" : "在线目录"}没有可打开的根 UUID。`);
      const nextView = await runtime.open({
        uuid: resolvedUuid,
        pageIndex,
        sourceMode: requestedSource,
        display: paperS3RuntimeDisplay(requestedDisplay),
      }, controller.signal);
      await decodeFrameImage(nextView.page.imageUrl, controller.signal);

      if (sequence !== requestSequence.current) return false;

      if (options.commitDisplay) {
        displayRef.current = requestedDisplay;
        setDisplay(requestedDisplay);
      }
      viewRef.current = nextView;
      lastPageByUuid.current.set(nextView.document.uuid, nextView.page.index);
      setView(nextView);
      if (nextView.source.mode === "online" && nextView.source.packageId) {
        const href = paperS3ClientHref(immersive, nextView.source.sourceUrl, {
          packageId: nextView.source.packageId,
          documentUuid: nextView.document.uuid,
          pageIndex: nextView.page.index,
        });
        window.history.replaceState(
          {
            inkos: true,
            packageId: nextView.source.packageId,
            uuid: nextView.document.uuid,
            page: nextView.page.index,
          },
          "",
          href,
        );
      }
      setAnnouncement(
        `${nextView.document.title}，第 ${nextView.page.index + 1} 页，共 ${nextView.page.count} 页，${nextView.source.label}。`,
      );

      if (options.focusScreen) {
        window.requestAnimationFrame(() => screenRef.current?.focus({ preventScroll: true }));
      }
      return true;
    } catch (caught) {
      if (sequence !== requestSequence.current) return false;
      if (isAbortError(caught)) return false;
      const message = caught instanceof Error ? caught.message : "无法打开这份内容。";
      setError(message);
      setAnnouncement(`加载失败：${message}`);
      return false;
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [immersive, runtime]);

  const applySensorOrientation = useCallback((orientation: InkScreenOrientation) => {
    if (orientationPolicyRef.current !== "auto") return;
    const currentDisplay = displayRef.current;
    if (currentDisplay.orientation === orientation) return;
    const nextDisplay = { ...currentDisplay, orientation };
    const currentView = viewRef.current;
    // Ignore sensor noise during startup/source preparation. The observer
    // establishes its initial baseline without emitting, so portrait remains
    // the deterministic first-frame preference on landscape phones.
    if (!currentView || sourcePreparationSequence.current !== null) return;
    void loadView(currentView.document.uuid, currentView.page.index, {
      display: nextDisplay,
      commitDisplay: true,
    });
  }, [loadView]);

  useEffect(() => observeScreenOrientation(
    window,
    applySensorOrientation,
    { publishInitial: false },
  ), [applySensorOrientation]);

  const prepareOnlineUrl = useCallback(async (
    value: string,
    focusScreen = false,
    deepLink: PaperS3DeepLink = {},
  ): Promise<boolean> => {
    const validationMessage = validateSourceUrl(value);
    if (validationMessage) {
      setSourceUrlError(validationMessage);
      setOnlineSourceState({ status: "error", message: validationMessage });
      setError((current) => viewRef.current ? current : validationMessage);
      setAnnouncement(`网页地址无效：${validationMessage}`);
      if (!immersive) window.requestAnimationFrame(() => sourceUrlInputRef.current?.focus());
      return false;
    }
    if (!runtime.prepareOnlineSource) {
      const message = "当前运行时不支持从网页地址准备在线内容。";
      setSourceUrlError(message);
      setOnlineSourceState({ status: "error", message });
      setError((current) => viewRef.current ? current : message);
      return false;
    }

    const sequence = ++requestSequence.current;
    sourcePreparationSequence.current = sequence;
    requestAbort.current?.abort();
    const controller = new AbortController();
    requestAbort.current = controller;
    setSourceUrlError(undefined);
    setOnlineSourceState({
      status: "preparing",
      progress: { phase: "resolving", message: "正在打开网页内容，请稍等…" },
    });
    setLoading(true);
    setError(null);
    setAnnouncement("正在打开网页内容，请稍等。");

    try {
      const result = await runtime.prepareOnlineSource(value, {
        signal: controller.signal,
        display: paperS3RuntimeDisplay(displayRef.current),
        expectedPackageId: deepLink.packageId,
        targetUuid: deepLink.documentUuid,
        pageIndex: deepLink.pageIndex,
        onProgress: (progress) => {
          if (sequence !== requestSequence.current || controller.signal.aborted) return;
          setOnlineSourceState({ status: "preparing", progress });
          setAnnouncement(progress.message);
        },
      });
      if (sequence !== requestSequence.current) return false;
      setSourceUrl(result.normalizedUrl);
      setOnlineSourceState({ status: "ready", result });
      initialSourcePending.current = false;
      lastPageByUuid.current.clear();
      sourceModeRef.current = "online";
      setSourceMode("online");
      const opened = await loadView(deepLink.documentUuid ?? result.entryUuid, deepLink.pageIndex ?? 0, {
        sourceMode: "online",
        focusScreen,
      });
      const openedView = viewRef.current;
      const openedOrientation = openedView && openedView.page.pixelSize.width > openedView.page.pixelSize.height
        ? "landscape"
        : "portrait";
      if (opened && openedView && openedOrientation !== displayRef.current.orientation) {
        return loadView(openedView.document.uuid, openedView.page.index, {
          sourceMode: "online",
          display: displayRef.current,
          commitDisplay: true,
          focusScreen,
        });
      }
      return opened;
    } catch (caught) {
      if (sequence !== requestSequence.current || isAbortError(caught)) return false;
      const message = caught instanceof Error ? caught.message : "无法把这个网页准备成 PaperS3 内容。";
      setSourceUrlError(message);
      setOnlineSourceState({ status: "error", message });
      if (!viewRef.current) setError(message);
      setAnnouncement(`网页内容准备失败：${message}`);
      return false;
    } finally {
      if (sourcePreparationSequence.current === sequence) sourcePreparationSequence.current = null;
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [immersive, loadView, runtime]);

  const prepareAppAction = useCallback(async (
    action: InkClientAppUrl,
    focusScreen = false,
  ): Promise<boolean> => {
    if (!runtime.prepareAppAction) {
      const message = "当前运行时不支持实时应用动作。";
      setError(message);
      setAnnouncement(`应用打开失败：${message}`);
      return false;
    }
    const sequence = ++requestSequence.current;
    sourcePreparationSequence.current = sequence;
    requestAbort.current?.abort();
    const controller = new AbortController();
    requestAbort.current = controller;
    setLoading(true);
    setError(null);
    setAnnouncement(action === "inkos://app/random-image"
      ? "正在打开图片查看器，请稍等。"
      : "正在打开百度地图，请稍等。");
    try {
      const result = await runtime.prepareAppAction(action, {
        signal: controller.signal,
        display: paperS3RuntimeDisplay(displayRef.current),
      });
      if (sequence !== requestSequence.current) return false;
      sourceModeRef.current = "online";
      setSourceMode("online");
      setSourceUrl("");
      setSourceUrlError(undefined);
      setOnlineSourceState({ status: "idle" });
      lastPageByUuid.current.clear();
      return loadView(result.documentUuid, 0, {
        sourceMode: "online",
        focusScreen,
      });
    } catch (caught) {
      if (sequence !== requestSequence.current || isAbortError(caught)) return false;
      const message = caught instanceof Error ? caught.message : "实时应用执行失败。";
      if (!viewRef.current) setError(message);
      setAnnouncement(`应用打开失败：${message}`);
      return false;
    } finally {
      if (sourcePreparationSequence.current === sequence) sourcePreparationSequence.current = null;
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [loadView, runtime]);

  const prepareOnlinePackage = useCallback(async (
    packageId: string,
    documentUuid?: string,
    pageIndex = 0,
    focusScreen = false,
    displayOverride?: PaperS3DisplayPreferences,
  ): Promise<boolean> => {
    if (!runtime.prepareOnlinePackage) {
      const message = "当前运行时不支持 package UUID 直达。";
      setError(message);
      setAnnouncement(`分享链接打开失败：${message}`);
      return false;
    }
    const sequence = ++requestSequence.current;
    sourcePreparationSequence.current = sequence;
    requestAbort.current?.abort();
    const controller = new AbortController();
    requestAbort.current = controller;
    const requestedDisplay = displayOverride ?? displayRef.current;
    setLoading(true);
    setError(null);
    setAnnouncement(displayOverride
      ? "正在打开应用首页，请稍等。"
      : "正在打开分享内容，请稍等。");
    try {
      const result = await runtime.prepareOnlinePackage(packageId, {
        signal: controller.signal,
        display: paperS3RuntimeDisplay(requestedDisplay),
        targetUuid: documentUuid,
        pageIndex,
      });
      if (sequence !== requestSequence.current) return false;
      const opened = await loadView(documentUuid ?? result.entryUuid, pageIndex, {
        sourceMode: "online",
        display: requestedDisplay,
        commitDisplay: displayOverride !== undefined,
        focusScreen,
      });
      if (!opened) return false;
      initialSourcePending.current = false;
      lastPageByUuid.current.clear();
      sourceModeRef.current = "online";
      setSourceMode("online");
      setSourceUrl("");
      setSourceUrlError(undefined);
      setOnlineSourceState({ status: "idle" });
      return true;
    } catch (caught) {
      if (sequence !== requestSequence.current || isAbortError(caught)) return false;
      const message = caught instanceof Error ? caught.message : "无法打开分享链接指定的内容包。";
      if (!viewRef.current || displayOverride) setError(message);
      setAnnouncement(displayOverride
        ? `应用首页显示帧生成失败：${message}`
        : `分享链接打开失败：${message}`);
      return false;
    } finally {
      if (sourcePreparationSequence.current === sequence) sourcePreparationSequence.current = null;
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [loadView, runtime]);

  const installOfflineArchive = useCallback(async (
    archive: File | ArrayBuffer | Uint8Array,
    filename: string,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    if (!runtime.installArchive) {
      const message = "当前运行时不支持安装 .ink 包。";
      setInstallState({ status: "error", filename, message });
      setAnnouncement(`离线包安装失败：${message}`);
      if (!viewRef.current) setError(message);
      return false;
    }

    setInstallState({ status: "verifying", filename });
    setAnnouncement(`正在打开离线内容 ${filename}，请稍等。`);
    try {
      const installed = await runtime.installArchive(
        archive,
        filename,
        signal,
        paperS3RuntimeDisplay(displayRef.current),
      );
      setInstallState({ status: "installed", package: installed });
      resetNavigation();
      sourceModeRef.current = "offline";
      setSourceMode("offline");
      setPackageEpoch((value) => value + 1);
      setAnnouncement(`${installed.title} 已校验并安装，共 ${installed.documentCount} 份内容。`);
      return true;
    } catch (caught) {
      if (isAbortError(caught)) return false;
      const message = caught instanceof Error ? caught.message : "无法校验这个 .ink 文件。";
      setInstallState({ status: "error", filename, message });
      setAnnouncement(`离线包安装失败：${message}`);
      if (!viewRef.current) setError(message);
      return false;
    }
  }, [resetNavigation, runtime]);

  const installHomeDemo = useCallback(async (fallback = false): Promise<boolean> => {
    archiveInstallAbort.current?.abort();
    const controller = new AbortController();
    archiveInstallAbort.current = controller;
    setInstallState({ status: "downloading", filename: PAPERS3_HOME_DEMO_FILENAME });
    setAnnouncement("正在打开应用首页 Demo，请稍等。");
    if (fallback) {
      setLoading(true);
      setError(null);
    }

    let installed = false;
    try {
      const archive = await downloadPaperS3HomeDemoArchive(controller.signal);
      installed = await installOfflineArchive(
        archive.bytes,
        archive.filename,
        controller.signal,
      );
      if (fallback) defaultOfflineHomePending.current = false;
      return installed;
    } catch (caught) {
      if (isAbortError(caught)) return false;
      const message = caught instanceof Error ? caught.message : "无法下载应用首页 Demo。";
      setInstallState({ status: "error", filename: PAPERS3_HOME_DEMO_FILENAME, message });
      setAnnouncement(`应用首页 Demo 加载失败：${message}`);
      if (!viewRef.current) setError(message);
      if (fallback) defaultOfflineHomePending.current = false;
      return false;
    } finally {
      if (archiveInstallAbort.current === controller) archiveInstallAbort.current = null;
      // A successful install increments packageEpoch; keep the loading plate in
      // place until that effect has decoded and committed the entry frame.
      if (fallback && !installed) setLoading(false);
    }
  }, [installOfflineArchive]);

  useEffect(() => {
    if (invalidStandaloneDeepLink && sourceMode === "online") return;
    if (defaultOfflineHomePending.current) return;
    if (!shouldLoadDefaultOnlineSource(sourceMode, initialSourcePending.current)) return;
    void loadView(undefined, 0, { sourceMode });
    return () => requestAbort.current?.abort();
  }, [initialPackageId, initialSourceUrl, invalidStandaloneDeepLink, loadView, packageEpoch, sourceMode]);

  useEffect(() => {
    if (!useDefaultOfflineHome || defaultOfflineHomeStarted.current) return;
    defaultOfflineHomeStarted.current = true;
    void installHomeDemo(true);
    return () => {
      archiveInstallAbort.current?.abort();
      defaultOfflineHomeStarted.current = false;
    };
  }, [installHomeDemo, useDefaultOfflineHome]);

  useEffect(() => {
    if ((!initialSourceUrl && !initialPackageId) || initialSourceStarted.current) return;
    initialSourceStarted.current = true;
    if (initialSourceUrl) {
      void prepareOnlineUrl(initialSourceUrl, false, {
        packageId: initialPackageId,
        documentUuid: initialDocumentUuid,
        pageIndex: initialPageIndex,
      });
    } else if (initialPackageId) {
      void prepareOnlinePackage(
        initialPackageId,
        initialDocumentUuid,
        initialPageIndex,
      );
    }
    return () => {
      requestAbort.current?.abort();
      initialSourceStarted.current = false;
    };
  }, [
    initialDocumentUuid,
    initialPackageId,
    initialPageIndex,
    initialSourceUrl,
    prepareOnlinePackage,
    prepareOnlineUrl,
  ]);

  useEffect(() => () => {
    archiveInstallAbort.current?.abort();
    cancelSettingsHold();
    if (!suppliedRuntime) runtime.dispose?.();
  }, [cancelSettingsHold, runtime, suppliedRuntime]);

  const attemptNativeFullscreen = useCallback(() => {
    if (!immersive || nativeFullscreenAttempted.current) return;
    nativeFullscreenAttempted.current = true;
    requestNativeFullscreen(document.documentElement as WebkitFullscreenElement);
  }, [immersive]);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    void navigator.serviceWorker.register("/papers3-sw.js", {
      scope: "/papers3-client",
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    const sourcePreparing = onlineSourceState.status === "preparing";
    if (!loading && !sourcePreparing) {
      setLoadingElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setLoadingElapsedSeconds(0);
    const timer = window.setInterval(() => {
      setLoadingElapsedSeconds(Math.floor((Date.now() - startedAt) / 1_000));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [loading, onlineSourceState.status]);

  useEffect(() => {
    const regions = view?.page.dynamicRegions ?? [];
    const viewKey = view
      ? `${view.source.packageId ?? view.source.packageFilename ?? view.source.label}:${view.document.uuid}:${view.page.index}:${view.page.imageUrl}`
      : "";
    setClockOverlay({ viewKey, entries: {} });
    if (!view || regions.length === 0) return;

    let active = true;
    let stopSchedulers: Array<() => void> = [];
    const controller = new AbortController();
    const stopAll = () => {
      stopSchedulers.forEach((stop) => stop());
      stopSchedulers = [];
    };
    const startAll = (serverOffsetMs: number) => {
      stopAll();
      stopSchedulers = regions.map((region) => startAlignedClock(
        region,
        serverOffsetMs,
        (tick) => {
          if (!active) return;
          const text = formatClockTime(tick.unixMs, region.timezone, region.format);
          setClockOverlay((current) => {
            const entries = current.viewKey === viewKey ? current.entries : {};
            const previous = entries[region.id];
            return {
              viewKey,
              entries: {
                ...entries,
                [region.id]: {
                  text,
                  visualResetEpoch: (previous?.visualResetEpoch ?? 0) + (tick.visualReset ? 1 : 0),
                },
              },
            };
          });
        },
      ));
    };

    // Paint from the browser clock immediately after the verified PNG; the
    // no-store server sample then corrects it without making the page depend
    // on time synchronization being available.
    startAll(0);
    void fetchServerTimeOffset(fetch, controller.signal).then((serverOffsetMs) => {
      if (active) startAll(serverOffsetMs);
    }).catch(() => {
      // Local wall time remains the explicit offline/error fallback.
    });

    return () => {
      active = false;
      controller.abort();
      stopAll();
    };
  }, [view]);

  const restoreSourceVisit = useCallback(async (): Promise<boolean> => {
    const visit = sourceHistory.current.at(-1);
    if (!visit) return false;
    const opened = visit.sourceMode === "offline"
      ? await loadView(visit.documentUuid, visit.pageIndex, {
          sourceMode: "offline",
          focusScreen: true,
        })
      : visit.sourceUrl
        ? await prepareOnlineUrl(visit.sourceUrl, true, {
            packageId: visit.packageId,
            documentUuid: visit.documentUuid,
            pageIndex: visit.pageIndex,
          })
        : await prepareOnlinePackage(
            visit.packageId,
            visit.documentUuid,
            visit.pageIndex,
            true,
          );
    if (!opened) return false;
    sourceHistory.current.pop();
    setSourceHistoryDepth(sourceHistory.current.length);
    if (visit.sourceMode === "offline") {
      sourceModeRef.current = "offline";
      setSourceMode("offline");
      window.history.replaceState({ inkos: true }, "", paperS3ClientHref(immersive));
      return true;
    }
    setSourceUrl(visit.sourceUrl ?? "");
    if (!visit.sourceUrl) {
      setSourceUrlError(undefined);
      setOnlineSourceState({ status: "idle" });
    }
    return true;
  }, [immersive, loadView, prepareOnlinePackage, prepareOnlineUrl]);

  const startNavigationOperation = useCallback((operation: () => Promise<unknown>): void => {
    if (navigationInFlight.current) return;
    navigationInFlight.current = true;
    try {
      void operation().finally(() => {
        navigationInFlight.current = false;
      });
    } catch (caught) {
      navigationInFlight.current = false;
      throw caught;
    }
  }, []);

  const executeIntent = useCallback((intent: NavigationIntent) => {
    const current = viewRef.current;
    if (!current || loading || navigationInFlight.current) return;

    const requestsParent = requestsPreviousLayer(intent, current);
    if (!current.document.parentUuid && requestsParent && sourceHistory.current.length > 0) {
      startNavigationOperation(restoreSourceVisit);
      return;
    }

    const command = resolveNavigation(intent, current);
    if (command.kind === "none") {
      setAnnouncement(noNavigationMessages[command.reason]);
      return;
    }

    if (command.kind === "open-page") {
      startNavigationOperation(() => loadView(
        current.document.uuid,
        command.pageIndex,
        { focusScreen: true },
      ));
      return;
    }

    const rememberedPage = lastPageByUuid.current.get(command.uuid) ?? 0;
    startNavigationOperation(() => loadView(command.uuid, rememberedPage, { focusScreen: true }));
  }, [loadView, loading, restoreSourceVisit, startNavigationOperation]);

  useEffect(() => {
    function handleKeyboard(event: KeyboardEvent) {
      if (settingsOpen) return;
      if (event.altKey || event.ctrlKey || event.metaKey || isInteractiveTarget(event.target)) return;
      const intent = intentFromKeyboard(event.key);
      if (!intent) return;
      event.preventDefault();
      executeIntent(intent);
    }

    window.addEventListener("keydown", handleKeyboard);
    return () => window.removeEventListener("keydown", handleKeyboard);
  }, [executeIntent, settingsOpen]);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (settingsOpen || loading || navigationInFlight.current || isInteractiveTarget(event.target)) return;
    if (activePointer.current) {
      cancelSettingsHold();
      activePointer.current = null;
      setDragOffset({ x: 0, y: 0 });
      return;
    }
    activePointer.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startedAt: event.timeStamp,
    };
    event.currentTarget.setPointerCapture(event.pointerId);

    const rect = event.currentTarget.getBoundingClientRect();
    if (!isPaperS3SettingsHotZone({ x: event.clientX, y: event.clientY }, rect)) return;
    cancelSettingsHold();
    settingsHoldTimer.current = window.setTimeout(() => {
      const pointer = activePointer.current;
      if (!pointer || pointer.id !== event.pointerId) return;
      settingsHoldTimer.current = null;
      openDisplaySettings();
    }, PAPERS3_SETTINGS_LONG_PRESS_MS);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const pointer = activePointer.current;
    if (!pointer || pointer.id !== event.pointerId) return;
    if (settingsHoldTimer.current !== null && !shouldContinuePaperS3SettingsHold(
      { x: pointer.x, y: pointer.y },
      { x: event.clientX, y: event.clientY },
      event.currentTarget.getBoundingClientRect(),
    )) {
      cancelSettingsHold();
    }
    setDragOffset({
      x: Math.max(-20, Math.min(20, (event.clientX - pointer.x) * 0.12)),
      y: Math.max(-20, Math.min(20, (event.clientY - pointer.y) * 0.12)),
    });
  }

  function finishPointer(event: ReactPointerEvent<HTMLDivElement>, cancelled = false) {
    const pointer = activePointer.current;
    if (!pointer || pointer.id !== event.pointerId) return;
    cancelSettingsHold();
    activePointer.current = null;
    setDragOffset({ x: 0, y: 0 });

    if (!cancelled) {
      const rect = event.currentTarget.getBoundingClientRect();
      const logicalSize = viewRef.current?.page.pixelSize
        ?? paperS3FrameSize(displayRef.current.orientation);
      const toLogicalPoint = (point: PaperS3PointerPoint) => ({
        x: (point.x - rect.left) / rect.width * logicalSize.width,
        y: (point.y - rect.top) / rect.height * logicalSize.height,
      });
      const intent = rect.width > 0 && rect.height > 0
        ? intentFromReleasedPaperS3Swipe(
            toLogicalPoint({ x: pointer.x, y: pointer.y }),
            toLogicalPoint({ x: event.clientX, y: event.clientY }),
            {
              durationMs: event.timeStamp - pointer.startedAt,
              shortEdge: Math.min(logicalSize.width, logicalSize.height),
            },
          )
        : null;
      if (intent) {
        executeIntent(intent);
      } else if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) <= 12) {
        const current = viewRef.current;
        const screen = screenRef.current;
        if (current && screen) {
          const rect = screen.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            const hitbox = hitboxAt({
              x: (event.clientX - rect.left) / rect.width * current.page.pixelSize.width,
              y: (event.clientY - rect.top) / rect.height * current.page.pixelSize.height,
            }, current.page.linkHitboxes);
            if (hitbox) void openLink(hitbox);
          }
        }
      }
    }
  }

  async function openLink(hitbox: InkLinkHitbox): Promise<void> {
    if (loading || navigationInFlight.current) return;
    if (isPaperS3DisplaySettingsTarget(hitbox.targetUrl)) {
      openDisplaySettings();
      return;
    }
    navigationInFlight.current = true;
    const current = viewRef.current;
    try {
      if (current) lastPageByUuid.current.set(current.document.uuid, current.page.index);
      if (!hitbox.targetUrl) {
        await loadView(hitbox.targetUuid, 0, { focusScreen: true });
        return;
      }
      const navigation = await prepareInkTargetUrl(
        hitbox.targetUrl,
        current,
        (url) => isInkClientAppUrl(url)
          ? prepareAppAction(url, true)
          : prepareOnlineUrl(url, true),
      );
      if (!navigation.opened || !navigation.previous) return;
      sourceHistory.current.push(navigation.previous);
      setSourceHistoryDepth(sourceHistory.current.length);
    } finally {
      navigationInFlight.current = false;
    }
  }

  function changeFont(delta: -1 | 1) {
    const currentDisplay = displayRef.current;
    const index = FONT_LEVELS.indexOf(currentDisplay.fontLevel);
    const nextLevel = FONT_LEVELS[Math.max(0, Math.min(FONT_LEVELS.length - 1, index + delta))];
    requestDisplay({ ...currentDisplay, fontLevel: nextLevel });
  }

  function changeDraftFont(delta: -1 | 1) {
    setSettingsDraft((current) => {
      const index = FONT_LEVELS.indexOf(current.display.fontLevel);
      const fontLevel = FONT_LEVELS[Math.max(0, Math.min(FONT_LEVELS.length - 1, index + delta))];
      return { ...current, display: { ...current.display, fontLevel } };
    });
  }

  function useAutomaticOrientation() {
    orientationPolicyRef.current = "auto";
    setOrientationPolicy("auto");
    setAnnouncement("屏幕方向已设为自动；将在下一次设备方向变化时切换帧。");
  }

  function requestManualOrientation(orientation: InkScreenOrientation) {
    orientationPolicyRef.current = "manual";
    setOrientationPolicy("manual");
    requestDisplay({ ...displayRef.current, orientation });
  }

  function applyDisplaySettingsDraft() {
    const nextDisplay = settingsDraft.orientationPolicy === "auto"
      ? { ...settingsDraft.display, orientation: displayRef.current.orientation }
      : settingsDraft.display;
    orientationPolicyRef.current = settingsDraft.orientationPolicy;
    setOrientationPolicy(settingsDraft.orientationPolicy);
    closeDisplaySettings();
    requestDisplay(nextDisplay);
  }

  function requestDisplay(nextDisplay: PaperS3DisplayPreferences) {
    const currentDisplay = displayRef.current;
    if (
      currentDisplay.orientation === nextDisplay.orientation
      && currentDisplay.fontLevel === nextDisplay.fontLevel
    ) return;
    const current = viewRef.current;
    if (!current) {
      displayRef.current = nextDisplay;
      setDisplay(nextDisplay);
      return;
    }
    if (
      shouldUseOnlineHomeDisplayVariant(current, nextDisplay)
      && runtime.prepareOnlinePackage
    ) {
      void prepareOnlinePackage(
        PAPERS3_HOME_PACKAGE_ID,
        current.document.uuid,
        current.page.index,
        true,
        nextDisplay,
      );
      return;
    }
    void loadView(current.document.uuid, current.page.index, {
      display: nextDisplay,
      commitDisplay: true,
    });
  }

  function selectSource(nextMode: InkSourceMode): void {
    if (nextMode === sourceModeRef.current) return;
    archiveInstallAbort.current?.abort();
    defaultOfflineHomePending.current = false;
    resetNavigation();
    sourceHistory.current = [];
    setSourceHistoryDepth(0);
    sourceModeRef.current = nextMode;
    setSourceMode(nextMode);
    if (nextMode === "online" && initialSourcePending.current && initialSourceUrl) {
      void prepareOnlineUrl(initialSourceUrl, true);
    }
  }

  function submitOnlineSource(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    sourceHistory.current = [];
    setSourceHistoryDepth(0);
    void prepareOnlineUrl(sourceUrl, true);
  }

  async function installInkFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    archiveInstallAbort.current?.abort();
    const controller = new AbortController();
    archiveInstallAbort.current = controller;
    await installOfflineArchive(file, file.name, controller.signal);
    if (archiveInstallAbort.current === controller) archiveInstallAbort.current = null;
  }

  function retryContent(): void {
    if (sourceModeRef.current === "offline" && installState.status !== "installed") {
      void installHomeDemo(true);
      return;
    }
    if (invalidStandaloneDeepLink) {
      setAnnouncement(`内容直达失败：${invalidStandaloneDeepLinkMessage}`);
      return;
    }
    if (onlineSourceState.status === "error") {
      void prepareOnlineUrl(sourceUrl, true);
      return;
    }
    void loadView(undefined, 0);
  }

  const pageLayerStyle = {
    "--papers3-drag-x": `${dragOffset.x}px`,
    "--papers3-drag-y": `${dragOffset.y}px`,
  } as CSSProperties;
  const frameSize = view?.page.pixelSize ?? paperS3FrameSize(display.orientation);
  const frameOrientation: InkScreenOrientation = frameSize.width > frameSize.height
    ? "landscape"
    : "portrait";
  const screenStyle = {
    "--papers3-aspect-ratio": `${frameSize.width} / ${frameSize.height}`,
  } as CSSProperties;
  const isFirstPage = !view || view.page.index === 0;
  const isLastPage = !view || view.page.index + 1 >= view.page.count;
  const hasParent = Boolean(view?.document.parentUuid) || sourceHistoryDepth > 0;
  const sourceVerified = Boolean(view?.source.mode === sourceMode && view.source.verified);
  const installedPackage = installState.status === "installed" ? installState.package : undefined;
  const archiveBusy = installState.status === "downloading" || installState.status === "verifying";
  const sourcePreparing = onlineSourceState.status === "preparing";
  const sourceProgress = sourcePreparing ? onlineSourceState.progress : undefined;
  const sourceProgressPercent = sourceProgress?.total && sourceProgress.total > 0
    ? Math.min(100, Math.max(0, (sourceProgress.completed ?? 0) / sourceProgress.total * 100))
    : undefined;
  const loadingMessage = sourceProgress?.message
    ?? (installState.status === "downloading"
      ? "正在打开应用首页，请稍等…"
      : installState.status === "verifying"
        ? "正在打开应用首页，请稍等…"
        : sourcePreparing
          ? "正在打开网页内容，请稍等…"
          : "正在打开内容，请稍等…");
  const linkedSourceUrl = sourceUrl && !validateSourceUrl(sourceUrl) ? sourceUrl : undefined;
  const currentDeepLink: PaperS3DeepLink = view?.source.mode === "online" && view.source.packageId
    ? {
        packageId: view.source.packageId,
        documentUuid: view.document.uuid,
        pageIndex: view.page.index,
      }
    : {};
  const clockViewKey = view
    ? `${view.source.packageId ?? view.source.packageFilename ?? view.source.label}:${view.document.uuid}:${view.page.index}:${view.page.imageUrl}`
    : "";

  return (
    <main
      className={`${styles.page} ${immersive ? styles.immersivePage : ""}`}
      data-auto-source={Boolean(initialSourceUrl || initialPackageId)}
      data-default-offline-home={useDefaultOfflineHome}
      data-immersive={immersive}
      data-initial-package={initialPackageId}
      data-initial-uuid={initialDocumentUuid}
      data-initial-page={initialPageIndex}
      data-orientation={frameOrientation}
      data-orientation-policy={orientationPolicy}
      onClickCapture={immersive ? attemptNativeFullscreen : undefined}
      onPointerUpCapture={immersive ? attemptNativeFullscreen : undefined}
    >
      {!immersive ? <header className={styles.pageHeader}>
        <div>
          <p className={styles.kicker}>INKOS / PAPERS3 WEB CLIENT</p>
          <h1>阅读帧，而不是重新排版。</h1>
          <p className={styles.intro}>
            同一套 UUID、分页与命中框规则，可执行在线渲染结果，也可执行离线 <code>.ink</code> 内容包。
          </p>
        </div>
        <div className={styles.headerActions}>
          <Link
            className={styles.fullscreenLink}
            href={paperS3ClientHref(
              true,
              sourceUrlForClientHref(view, linkedSourceUrl),
              currentDeepLink,
            )}
          >
            <LineIcon name="maximize" />
            <span>手机全屏</span>
          </Link>
          <div className={styles.headerSpec} aria-label="客户端规格">
            <span>{frameSize.width} × {frameSize.height}</span>
            <small>16 GRAY / 4-BIT</small>
          </div>
        </div>
      </header> : null}

      <div className={`${styles.workspace} ${immersive ? styles.immersiveWorkspace : ""}`}>
        <section className={`${styles.deviceStage} ${immersive ? styles.immersiveDeviceStage : ""}`} aria-labelledby="device-heading">
          <h2 className={styles.visuallyHidden} id="device-heading">PaperS3 客户端屏幕</h2>
          <div className={`${styles.deviceShell} ${immersive ? styles.immersiveShell : ""}`}>
            {!immersive ? <div className={styles.deviceTopbar}>
              <div>
                <span className={styles.deviceName}>PAPERS3</span>
                <small>INKOS CLIENT / REV {view?.document.revision ?? "—"}</small>
              </div>
              <div
                className={styles.sourceBadge}
                data-mode={view?.source.mode ?? sourceMode}
                title={view?.source.detail}
              >
                <LineIcon name={(view?.source.mode ?? sourceMode) === "offline" ? "archive" : "cloud"} size={18} />
                <span>{view?.source.label ?? (sourceMode === "offline" ? "离线包" : "在线实时")}</span>
              </div>
            </div> : null}

            <div
              aria-busy={loading}
              aria-describedby={immersive ? undefined : "gesture-help"}
              aria-label={immersive
                ? "PaperS3 渲染页"
                : "PaperS3 渲染页。可左滑返回，上滑下一页，下滑上一页。"}
              className={`${styles.screen} ${immersive ? styles.immersiveScreen : ""}`}
              onContextMenu={(event) => event.preventDefault()}
              onPointerCancel={(event) => finishPointer(event, true)}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={finishPointer}
              ref={screenRef}
              role="group"
              style={screenStyle}
              tabIndex={0}
            >
              {view ? (
                <div className={styles.pageLayer} style={pageLayerStyle}>
                  <Image
                    alt={view.page.imageAlt}
                    className={styles.frameImage}
                    draggable={false}
                    height={view.page.pixelSize.height}
                    priority
                    src={view.page.imageUrl}
                    unoptimized
                    width={view.page.pixelSize.width}
                  />
                  {view.page.dynamicRegions?.length && clockOverlay.viewKey === clockViewKey ? (
                    <svg
                      aria-hidden="true"
                      className={styles.dynamicRegionLayer}
                      preserveAspectRatio="none"
                      viewBox={`0 0 ${view.page.pixelSize.width} ${view.page.pixelSize.height}`}
                    >
                      {view.page.dynamicRegions.map((region) => {
                        const entry = clockOverlay.entries[region.id];
                        if (!entry) return null;
                        const placement = clockTextPlacement(region);
                        return (
                          <g
                            data-visual-reset={entry.visualResetEpoch}
                            key={`${region.id}:${entry.visualResetEpoch}`}
                          >
                            <rect
                              fill={region.style.background}
                              height={region.bounds.height}
                              shapeRendering="crispEdges"
                              width={region.bounds.width}
                              x={region.bounds.x}
                              y={region.bounds.y}
                            />
                            <text
                              dominantBaseline={placement.dominantBaseline}
                              fill={region.style.foreground}
                              fontFamily={region.style.fontFamily}
                              fontSize={region.style.fontSize}
                              fontWeight={region.style.fontWeight}
                              textAnchor={placement.textAnchor}
                              x={placement.x}
                              y={placement.y}
                            >
                              {entry.text}
                            </text>
                          </g>
                        );
                      })}
                    </svg>
                  ) : null}
                  <div aria-label="本页链接区域" className={styles.hitboxLayer} role="group">
                    {view.page.linkHitboxes.map((hitbox, hitboxIndex) => {
                      const hitboxStyle = {
                        left: `${(hitbox.bounds.x / view.page.pixelSize.width) * 100}%`,
                        top: `${(hitbox.bounds.y / view.page.pixelSize.height) * 100}%`,
                        width: `${(hitbox.bounds.width / view.page.pixelSize.width) * 100}%`,
                        height: `${(hitbox.bounds.height / view.page.pixelSize.height) * 100}%`,
                      };

                      return (
                        <button
                          aria-label={`${hitbox.label}，${isPaperS3DisplaySettingsTarget(hitbox.targetUrl)
                            ? "打开屏内设置"
                            : hitbox.targetUrl
                              ? "由服务器抓取并打开网页"
                              : `跳转到 ${hitbox.targetUuid}`}`}
                          className={styles.linkHitbox}
                          data-hitbox="true"
                          key={`${hitbox.id}:${hitboxIndex}`}
                          onClick={() => void openLink(hitbox)}
                          tabIndex={0}
                          style={hitboxStyle}
                          title={hitbox.label}
                          type="button"
                        >
                          <span className={styles.linkMarker}><LineIcon name="link" size={14} /></span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : error ? (
                immersive ? (
                  <div className={styles.immersiveLoading} role="alert">
                    <LineIcon name="refresh" size={28} />
                    <strong>内容暂不可用</strong>
                    <span>{error}</span>
                    <button onClick={retryContent} type="button">重新载入</button>
                  </div>
                ) : (
                  <div className={styles.screenEmpty} role="alert">
                    <LineIcon name="refresh" size={28} />
                    <strong>内容暂不可用</strong>
                    <span>{error}</span>
                    <button onClick={retryContent} type="button">重新载入</button>
                  </div>
                )
              ) : <div aria-hidden="true" className={styles.screenBlank} />}

              {loading ? (
                <div
                  aria-live="polite"
                  className={styles.loadingStatusBar}
                  data-loading-placement="bottom"
                  role="status"
                >
                  {sourceProgressPercent !== undefined ? (
                    <span
                      aria-hidden="true"
                      className={styles.loadingProgress}
                      style={{ width: `${sourceProgressPercent}%` }}
                    />
                  ) : null}
                  <strong>{loadingMessage}</strong>
                  <small>{loadingElapsedSeconds < 3
                      ? "请稍候"
                      : `已等待 ${loadingElapsedSeconds} 秒`}</small>
                </div>
              ) : null}
            </div>

            {!immersive ? <div className={styles.deviceMeta}>
              <div>
                <span>{view ? `${view.page.index + 1} / ${view.page.count}` : "— / —"}</span>
                <small>{view?.document.kind.toUpperCase() ?? "NO FRAME"}</small>
              </div>
              <p title={view?.document.uuid}>{view?.document.uuid ?? "等待内容 UUID"}</p>
              <span className={styles.linkCount}>{view?.page.linkHitboxes.length ?? 0} LINK</span>
            </div> : null}

            {!immersive ? <nav aria-label="页面导航" className={styles.deviceNav}>
              <button
                disabled={!hasParent || loading}
                onClick={() => executeIntent("parent")}
                type="button"
              >
                <LineIcon name="arrow-left" />
                <span>上一层</span>
              </button>
              <button
                disabled={(isFirstPage && !hasParent) || loading}
                onClick={() => executeIntent("previous-page-or-parent")}
                type="button"
              >
                <LineIcon name="chevron-down" />
                <span>上一页</span>
              </button>
              <button
                disabled={isLastPage || loading}
                onClick={() => executeIntent("next-page")}
                type="button"
              >
                <LineIcon name="chevron-up" />
                <span>下一页</span>
              </button>
            </nav> : null}
          </div>
        </section>

        {!immersive ? <aside className={styles.controlPanel} aria-label="PaperS3 客户端设置">
          <section className={styles.statusPanel}>
            <div className={styles.panelHeading}>
              <div>
                <p className={styles.panelLabel}>SOURCE</p>
                <h2>内容来源</h2>
              </div>
              <span className={styles.verifiedState} data-verified={sourceVerified}>
                {sourceVerified
                  ? "已校验"
                  : archiveBusy
                    ? "载入中"
                    : sourceMode === "offline" && !installedPackage
                      ? "未安装"
                      : "校验中"}
              </span>
            </div>
            <div aria-label="选择内容来源" className={styles.segmentedControl} role="group">
              <button
                aria-pressed={sourceMode === "online"}
                onClick={() => selectSource("online")}
                type="button"
              >
                <LineIcon name="cloud" />
                在线实时
              </button>
              <button
                aria-pressed={sourceMode === "offline"}
                onClick={() => selectSource("offline")}
                type="button"
              >
                <LineIcon name="archive" />
                离线 .ink
              </button>
            </div>
            <div className={styles.sourceDetail}>
              <span>{view?.source.mode === sourceMode
                ? view.source.detail
                : sourceMode === "offline" && installedPackage
                  ? `${installedPackage.filename} · ${installedPackage.title} · r${installedPackage.revision}`
                  : sourceMode === "offline"
                    ? "尚未安装离线内容包"
                    : "正在读取在线来源清单…"}</span>
              <small>{runtime.adapterId}</small>
            </div>
            {sourceMode === "online" && runtime.prepareOnlineSource ? (
              <form className={styles.sourceUrlForm} noValidate onSubmit={submitOnlineSource}>
                <label htmlFor="papers3-source-url">网页地址</label>
                <div className={styles.sourceUrlControls}>
                  <input
                    aria-describedby={`papers3-source-help${sourceUrlError ? " papers3-source-error" : ""}`}
                    aria-invalid={Boolean(sourceUrlError)}
                    autoCapitalize="none"
                    autoComplete="url"
                    autoCorrect="off"
                    disabled={sourcePreparing}
                    id="papers3-source-url"
                    inputMode="url"
                    onChange={(event) => {
                      setSourceUrl(event.target.value);
                      setSourceUrlError(undefined);
                    }}
                    placeholder="https://example.com/article"
                    ref={sourceUrlInputRef}
                    spellCheck={false}
                    type="url"
                    value={sourceUrl}
                  />
                  <button disabled={sourcePreparing || loading} type="submit">
                    <LineIcon name="cloud" size={18} />
                    <span>{sourcePreparing ? "处理中" : "抓取并打开"}</span>
                  </button>
                </div>
                <small id="papers3-source-help">客户端只把 URL 发给 InkOS；目标网页由服务器抓取、渲染并校验。</small>
                {sourceUrlError ? <span className={styles.sourceUrlError} id="papers3-source-error" role="alert">
                  {sourceUrlError}
                </span> : null}
                {sourceProgress ? <div aria-live="polite" className={styles.sourceProgress} role="status">
                  <span>{sourceProgress.message}</span>
                  <progress max={100} value={sourceProgressPercent} />
                </div> : null}
                {onlineSourceState.status === "ready" ? <span className={styles.sourceReady} role="status">
                  {onlineSourceState.result.cached ? "已打开服务端缓存内容" : "网页内容已生成并打开"}
                </span> : null}
              </form>
            ) : null}
            {sourceMode === "offline" && runtime.installArchive ? (
              <div aria-live="polite" className={styles.installBox} data-status={installState.status}>
                <div>
                  <strong>{installState.status === "installed"
                    ? "离线包已就绪"
                    : installState.status === "downloading"
                      ? "正在下载应用首页"
                    : installState.status === "verifying"
                      ? "正在验证完整包"
                      : installState.status === "error"
                        ? "包安装失败"
                        : "安装离线内容"}</strong>
                  <span>{installState.status === "installed"
                    ? `${installState.package.documentCount} 文档 · ${installState.package.variantCount} 帧变体`
                    : installState.status === "downloading"
                      ? "从本机 InkOS 服务获取内置 .ink Demo…"
                    : installState.status === "verifying"
                      ? `${installState.filename} · SHA-256 / 清单 / sidecar`
                      : installState.status === "error"
                        ? installState.message
                        : "可打开内置首页 Demo，或选择本机 .ink；归档都在浏览器内校验。"}</span>
                </div>
                <div className={styles.archiveActions}>
                  <button
                    className={styles.demoPicker}
                    disabled={archiveBusy || loading}
                    onClick={() => void installHomeDemo()}
                    type="button"
                  >
                    <LineIcon name="archive" size={18} />
                    <span>{installState.status === "downloading" ? "正在下载" : "应用首页 Demo"}</span>
                  </button>
                  <label className={styles.filePicker}>
                    <LineIcon name="plus" size={18} />
                    <span>{installState.status === "installed" ? "更换 .ink" : "选择本机 .ink"}</span>
                    <input
                      accept=".ink,application/vnd.inkos.package+zip,application/zip"
                      aria-label="选择并安装 .ink 离线内容包"
                      disabled={archiveBusy}
                      onChange={(event) => void installInkFile(event)}
                      type="file"
                    />
                  </label>
                </div>
              </div>
            ) : null}
          </section>

          <section className={styles.settingsPanel}>
            <div className={styles.panelHeading}>
              <div>
                <p className={styles.panelLabel}>DISPLAY</p>
                <h2>显示设置</h2>
              </div>
              <span className={styles.framePolicy}>服务端帧变体</span>
            </div>

            <div className={styles.settingRow}>
              <div className={styles.settingCopy}>
                <span className={styles.settingIcon}><LineIcon name="portrait" /></span>
                <div>
                  <strong>屏幕方向</strong>
                  <small>默认手动竖屏；自动模式跟随后续传感器变化</small>
                </div>
              </div>
              <div aria-label="选择屏幕方向" className={styles.orientationControl} role="group">
                <button
                  aria-pressed={orientationPolicy === "auto"}
                  disabled={loading}
                  onClick={useAutomaticOrientation}
                  type="button"
                >
                  自动
                </button>
                <button
                  aria-pressed={orientationPolicy === "manual" && display.orientation === "portrait"}
                  disabled={loading}
                  onClick={() => requestManualOrientation("portrait")}
                  type="button"
                >
                  <LineIcon name="portrait" size={18} />
                  竖屏
                </button>
                <button
                  aria-pressed={orientationPolicy === "manual" && display.orientation === "landscape"}
                  disabled={loading}
                  onClick={() => requestManualOrientation("landscape")}
                  type="button"
                >
                  <LineIcon name="landscape" size={18} />
                  横屏
                </button>
              </div>
            </div>

            <div className={styles.settingRow}>
              <div className={styles.settingCopy}>
                <span className={styles.settingIcon}><LineIcon name="type" /></span>
                <div>
                  <strong>字体微调</strong>
                  <small>切换对应字号的预渲染帧</small>
                </div>
              </div>
              <div className={styles.stepper}>
                <button
                  aria-label="字体缩小一级"
                  disabled={display.fontLevel === -2 || loading}
                  onClick={() => changeFont(-1)}
                  type="button"
                >
                  <LineIcon name="minus" />
                </button>
                <output aria-live="polite">{fontLevelLabels[display.fontLevel]}</output>
                <button
                  aria-label="字体放大一级"
                  disabled={display.fontLevel === 2 || loading}
                  onClick={() => changeFont(1)}
                  type="button"
                >
                  <LineIcon name="plus" />
                </button>
              </div>
            </div>

          </section>

          <section className={styles.guidePanel} id="gesture-help">
            <div className={styles.panelHeading}>
              <div>
                <p className={styles.panelLabel}>NAVIGATION</p>
                <h2>固定操作规则</h2>
              </div>
              <span className={styles.gestureThreshold}>
                MAX({PAPERS3_SWIPE_MIN_DISTANCE_PX} PX, 短边 {PAPERS3_SWIPE_SHORT_EDGE_RATIO * 100}%) / {PAPERS3_SWIPE_DOMINANCE_RATIO}
              </span>
            </div>
            <dl className={styles.gestureList}>
              <div>
                <dt><LineIcon name="arrow-left" />左滑</dt>
                <dd>返回 parent UUID</dd>
                <kbd>← / Esc</kbd>
              </div>
              <div>
                <dt><LineIcon name="chevron-up" />上滑</dt>
                <dd>长内容的下一页</dd>
                <kbd>↑ / PgDn</kbd>
              </div>
              <div>
                <dt><LineIcon name="chevron-down" />下滑</dt>
                <dd>上一页；首页继续下滑返回 parent</dd>
                <kbd>↓ / PgUp</kbd>
              </div>
              <div>
                <dt><LineIcon name="link" />点按</dt>
                <dd>按渲染清单命中框跳转 child UUID</dd>
                <kbd>Tab / Enter</kbd>
              </div>
              <div>
                <dt><LineIcon name="type" />长按顶部</dt>
                <dd>按住屏幕顶部 20% 区域打开屏内设置</dd>
                <kbd>5 SEC</kbd>
              </div>
            </dl>
          </section>

          {error ? (
            <section className={styles.errorPanel} role="alert">
              <div>
                <strong>帧加载失败</strong>
                <span>{error}</span>
              </div>
              <button
                onClick={() => {
                  const current = viewRef.current;
                  void loadView(current?.document.uuid, current?.page.index ?? 0);
                }}
                type="button"
              >
                <LineIcon name="refresh" />重试
              </button>
            </section>
          ) : null}
        </aside> : null}
      </div>

      {settingsOpen ? (
        <div
          className={styles.settingsBackdrop}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <section
            aria-labelledby="papers3-display-settings-title"
            aria-modal="true"
            className={styles.settingsDialog}
            role="dialog"
          >
            <header className={styles.settingsDialogHeader}>
              <div>
                <p className={styles.panelLabel}>SCREEN SETTINGS</p>
                <h2 id="papers3-display-settings-title">屏内显示设置</h2>
              </div>
              <button
                aria-label="关闭显示设置"
                className={styles.settingsClose}
                onClick={closeDisplaySettings}
                ref={settingsCloseButtonRef}
                type="button"
              >
                <LineIcon name="close" />
                <span>关闭</span>
              </button>
            </header>

            <fieldset className={styles.settingsFieldset}>
              <legend>屏幕方向</legend>
              <div aria-label="方向策略" className={styles.modalSegmentedControl} role="group">
                <button
                  aria-pressed={settingsDraft.orientationPolicy === "auto"}
                  onClick={() => setSettingsDraft((current) => ({ ...current, orientationPolicy: "auto" }))}
                  type="button"
                >
                  自动旋转
                </button>
                <button
                  aria-pressed={settingsDraft.orientationPolicy === "manual"}
                  onClick={() => setSettingsDraft((current) => ({ ...current, orientationPolicy: "manual" }))}
                  type="button"
                >
                  手动方向
                </button>
              </div>
              {settingsDraft.orientationPolicy === "manual" ? (
                <div aria-label="手动屏幕方向" className={styles.modalSegmentedControl} role="group">
                  <button
                    aria-pressed={settingsDraft.display.orientation === "portrait"}
                    onClick={() => setSettingsDraft((current) => ({
                      ...current,
                      display: { ...current.display, orientation: "portrait" },
                    }))}
                    type="button"
                  >
                    <LineIcon name="portrait" size={18} />竖屏
                  </button>
                  <button
                    aria-pressed={settingsDraft.display.orientation === "landscape"}
                    onClick={() => setSettingsDraft((current) => ({
                      ...current,
                      display: { ...current.display, orientation: "landscape" },
                    }))}
                    type="button"
                  >
                    <LineIcon name="landscape" size={18} />横屏
                  </button>
                </div>
              ) : <small>保持当前方向，下一次真实传感器变化时再切换渲染帧。</small>}
            </fieldset>

            <div className={styles.modalSettingRow}>
              <div>
                <strong>字体微调</strong>
                <small>从小两号到大两号</small>
              </div>
              <div className={styles.stepper}>
                <button
                  aria-label="字体缩小一级"
                  disabled={settingsDraft.display.fontLevel === -2}
                  onClick={() => changeDraftFont(-1)}
                  type="button"
                ><LineIcon name="minus" /></button>
                <output aria-live="polite">{fontLevelLabels[settingsDraft.display.fontLevel]}</output>
                <button
                  aria-label="字体放大一级"
                  disabled={settingsDraft.display.fontLevel === 2}
                  onClick={() => changeDraftFont(1)}
                  type="button"
                ><LineIcon name="plus" /></button>
              </div>
            </div>

            <footer className={styles.settingsDialogActions}>
              <button onClick={closeDisplaySettings} type="button">取消</button>
              <button onClick={applyDisplaySettingsDraft} type="button">应用设置</button>
            </footer>
          </section>
        </div>
      ) : null}

      <p aria-live="polite" className={styles.visuallyHidden}>{announcement}</p>
    </main>
  );
}
