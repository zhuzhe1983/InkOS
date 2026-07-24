"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  contentDocumentSchema,
  type ContentDocument,
  type RenderImageTarget,
  type RenderInteraction,
} from "@/lib/rendering/contracts";
import { collectContentImageOccurrences } from "@/lib/rendering/content-images";

interface DeviceSimulatorProps {
  detailDocument: string;
  listDocument: string;
  galleryDocument: string;
  imageDetailDocument: string;
  ebookHomeDocument: string;
  fullscreenContainDocument: string;
  fullscreenCoverDocument: string;
  gridDocument: string;
  readerDocument: string;
  semanticListDocument: string;
  postcardDocument: string;
  cardboardDocument: string;
}

interface ProfileSummary {
  id: string;
  label: string;
  deviceType: string;
  nativeSize: { width: number; height: number };
  logicalSize: { width: number; height: number };
  displayRotation: number;
  orientationRotations?: { portrait: number; landscape: number };
  color: {
    mode: "monochrome" | "grayscale" | "color";
    levels: 2 | 6 | 16;
    palette?: "spectra6";
  };
  pixelFormat: "mono1" | "gray4" | "spectra6";
  layoutStrategy?: string;
  rasterStrategy?: string;
}

interface FrameManifest {
  documentId: string;
  contentType: "detail" | "list" | "reader" | "image";
  frameId: string;
  logicalSize: { width: number; height: number };
  nativeSize: { width: number; height: number };
  displayRotation: number;
  pixelFormat: string;
  displayMeta: DisplayMeta;
  payloadBytes: number;
  crc32: string;
  pagination: {
    pageIndex: number;
    pageCount: number;
    hasPrevious: boolean;
    hasNext: boolean;
  };
  update: { kind: string };
  interactions: RenderInteraction[];
  warnings?: string[];
}

type ExampleKind =
  | "detail"
  | "reading-list"
  | "list"
  | "gallery"
  | "image-detail"
  | "ebook-home"
  | "fullscreen-contain"
  | "fullscreen-cover"
  | "grid"
  | "reader"
  | "postcard"
  | "cardboard"
  | "custom";
type ErrorKind = "json" | "schema" | "render" | "network";
type FontLevel = -2 | -1 | 0 | 1 | 2;
type Orientation = "portrait" | "landscape";

interface DisplayMeta {
  fontLevel: FontLevel;
  orientation: Orientation;
}

export interface SimulatorImagePreview {
  readonly contentPath: string;
  readonly targetDocumentId: string;
  readonly document: ContentDocument;
}

export interface SimulatorRenderPlan {
  readonly imageTargets: RenderImageTarget[];
  readonly imagePreviews: ReadonlyMap<string, SimulatorImagePreview>;
}

interface PreviewHistoryEntry {
  readonly document: ContentDocument;
  readonly pageIndex: number;
  readonly editorDocument: boolean;
}

interface SimulatorError {
  kind: ErrorKind;
  message: string;
}

interface ApiErrorBody {
  error?: string;
  message?: string;
  issues?: Array<{ path: PropertyKey[]; message: string }>;
}

class PreviewError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
  ) {
    super(message);
  }
}

const fallbackProfiles: ProfileSummary[] = [
  {
    id: "m5stack-paper-s3-portrait",
    label: "M5Stack PaperS3",
    deviceType: "paper-s3",
    nativeSize: { width: 960, height: 540 },
    logicalSize: { width: 540, height: 960 },
    displayRotation: 90,
    color: { mode: "grayscale", levels: 16 },
    pixelFormat: "gray4",
  },
  {
    id: "m5stack-xiaozhi-card",
    label: "M5Stack Xiaozhi Card Kit",
    deviceType: "xiaozhi-card-kit",
    nativeSize: { width: 176, height: 264 },
    logicalSize: { width: 176, height: 264 },
    displayRotation: 0,
    color: { mode: "monochrome", levels: 2 },
    pixelFormat: "mono1",
  },
  {
    id: "m5stack-paper-color",
    label: "M5Stack PaperColor",
    deviceType: "paper-color",
    nativeSize: { width: 400, height: 600 },
    logicalSize: { width: 400, height: 600 },
    displayRotation: 0,
    color: { mode: "color", levels: 6, palette: "spectra6" },
    pixelFormat: "spectra6",
  },
];

const errorLabels: Record<ErrorKind, string> = {
  json: "JSON 错误",
  schema: "Schema 错误",
  render: "渲染错误",
  network: "网络错误",
};

function CodeIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="m8 9-3 3 3 3M16 9l3 3-3 3M14 5l-4 14" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M6.1 9a7 7 0 0 1 11.6-2L20 9M4 15l2.3 2a7 7 0 0 0 11.6-2" />
    </svg>
  );
}

function formatBytes(bytes?: number): string {
  if (bytes === undefined) return "—";
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function decodeBase64Url(value: string): string {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return atob(base64);
}

function decodeManifest(value: string | null): FrameManifest | null {
  if (!value) return null;
  return JSON.parse(decodeBase64Url(value)) as FrameManifest;
}

function simulatorPreviewDocumentId(document: ContentDocument, index: number): string {
  const readableId = document.id.toLowerCase().replace(/[^a-z0-9._:/-]+/gu, "-").slice(0, 72);
  return `simulator-image-preview:${index}:${readableId || "document"}`;
}

/**
 * Build output-only image navigation for one render request. Generated target
 * IDs and full-screen child documents never enter the editable semantic JSON.
 */
export function createSimulatorRenderPlan(document: ContentDocument): SimulatorRenderPlan {
  if (document.page.kind === "image") {
    return { imageTargets: [], imagePreviews: new Map() };
  }

  const imageTargets: RenderImageTarget[] = [];
  const imagePreviews = new Map<string, SimulatorImagePreview>();
  collectContentImageOccurrences(document).forEach((occurrence, index) => {
    const targetDocumentId = simulatorPreviewDocumentId(document, index);
    const previewDocument: ContentDocument = {
      schemaVersion: "inkos.content/v2",
      id: targetDocumentId,
      revision: document.revision,
      locale: document.locale,
      ...(document.updatedAt ? { updatedAt: document.updatedAt } : {}),
      page: {
        kind: "image",
        layout: "contain",
        image: {
          source: occurrence.image.source,
          alt: occurrence.image.alt,
        },
      },
    };
    const preview = {
      contentPath: occurrence.contentPath,
      targetDocumentId,
      document: previewDocument,
    } satisfies SimulatorImagePreview;
    imageTargets.push({ contentPath: occurrence.contentPath, targetDocumentId });
    imagePreviews.set(targetDocumentId, preview);
  });
  return { imageTargets, imagePreviews };
}

function interactionArea(interaction: RenderInteraction): number {
  return interaction.bounds.width * interaction.bounds.height;
}

/** Half-open logical hit testing with smallest-area precedence and stable ties. */
export function hitTestFrameInteractions(
  interactions: readonly RenderInteraction[],
  x: number,
  y: number,
): RenderInteraction | undefined {
  let winner: RenderInteraction | undefined;
  for (const interaction of interactions) {
    const { bounds } = interaction;
    if (
      x < bounds.x
      || x >= bounds.x + bounds.width
      || y < bounds.y
      || y >= bounds.y + bounds.height
    ) continue;
    if (!winner || interactionArea(interaction) < interactionArea(winner)) winner = interaction;
  }
  return winner;
}

export function imagePreviewForInteraction(
  interaction: RenderInteraction | undefined,
  previews: ReadonlyMap<string, SimulatorImagePreview>,
): SimulatorImagePreview | undefined {
  if (!interaction || interaction.action.type !== "open-document") return undefined;
  const preview = previews.get(interaction.action.documentId);
  if (!preview || interaction.contentPath !== `${preview.contentPath}.fullscreen`) return undefined;
  return preview;
}

export function logicalPointInFrame(
  clientPoint: { x: number; y: number },
  frameRect: { left: number; top: number; width: number; height: number },
  logicalSize: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: ((clientPoint.x - frameRect.left) / frameRect.width) * logicalSize.width,
    y: ((clientPoint.y - frameRect.top) / frameRect.height) * logicalSize.height,
  };
}

function decodeWarnings(value: string | null, manifest: FrameManifest | null): string[] {
  if (!value) return manifest?.warnings ?? [];

  for (const candidate of [value, (() => {
    try {
      return decodeBase64Url(value);
    } catch {
      return "";
    }
  })()]) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        return parsed;
      }
    } catch {
      // Try the next supported header encoding.
    }
  }

  return manifest?.warnings ?? [];
}

function layoutStrategyLabel(profile?: ProfileSummary): string {
  if (!profile) return "adaptive-flow";
  if (profile.layoutStrategy) return profile.layoutStrategy;
  const compact = profile.logicalSize.width < 300 || profile.logicalSize.height < 420;
  return compact ? "compact-flow" : "editorial-flow";
}

function rasterStrategyLabel(profile?: ProfileSummary): string {
  if (!profile) return "—";
  if (profile.rasterStrategy) return profile.rasterStrategy;
  if (profile.color.mode === "grayscale") {
    return `${profile.pixelFormat} / ${profile.color.levels}级灰度`;
  }
  if (profile.color.mode === "color") return `${profile.pixelFormat} / Spectra 6 色`;
  return `${profile.pixelFormat} / 1-bit 单色`;
}

const fontLevels: Array<{ value: FontLevel; label: string; accessibleLabel: string }> = [
  { value: -2, label: "小 2", accessibleLabel: "字号缩小两档" },
  { value: -1, label: "小 1", accessibleLabel: "字号缩小一档" },
  { value: 0, label: "标准", accessibleLabel: "标准字号" },
  { value: 1, label: "大 1", accessibleLabel: "字号放大一档" },
  { value: 2, label: "大 2", accessibleLabel: "字号放大两档" },
];

function requestKey(
  profileId: string,
  pageIndex: number,
  documentJson: string,
  displayMeta: DisplayMeta,
): string {
  return `${profileId}\u0000${pageIndex}\u0000${displayMeta.orientation}\u0000${displayMeta.fontLevel}\u0000${documentJson}`;
}

function sizeForOrientation(
  size: { width: number; height: number },
  orientation: Orientation,
): { width: number; height: number } {
  const alreadyMatches = orientation === "portrait"
    ? size.height >= size.width
    : size.width >= size.height;
  return alreadyMatches ? size : { width: size.height, height: size.width };
}

function rotationForOrientation(profile: ProfileSummary | undefined, orientation: Orientation): number | undefined {
  if (!profile) return undefined;
  if (profile.orientationRotations) return profile.orientationRotations[orientation];
  const nativeIsLandscape = profile.nativeSize.width > profile.nativeSize.height;
  const wantsLandscape = orientation === "landscape";
  return nativeIsLandscape !== wantsLandscape ? 90 : 0;
}

export function DeviceSimulator({
  detailDocument,
  listDocument,
  galleryDocument,
  imageDetailDocument,
  ebookHomeDocument,
  fullscreenContainDocument,
  fullscreenCoverDocument,
  gridDocument,
  readerDocument,
  semanticListDocument,
  postcardDocument,
  cardboardDocument,
}: DeviceSimulatorProps) {
  const [profiles, setProfiles] = useState<ProfileSummary[]>(fallbackProfiles);
  const [selectedProfileId, setSelectedProfileId] = useState(fallbackProfiles[0].id);
  const [documentJson, setDocumentJson] = useState(detailDocument);
  const [activePreviewDocument, setActivePreviewDocument] = useState<ContentDocument | null>(null);
  const [previewHistory, setPreviewHistory] = useState<PreviewHistoryEntry[]>([]);
  const [imagePreviews, setImagePreviews] = useState<ReadonlyMap<string, SimulatorImagePreview>>(new Map());
  const [renderedDocument, setRenderedDocument] = useState<ContentDocument | null>(null);
  const [activeExample, setActiveExample] = useState<ExampleKind>("detail");
  const [pageIndex, setPageIndex] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [manifest, setManifest] = useState<FrameManifest | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle" | "rendering" | "ready" | "error">("idle");
  const [error, setError] = useState<SimulatorError | null>(null);
  const [livePreview, setLivePreview] = useState(true);
  const [displayMeta, setDisplayMeta] = useState<DisplayMeta>({
    fontLevel: 0,
    orientation: "portrait",
  });
  const requestNumber = useRef(0);
  const abortController = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null);
  const lastStartedKey = useRef<string | null>(null);

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId) ?? profiles[0],
    [profiles, selectedProfileId],
  );

  const examples = useMemo<Array<{ id: Exclude<ExampleKind, "custom">; label: string; document: string }>>(
    () => [
      { id: "grid", label: "Grid 日历", document: gridDocument },
      { id: "reader", label: "Reader 纯文本", document: readerDocument },
      { id: "list", label: "List 导航", document: semanticListDocument },
      { id: "postcard", label: "Postcard", document: postcardDocument },
      { id: "cardboard", label: "Cardboard", document: cardboardDocument },
      { id: "detail", label: "文章详情", document: detailDocument },
      { id: "reading-list", label: "阅读列表", document: listDocument },
      { id: "gallery", label: "图片瀑布流", document: galleryDocument },
      { id: "image-detail", label: "图片详情", document: imageDetailDocument },
      { id: "ebook-home", label: "电子书首页", document: ebookHomeDocument },
      { id: "fullscreen-contain", label: "全图留边", document: fullscreenContainDocument },
      { id: "fullscreen-cover", label: "全图裁剪", document: fullscreenCoverDocument },
    ],
    [
      cardboardDocument,
      detailDocument,
      ebookHomeDocument,
      fullscreenContainDocument,
      fullscreenCoverDocument,
      galleryDocument,
      gridDocument,
      imageDetailDocument,
      listDocument,
      postcardDocument,
      readerDocument,
      semanticListDocument,
    ],
  );

  const renderDocumentJson = useMemo(
    () => activePreviewDocument ? JSON.stringify(activePreviewDocument) : documentJson,
    [activePreviewDocument, documentJson],
  );

  const currentRequestKey = useMemo(
    () => requestKey(selectedProfileId, pageIndex, renderDocumentJson, displayMeta),
    [displayMeta, pageIndex, renderDocumentJson, selectedProfileId],
  );

  const clearPreview = useCallback(() => {
    if (objectUrl.current) {
      URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    }
    setPreviewUrl(null);
    setManifest(null);
    setWarnings([]);
    setImagePreviews(new Map());
    setRenderedDocument(null);
  }, []);

  const cancelAndClear = useCallback(() => {
    requestNumber.current += 1;
    abortController.current?.abort();
    abortController.current = null;
    lastStartedKey.current = null;
    clearPreview();
    setStatus("idle");
    setError(null);
  }, [clearPreview]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/device-profiles", { signal: controller.signal })
      .then((response) => response.json())
      .then((data: { profiles?: ProfileSummary[] }) => {
        if (data.profiles?.length) setProfiles(data.profiles);
      })
      .catch((profileError: unknown) => {
        if (!(profileError instanceof DOMException && profileError.name === "AbortError")) {
          setProfiles(fallbackProfiles);
        }
      });
    return () => controller.abort();
  }, []);

  const renderPreview = useCallback(async (
    targetPageIndex = pageIndex,
    documentOverride?: ContentDocument,
    requestDocumentKeyOverride?: string,
  ) => {
    const requestDocumentJson = requestDocumentKeyOverride ?? (documentOverride
      ? JSON.stringify(documentOverride)
      : renderDocumentJson);
    const thisRequestKey = requestKey(selectedProfileId, targetPageIndex, requestDocumentJson, displayMeta);
    lastStartedKey.current = thisRequestKey;
    abortController.current?.abort();
    const controller = new AbortController();
    abortController.current = controller;
    const thisRequest = ++requestNumber.current;
    setStatus("rendering");
    setError(null);
    setWarnings([]);

    let parsedDocument: unknown;
    try {
      parsedDocument = documentOverride ?? JSON.parse(requestDocumentJson);
    } catch (parseError) {
      if (thisRequest !== requestNumber.current) return;
      setStatus("error");
      setError({
        kind: "json",
        message: parseError instanceof Error ? parseError.message : "无法解析内容 JSON",
      });
      return;
    }

    const parsedContent = contentDocumentSchema.safeParse(parsedDocument);
    const renderPlan = parsedContent.success
      ? createSimulatorRenderPlan(parsedContent.data)
      : { imageTargets: [], imagePreviews: new Map<string, SimulatorImagePreview>() };

    try {
      const response = await fetch("/api/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profileId: selectedProfileId,
          document: parsedDocument,
          pageIndex: targetPageIndex,
          displayMeta,
          navigationContext: { imageTargets: renderPlan.imageTargets },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        let body: ApiErrorBody | null = null;
        try {
          body = (await response.json()) as ApiErrorBody;
        } catch {
          // The status code still provides a useful fallback below.
        }
        const issue = body?.issues?.[0];
        const issuePath = issue?.path.map(String).join(".");
        const message = issue
          ? `${issuePath ? `${issuePath}: ` : ""}${issue.message}`
          : body?.message ?? `HTTP ${response.status}`;
        throw new PreviewError(body?.error === "INVALID_RENDER_REQUEST" ? "schema" : "render", message);
      }

      const blob = await response.blob();
      if (controller.signal.aborted || thisRequest !== requestNumber.current) return;

      let nextManifest: FrameManifest | null;
      try {
        nextManifest = decodeManifest(response.headers.get("X-Inkos-Manifest"));
      } catch {
        throw new PreviewError("render", "渲染响应中的帧清单无法解析");
      }
      if (nextManifest && parsedContent.success && nextManifest.documentId !== parsedContent.data.id) {
        throw new PreviewError("render", "渲染响应中的文档 ID 与当前预览不一致");
      }

      const nextUrl = URL.createObjectURL(blob);
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = nextUrl;
      setPreviewUrl(nextUrl);
      setManifest(nextManifest);
      setImagePreviews(renderPlan.imagePreviews);
      setRenderedDocument(parsedContent.success ? parsedContent.data : null);
      setWarnings(decodeWarnings(response.headers.get("X-Inkos-Warnings"), nextManifest));
      setStatus("ready");
    } catch (renderError) {
      if (controller.signal.aborted || thisRequest !== requestNumber.current) return;
      clearPreview();
      setStatus("error");
      if (renderError instanceof PreviewError) {
        setError({ kind: renderError.kind, message: renderError.message });
      } else {
        setError({
          kind: "network",
          message: renderError instanceof Error ? renderError.message : "无法连接渲染服务",
        });
      }
    } finally {
      if (abortController.current === controller) abortController.current = null;
    }
  }, [clearPreview, displayMeta, pageIndex, renderDocumentJson, selectedProfileId]);

  useEffect(() => {
    if (!livePreview) return;
    const timeout = window.setTimeout(() => {
      if (lastStartedKey.current !== currentRequestKey) void renderPreview();
    }, 550);
    return () => window.clearTimeout(timeout);
  }, [currentRequestKey, livePreview, renderPreview]);

  useEffect(() => () => {
    requestNumber.current += 1;
    abortController.current?.abort();
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
  }, []);

  function replaceDocument(nextDocument: string, example: ExampleKind) {
    cancelAndClear();
    setActivePreviewDocument(null);
    setPreviewHistory([]);
    setDocumentJson(nextDocument);
    setActiveExample(example);
    setPageIndex(0);
  }

  function formatDocument() {
    try {
      const formatted = JSON.stringify(JSON.parse(documentJson), null, 2);
      if (formatted !== documentJson) {
        cancelAndClear();
        setActivePreviewDocument(null);
        setPreviewHistory([]);
        setDocumentJson(formatted);
        setPageIndex(0);
      }
      setError(null);
    } catch (parseError) {
      clearPreview();
      setError({
        kind: "json",
        message: parseError instanceof Error ? parseError.message : "无法解析内容 JSON",
      });
      setStatus("error");
    }
  }

  function selectFontLevel(fontLevel: FontLevel) {
    if (fontLevel === displayMeta.fontLevel) return;
    cancelAndClear();
    setDisplayMeta((current) => ({ ...current, fontLevel }));
    setPageIndex(0);
  }

  function selectOrientation(orientation: Orientation) {
    if (orientation === displayMeta.orientation) return;
    cancelAndClear();
    setDisplayMeta((current) => ({ ...current, orientation }));
    setPageIndex(0);
  }

  function selectProfile(profileId: string) {
    if (profileId === selectedProfileId) return;
    cancelAndClear();
    setSelectedProfileId(profileId);
    setPageIndex(0);
  }

  function selectPage(nextPageIndex: number) {
    const pageCount = manifest?.pagination.pageCount ?? 0;
    if (nextPageIndex < 0 || nextPageIndex >= pageCount || nextPageIndex === pageIndex) return;
    cancelAndClear();
    setPageIndex(nextPageIndex);
    void renderPreview(nextPageIndex);
  }

  function openImagePreview(preview: SimulatorImagePreview) {
    if (!renderedDocument || status === "rendering") return;
    const visit: PreviewHistoryEntry = {
      document: renderedDocument,
      pageIndex,
      editorDocument: activePreviewDocument === null,
    };
    cancelAndClear();
    setPreviewHistory((current) => [...current, visit]);
    setActivePreviewDocument(preview.document);
    setPageIndex(0);
    void renderPreview(0, preview.document);
  }

  function returnFromImagePreview() {
    const previous = previewHistory.at(-1);
    if (!previous || status === "rendering") return;
    cancelAndClear();
    setPreviewHistory((current) => current.slice(0, -1));
    setActivePreviewDocument(previous.editorDocument ? null : previous.document);
    setPageIndex(previous.pageIndex);
    void renderPreview(
      previous.pageIndex,
      previous.document,
      previous.editorDocument ? documentJson : undefined,
    );
  }

  function handleFrameClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (!manifest || status !== "ready") return;
    const point = logicalPointInFrame(
      { x: event.clientX, y: event.clientY },
      event.currentTarget.getBoundingClientRect(),
      manifest.logicalSize,
    );
    const interaction = hitTestFrameInteractions(manifest.interactions, point.x, point.y);
    const preview = imagePreviewForInteraction(interaction, imagePreviews);
    if (preview) openImagePreview(preview);
  }

  function handleFrameKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    const preview = manifest?.interactions
      .map((interaction) => imagePreviewForInteraction(interaction, imagePreviews))
      .find((candidate) => candidate !== undefined);
    if (!preview) return;
    event.preventDefault();
    openImagePreview(preview);
  }

  const isXiaozhi = selectedProfile?.deviceType === "xiaozhi-card-kit";
  const isPaperColor = selectedProfile?.deviceType === "paper-color";
  const deviceFrameClass = isXiaozhi
    ? "xiaozhi-frame"
    : isPaperColor
      ? "paper-color-frame"
      : "paper-frame";
  const pagination = manifest?.pagination;
  const previewLogicalSize = manifest?.logicalSize ?? sizeForOrientation(
    selectedProfile?.logicalSize ?? fallbackProfiles[0].logicalSize,
    displayMeta.orientation,
  );
  const previewNativeSize = manifest?.nativeSize ?? selectedProfile?.nativeSize;
  const previewDisplayRotation = manifest?.displayRotation
    ?? rotationForOrientation(selectedProfile, displayMeta.orientation);
  const previewOrientation: Orientation = previewLogicalSize.width > previewLogicalSize.height
    ? "landscape"
    : "portrait";
  const strategySummary = `${layoutStrategyLabel(selectedProfile)} · ${rasterStrategyLabel(selectedProfile)}`;
  const editorInvalid = error?.kind === "json" || error?.kind === "schema";
  const imageInteractionCount = manifest?.interactions.filter((interaction) =>
    imagePreviewForInteraction(interaction, imagePreviews) !== undefined
  ).length ?? 0;

  return (
    <main className="simulator-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">I</div>
          <div>
            <div className="eyebrow">INKOS / RENDER LAB</div>
            <h1>电子纸设备模拟器</h1>
          </div>
        </div>
        <div className="engine-state" data-state={status} role="status" aria-live="polite">
          <span className="state-dot" />
          {status === "rendering" ? "Rendering" : status === "error" ? "Render error" : "Server renderer online"}
        </div>
      </header>

      <section className="device-selector" aria-label="选择模拟设备">
        {profiles.map((profile) => {
          const orientedSize = sizeForOrientation(profile.logicalSize, displayMeta.orientation);
          return (
            <button
              className="device-tab"
              data-active={profile.id === selectedProfileId}
              key={profile.id}
              onClick={() => selectProfile(profile.id)}
              type="button"
              aria-pressed={profile.id === selectedProfileId}
            >
              <span>{profile.label}</span>
              <small>
                {orientedSize.width} × {orientedSize.height} · {rasterStrategyLabel(profile)}
              </small>
            </button>
          );
        })}
      </section>

      <div className="workspace-grid">
        <section className="workspace-panel editor-panel" aria-labelledby="editor-title">
          <div className="panel-heading">
            <div>
              <div className="section-kicker"><CodeIcon /> CONTENT DOCUMENT</div>
              <h2 id="editor-title">结构化渲染内容</h2>
            </div>
            <div className="editor-actions">
              <label className="live-toggle">
                <input
                  checked={livePreview}
                  onChange={(event) => setLivePreview(event.target.checked)}
                  type="checkbox"
                />
                <span>实时预览</span>
              </label>
              <button className="ghost-button" onClick={formatDocument} type="button">格式化</button>
            </div>
          </div>
          <p className="panel-copy">
            JSON 只描述内容类型与 grid、reader、list、postcard、cardboard 这类高层组织意图；它不是固定模板，也不含坐标和尺寸。实际方向、列数、裁切、字号、分页与颜色量化由屏幕 profile 决定。
          </p>
          <section className="display-meta-panel" aria-labelledby="display-meta-title">
            <div className="display-meta-heading">
              <div>
                <h3 id="display-meta-title">全局显示参数</h3>
                <p>随请求顶层 <code>displayMeta</code> 发送，不写入内容文档。</p>
              </div>
              <span className="display-meta-value" aria-live="polite">
                {displayMeta.orientation === "portrait" ? "竖屏" : "横屏"} · {fontLevels.find((item) => item.value === displayMeta.fontLevel)?.label}
              </span>
            </div>
            <div className="display-meta-controls">
              <div className="orientation-control">
                <span className="font-level-label" id="orientation-label">屏幕方向</span>
                <div className="orientation-options" role="group" aria-labelledby="orientation-label">
                  {([
                    { value: "portrait", label: "竖屏" },
                    { value: "landscape", label: "横屏" },
                  ] as const).map((orientation) => (
                    <button
                      className="orientation-button"
                      data-active={displayMeta.orientation === orientation.value}
                      aria-pressed={displayMeta.orientation === orientation.value}
                      key={orientation.value}
                      onClick={() => selectOrientation(orientation.value)}
                      type="button"
                    >
                      {orientation.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="font-level-control">
                <span className="font-level-label" id="font-level-label">全局字号</span>
                <div className="font-level-options" role="group" aria-labelledby="font-level-label">
                  {fontLevels.map((level) => (
                    <button
                      className="font-level-button"
                      data-active={displayMeta.fontLevel === level.value}
                      aria-label={level.accessibleLabel}
                      aria-pressed={displayMeta.fontLevel === level.value}
                      key={level.value}
                      onClick={() => selectFontLevel(level.value)}
                      type="button"
                    >
                      {level.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>
          <div className="example-switcher" role="group" aria-label="载入内容示例">
            {examples.map((example) => (
              <button
                className="ghost-button example-button"
                data-active={activeExample === example.id}
                aria-pressed={activeExample === example.id}
                key={example.id}
                onClick={() => replaceDocument(example.document, example.id)}
                type="button"
              >
                {example.label}
              </button>
            ))}
          </div>
          <label className="sr-only" htmlFor="content-json">内容 JSON</label>
          <textarea
            id="content-json"
            className="json-editor"
            value={documentJson}
            onChange={(event) => replaceDocument(event.target.value, "custom")}
            spellCheck={false}
            aria-invalid={editorInvalid}
            aria-describedby="editor-feedback"
          />
          <div className="editor-footer">
            <div
              id="editor-feedback"
              className="error-message"
              data-error={Boolean(error)}
              role={error ? "alert" : "status"}
            >
              {error ? `${errorLabels[error.kind]}：${error.message}` : "Schema: inkos.content/v2 · 纯语义内容"}
            </div>
            <button
              className="primary-button"
              disabled={status === "rendering"}
              onClick={() => void renderPreview()}
              type="button"
            >
              <RefreshIcon />
              {status === "rendering" ? "正在渲染" : "渲染当前设备"}
            </button>
          </div>
        </section>

        <section className="workspace-panel preview-panel" aria-labelledby="preview-title">
          <div className="panel-heading preview-heading">
            <div>
              <div className="section-kicker">DEVICE OUTPUT</div>
              <h2 id="preview-title">{selectedProfile?.label}</h2>
            </div>
            <div className="editor-actions">
              {previewHistory.length > 0 && (
                <button
                  className="ghost-button"
                  disabled={status === "rendering"}
                  onClick={returnFromImagePreview}
                  type="button"
                >
                  返回内容
                </button>
              )}
              <div className="profile-chip" title={strategySummary}>{strategySummary}</div>
            </div>
          </div>

          <div className="device-stage">
            <div
              className={`device-frame ${deviceFrameClass}`}
              data-orientation={previewOrientation}
            >
              {isXiaozhi && <div className="xiaozhi-speaker" aria-hidden="true"><i /><i /><i /></div>}
              <div
                className="device-screen"
                data-loading={status === "rendering"}
                data-image-links={imageInteractionCount > 0}
                aria-label={imageInteractionCount > 0
                  ? `设备渲染预览，本页有 ${imageInteractionCount} 张图片可打开全屏`
                  : "设备渲染预览"}
                onClick={handleFrameClick}
                onKeyDown={handleFrameKeyDown}
                role={imageInteractionCount > 0 ? "button" : undefined}
                tabIndex={imageInteractionCount > 0 ? 0 : undefined}
                style={{
                  aspectRatio: `${previewLogicalSize.width} / ${previewLogicalSize.height}`,
                  cursor: imageInteractionCount > 0 ? "zoom-in" : undefined,
                }}
              >
                {previewUrl ? (
                  // The source is a same-origin object URL produced by the renderer API.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={previewUrl} alt={`${selectedProfile?.label} 第 ${pageIndex + 1} 页渲染预览`} />
                ) : (
                  <div className="screen-placeholder">{status === "rendering" ? "正在生成帧" : "等待首帧"}</div>
                )}
                {status === "rendering" && <div className="rendering-overlay" aria-hidden="true"><span /></div>}
              </div>
              <div className="device-wordmark">
                {isXiaozhi ? "XIAOZHI CARD" : isPaperColor ? "PAPER COLOR" : "M5STACK"}
              </div>
            </div>
          </div>

          <nav className="pagination-controls" aria-label="渲染结果分页">
            <button
              className="ghost-button"
              disabled={status === "rendering" || !pagination?.hasPrevious}
              onClick={() => selectPage(pageIndex - 1)}
              type="button"
            >
              上一页
            </button>
            <span aria-live="polite">
              第 {pagination ? pagination.pageIndex + 1 : pageIndex + 1} / {pagination?.pageCount ?? "—"} 页
              {imageInteractionCount > 0 ? " · 图片可点" : previewHistory.length > 0 ? " · 全屏图片" : ""}
            </span>
            <button
              className="ghost-button"
              disabled={status === "rendering" || !pagination?.hasNext}
              onClick={() => selectPage(pageIndex + 1)}
              type="button"
            >
              下一页
            </button>
          </nav>

          <dl className="frame-metadata">
            <div><dt>Logical</dt><dd>{previewLogicalSize.width} × {previewLogicalSize.height}</dd></div>
            <div><dt>Native</dt><dd>{previewNativeSize?.width} × {previewNativeSize?.height}</dd></div>
            <div><dt>Pixel</dt><dd>{manifest?.pixelFormat ?? selectedProfile?.pixelFormat}</dd></div>
            <div><dt>Payload</dt><dd>{formatBytes(manifest?.payloadBytes)}</dd></div>
            <div><dt>Rotation</dt><dd>{previewDisplayRotation}°</dd></div>
            <div><dt>CRC32</dt><dd>{manifest?.crc32 ?? "—"}</dd></div>
          </dl>

          {warnings.length > 0 && (
            <aside className="render-warnings" aria-live="polite">
              <strong>渲染警告 ({warnings.length})</strong>
              <ul>
                {warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}
              </ul>
            </aside>
          )}

          <div className="frame-id">FRAME <span>{manifest?.frameId ?? "pending"}</span></div>
        </section>
      </div>
    </main>
  );
}
