import type {
  ContentDocument,
  ContentImage,
  DetailBlock,
  DetailPage,
  DisplayMeta,
  ImagePage,
  LinkTarget,
  ListItem,
  ListPage,
  ReaderPage,
  RenderInteraction,
  RenderedTextRegion,
  ScreenProfile,
} from "./contracts";
import type { InkLocalWidget } from "../ink/local-widgets";
import { imageSourceKey, type ImageResolution } from "./asset-resolver";
import {
  logicalPhysicalSizeMm,
  physicalLayoutTokens,
  type PhysicalLayoutTokens,
} from "./physical-tokens";

interface TypographyTheme {
  title: number;
  subtitle: number;
  body: number;
  heading2: number;
  heading3: number;
  listTitle: number;
  listSummary: number;
  meta: number;
  footer: number;
  bodyLine: number;
  gap: number;
  footerHeight: number;
  detailImageHeight: number;
  listImageWidth: number;
  listImageHeight: number;
  listTitleLines: number;
  listSummaryLines: number;
  foreground: string;
  muted: string;
  placeholder: string;
  rule: string;
  physical: PhysicalLayoutTokens;
}

type BaseTypographyTheme = Omit<TypographyTheme, "physical">;

interface TextOptions {
  size: number;
  weight?: number;
  color?: string;
  lineHeight?: number;
  align?: "left" | "center" | "right";
  italic?: boolean;
  letterSpacing?: number;
  fontFamily?: "sans-serif" | "monospace";
  verticalAlign?: "top" | "middle";
}

interface Placement {
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PageDecorationBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

type PageDecoration = (bounds: PageDecorationBounds) => string;

interface PageState {
  body: string[];
  interactions: RenderInteraction[];
  contentPaths: Set<string>;
  textRegions: RenderedTextRegion[];
}

export interface SemanticLayoutPage {
  svg: string;
  interactions: RenderInteraction[];
  contentPaths: string[];
  textRegions: RenderedTextRegion[];
}

export interface SemanticLayoutResult {
  layoutStrategy: ScreenProfile["layoutStrategy"];
  pages: SemanticLayoutPage[];
  warnings: string[];
}

export interface SemanticLayoutOptions {
  resolvedImages?: ReadonlyMap<string, ImageResolution>;
  displayMeta?: DisplayMeta;
  /** Semantic content path -> generated document ID; bounds remain renderer-owned. */
  imageTargets?: ReadonlyMap<string, string>;
  localWidgets?: readonly InkLocalWidget[];
}

interface DeviceLayoutAdapter {
  readonly id: ScreenProfile["layoutStrategy"];
  readonly theme: BaseTypographyTheme;
  layout(
    document: ContentDocument,
    profile: ScreenProfile,
    options?: SemanticLayoutOptions,
  ): SemanticLayoutResult;
}

const PAPER_S3_THEME: BaseTypographyTheme = {
  // Values are 160-PPI renderer units. On PaperS3 they become roughly 1.47x
  // native pixels, producing a deliberate 20-25% physical-size increase over
  // the former pixel-authored theme without needlessly exploding pagination.
  title: 30,
  subtitle: 16,
  body: 18,
  heading2: 23,
  heading3: 19,
  listTitle: 19,
  listSummary: 13,
  meta: 11,
  footer: 9,
  bodyLine: 25,
  gap: 14,
  footerHeight: 19,
  detailImageHeight: 204,
  listImageWidth: 92,
  listImageHeight: 72,
  listTitleLines: 3,
  listSummaryLines: 3,
  foreground: "#111111",
  // The real 16-gray panel lifts pale tones toward paper. Keep supporting
  // copy dark enough to survive quantisation and ambient reflections.
  muted: "#555555",
  placeholder: "#EEEEEE",
  // A 2/3-pixel rule at ~50% gray remains visible without competing with
  // black text; the former #BEBEBE nearly disappeared on the photographed
  // PaperS3 panel even after increasing its physical stroke width.
  rule: "#808080",
};

const XIAOZHI_CARD_THEME: BaseTypographyTheme = {
  title: 20,
  subtitle: 12,
  body: 14,
  heading2: 17,
  heading3: 15,
  listTitle: 14,
  listSummary: 11,
  meta: 9,
  footer: 8,
  bodyLine: 18,
  gap: 8,
  footerHeight: 13,
  detailImageHeight: 72,
  listImageWidth: 42,
  listImageHeight: 42,
  listTitleLines: 3,
  listSummaryLines: 2,
  foreground: "#111111",
  muted: "#111111",
  placeholder: "#FFFFFF",
  rule: "#111111",
};

const PAPER_COLOR_THEME: BaseTypographyTheme = {
  title: 29,
  subtitle: 16,
  body: 18,
  heading2: 23,
  heading3: 20,
  listTitle: 18,
  listSummary: 13,
  meta: 11,
  footer: 9,
  bodyLine: 25,
  gap: 14,
  footerHeight: 20,
  detailImageHeight: 205,
  listImageWidth: 92,
  listImageHeight: 76,
  listTitleLines: 3,
  listSummaryLines: 2,
  foreground: "#000000",
  muted: "#0000FF",
  placeholder: "#FFFFFF",
  rule: "#FF0000",
};

const DEFAULT_DISPLAY_META: DisplayMeta = {
  invert: false,
  fontLevel: 0,
  orientation: "portrait",
};

function fontScaleForLevel(level: DisplayMeta["fontLevel"]): number {
  return ({ "-2": 0.84, "-1": 0.92, "0": 1, "1": 1.1, "2": 1.2 } as const)[level];
}

function themeWithFontLevel(
  theme: TypographyTheme,
  level: DisplayMeta["fontLevel"],
): TypographyTheme {
  if (level === 0) return theme;
  const scale = fontScaleForLevel(level);
  const scaled = (value: number) => Math.max(1, Math.round(value * scale * 10) / 10);
  return {
    ...theme,
    title: scaled(theme.title),
    subtitle: scaled(theme.subtitle),
    body: scaled(theme.body),
    heading2: scaled(theme.heading2),
    heading3: scaled(theme.heading3),
    listTitle: scaled(theme.listTitle),
    listSummary: scaled(theme.listSummary),
    meta: scaled(theme.meta),
    footer: scaled(theme.footer),
    bodyLine: scaled(theme.bodyLine),
    footerHeight: scaled(theme.footerHeight),
  };
}

function themeForScreen(
  theme: BaseTypographyTheme,
  profile: ScreenProfile,
  level: DisplayMeta["fontLevel"],
): TypographyTheme {
  const physical = physicalLayoutTokens(profile);
  const scaled = (value: number) => Math.max(
    1,
    Math.round(value * physical.densityScale * 10) / 10,
  );
  const densityAware: TypographyTheme = {
    ...theme,
    title: scaled(theme.title),
    subtitle: scaled(theme.subtitle),
    body: scaled(theme.body),
    heading2: scaled(theme.heading2),
    heading3: scaled(theme.heading3),
    listTitle: scaled(theme.listTitle),
    listSummary: scaled(theme.listSummary),
    meta: scaled(theme.meta),
    footer: scaled(theme.footer),
    bodyLine: scaled(theme.bodyLine),
    gap: scaled(theme.gap),
    footerHeight: scaled(theme.footerHeight),
    detailImageHeight: scaled(theme.detailImageHeight),
    listImageWidth: scaled(theme.listImageWidth),
    listImageHeight: scaled(theme.listImageHeight),
    physical,
  };
  return themeWithFontLevel(densityAware, level);
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function glyphWidth(character: string, size: number): number {
  if (/\s/u.test(character)) return size * 0.34;
  return /[\u2e80-\u9fff\uf900-\ufaff]/u.test(character) ? size : size * 0.56;
}

function textWidth(text: string, size: number): number {
  return [...text].reduce((total, character) => total + glyphWidth(character, size), 0);
}

function wrapText(text: string, width: number, size: number): string[] {
  const lines: string[] = [];

  for (const paragraph of text.split("\n")) {
    let line = "";
    let lineWidth = 0;

    for (const character of paragraph) {
      const characterWidth = glyphWidth(character, size);
      if (line && lineWidth + characterWidth > width) {
        const lastSpace = line.lastIndexOf(" ");
        const carry = lastSpace > 0 ? `${line.slice(lastSpace + 1)}${character}`.trimStart() : "";
        if (carry && textWidth(carry, size) <= width) {
          lines.push(line.slice(0, lastSpace).trimEnd());
          line = carry;
          lineWidth = textWidth(line, size);
        } else {
          lines.push(line.trimEnd());
          line = character.trimStart();
          lineWidth = textWidth(line, size);
        }
      } else {
        line += character;
        lineWidth += characterWidth;
      }
    }

    if (line || paragraph === "") lines.push(line.trimEnd());
  }

  return lines.length > 0 ? lines : [""];
}

function clampLines(lines: string[], maximum: number): { lines: string[]; truncated: boolean } {
  if (lines.length <= maximum) return { lines, truncated: false };
  const visible = lines.slice(0, maximum);
  const last = visible.length - 1;
  visible[last] = `${visible[last].replace(/[\s.…]+$/u, "")}…`;
  return { lines: visible, truncated: true };
}

function textSvg(text: string, x: number, y: number, width: number, options: TextOptions): string {
  const align = options.align ?? "left";
  const anchor = align === "center" ? "middle" : align === "right" ? "end" : "start";
  const positionX = align === "center" ? x + width / 2 : align === "right" ? x + width : x;
  const fontFamily = options.fontFamily === "monospace"
    ? "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    : "Noto Sans CJK SC, PingFang SC, Heiti SC, Microsoft YaHei, Arial Unicode MS, sans-serif";
  return `<text x="${positionX}" y="${y}" fill="${options.color ?? "#111111"}" font-family="${fontFamily}" font-size="${options.size}" font-weight="${options.weight ?? 400}" font-style="${options.italic ? "italic" : "normal"}" letter-spacing="${options.letterSpacing ?? 0}" text-anchor="${anchor}" dominant-baseline="hanging">${escapeXml(text)}</text>`;
}

function actionFor(target: LinkTarget): RenderInteraction["action"] {
  return target.kind === "url"
    ? { type: "open-url", url: target.url }
    : { type: "open-document", documentId: target.documentId };
}

function targetDescription(target: LinkTarget): string {
  if (target.kind === "document") return `文档 · ${target.documentId}`;
  try {
    return new URL(target.url).hostname;
  } catch {
    return target.url;
  }
}

function imageSourceLabel(image: ContentImage): string {
  if (image.source.kind === "asset") return `asset:${image.source.assetId}`;
  try {
    return `remote:${new URL(image.source.url).hostname}`;
  } catch {
    return "remote:image";
  }
}

function imageInteractionLabel(image: ContentImage): string {
  const alt = image.alt.trim();
  return (alt ? `查看大图：${alt}` : "查看大图").slice(0, 500);
}

class PageComposer {
  readonly warnings: string[] = [];
  private readonly pages: PageState[] = [{
    body: [], interactions: [], contentPaths: new Set(), textRegions: [],
  }];
  private currentPageIndex = 0;
  private y: number;
  private readonly top: number;
  private readonly left: number;
  private readonly width: number;
  private readonly bottom: number;
  private readonly bottomInset: number;

  constructor(
    private readonly profile: ScreenProfile,
    readonly theme: TypographyTheme,
    private readonly continuationTitle: string,
    private readonly resolvedImages: ReadonlyMap<string, ImageResolution> = new Map(),
    private readonly pageDecoration?: PageDecoration,
    private readonly continuationAlign: TextOptions["align"] = "left",
    private readonly imageTargets: ReadonlyMap<string, string> = new Map(),
    private readonly localWidgetPaths: ReadonlySet<string> = new Set(),
    private readonly showFooter = true,
  ) {
    this.top = Math.max(profile.safeArea.top, theme.physical.pageInset);
    this.left = Math.max(profile.safeArea.left, theme.physical.pageInset);
    const right = Math.max(profile.safeArea.right, theme.physical.pageInset);
    this.bottomInset = Math.max(profile.safeArea.bottom, theme.physical.pageInset);
    this.width = profile.logicalSize.width - this.left - right;
    this.y = this.top;
    this.bottom = profile.logicalSize.height - this.bottomInset - theme.footerHeight;
    if (this.pageDecoration) {
      this.pages[0].body.push(this.pageDecoration(this.decorationBounds()));
    }
  }

  private decorationBounds(): PageDecorationBounds {
    return {
      x: this.left,
      y: this.top,
      width: this.width,
      height: this.bottom - this.top,
    };
  }

  get contentLeft(): number {
    return this.left;
  }

  get contentWidth(): number {
    return this.width;
  }

  get cursorY(): number {
    return this.y;
  }

  get contentBottom(): number {
    return this.bottom;
  }

  warn(message: string): void {
    if (this.warnings.includes(message)) return;
    if (this.warnings.length < 32) {
      this.warnings.push(message);
    } else if (!this.warnings.includes("Additional render warnings were omitted.")) {
      this.warnings.push("Additional render warnings were omitted.");
    }
  }

  imageResolution(image: ContentImage): ImageResolution | undefined {
    return this.resolvedImages.get(imageSourceKey(image));
  }

  warnUnavailableImage(image: ContentImage, contentPath: string): void {
    const resolution = this.imageResolution(image);
    const sourceLabel = imageSourceLabel(image);
    if (image.source.kind === "asset") {
      this.warn(`${contentPath}: image '${sourceLabel}' needs an AssetResolver; rendered as a placeholder.`);
      return;
    }
    const reason = resolution?.status === "unavailable"
      ? resolution.reason
      : "the remote image was not resolved";
    this.warn(`${contentPath}: image '${sourceLabel}' could not be resolved (${reason}); rendered as a placeholder.`);
  }

  imageMarkup(
    image: ContentImage,
    x: number,
    y: number,
    width: number,
    height: number,
    contentPath: string,
    fit: "contain" | "cover" = "cover",
  ): string {
    const resolution = this.imageResolution(image);
    if (resolution?.status === "resolved") {
      const intent = image.renderIntent ?? "photo";
      return `<image data-ink-photo="${intent === "photo"}" data-ink-image-intent="${intent}" x="${x}" y="${y}" width="${width}" height="${height}" href="${resolution.image.dataUri}" preserveAspectRatio="xMidYMid ${fit === "cover" ? "slice" : "meet"}"/>`;
    }
    this.warnUnavailableImage(image, contentPath);
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${this.theme.placeholder}" stroke="${this.theme.rule}" stroke-width="${this.theme.physical.stroke.standard}"/>`;
  }

  private currentPage(): PageState {
    return this.pages[this.currentPageIndex];
  }

  private addRaw(markup: string): void {
    this.currentPage().body.push(markup);
  }

  private ensure(height: number, gapBefore = 0): number {
    if (this.y + gapBefore + height > this.bottom && this.currentPage().body.length > 0) {
      this.newPage();
      gapBefore = 0;
    }
    this.y += gapBefore;
    return this.y;
  }

  place(
    height: number,
    renderer: (y: number) => string,
    gapBefore = 0,
    contentPath?: string,
  ): Placement {
    const top = this.ensure(height, gapBefore);
    this.addRaw(renderer(top));
    if (contentPath) this.currentPage().contentPaths.add(contentPath);
    const placement = {
      pageIndex: this.currentPageIndex,
      x: this.left,
      y: top,
      width: this.width,
      height,
    };
    this.y += height;
    return placement;
  }

  placeAt(
    x: number,
    y: number,
    width: number,
    height: number,
    renderer: () => string,
    contentPath?: string,
  ): Placement {
    this.addRaw(renderer());
    if (contentPath) this.currentPage().contentPaths.add(contentPath);
    return {
      pageIndex: this.currentPageIndex,
      x,
      y,
      width,
      height,
    };
  }

  setCursorY(y: number): void {
    this.y = y;
  }

  startContinuationPage(): void {
    this.newPage();
  }

  addInteraction(
    placement: Placement,
    contentPath: string,
    target: LinkTarget,
    label: string,
  ): void {
    this.pages[placement.pageIndex].contentPaths.add(contentPath);
    const rawLeft = Math.round(placement.x);
    const rawTop = Math.round(placement.y);
    const rawRight = Math.round(placement.x + placement.width);
    const rawBottom = Math.round(placement.y + placement.height);
    const minimum = this.theme.physical.minimumTouchTarget;
    const width = Math.min(
      this.profile.logicalSize.width,
      Math.max(1, rawRight - rawLeft, minimum),
    );
    const height = Math.min(
      this.profile.logicalSize.height,
      Math.max(1, rawBottom - rawTop, minimum),
    );
    const left = Math.max(0, Math.min(
      this.profile.logicalSize.width - width,
      Math.round((rawLeft + rawRight - width) / 2),
    ));
    const top = Math.max(0, Math.min(
      this.profile.logicalSize.height - height,
      Math.round((rawTop + rawBottom - height) / 2),
    ));
    this.pages[placement.pageIndex].interactions.push({
      contentPath,
      label,
      bounds: {
        x: left,
        y: top,
        width,
        height,
      },
      action: actionFor(target),
    });
  }

  addImageInteraction(
    placement: Placement,
    contentPath: string,
    image: ContentImage,
    fit: "contain" | "cover",
  ): void {
    const targetDocumentId = this.imageTargets.get(contentPath);
    if (!targetDocumentId) return;

    let imagePlacement = placement;
    const resolution = this.imageResolution(image);
    if (fit === "contain" && resolution?.status === "resolved") {
      const scale = Math.min(
        placement.width / resolution.image.width,
        placement.height / resolution.image.height,
      );
      const width = resolution.image.width * scale;
      const height = resolution.image.height * scale;
      imagePlacement = {
        ...placement,
        x: placement.x + (placement.width - width) / 2,
        y: placement.y + (placement.height - height) / 2,
        width,
        height,
      };
    }

    this.addInteraction(
      imagePlacement,
      `${contentPath}.fullscreen`,
      { kind: "document", documentId: targetDocumentId },
      imageInteractionLabel(image),
    );
  }

  addWrappedText(
    text: string,
    options: TextOptions,
    gapBefore = 0,
    contentPath?: string,
    interactionTarget?: LinkTarget,
  ): void {
    const reservedForLocalWidget =
      contentPath !== undefined && this.localWidgetPaths.has(contentPath);
    const effectiveOptions: TextOptions = reservedForLocalWidget
      ? { ...options, fontFamily: "monospace" }
      : options;
    const lineHeight = effectiveOptions.lineHeight ?? effectiveOptions.size * 1.35;
    const lines = wrapText(text, this.width, effectiveOptions.size);
    lines.forEach((line, index) => {
      const placement = this.place(
        lineHeight,
        (y) => reservedForLocalWidget
          ? ""
          : textSvg(
              line,
              this.left,
              y + (effectiveOptions.verticalAlign === "middle"
                ? Math.max(0, (lineHeight - effectiveOptions.size * 1.2) / 2)
                : 0),
              this.width,
              effectiveOptions,
            ),
        index === 0 ? gapBefore : 0,
        contentPath,
      );
      if (contentPath) {
        const left = Math.round(placement.x);
        const top = Math.round(placement.y);
        const right = Math.round(placement.x + placement.width);
        const bottom = Math.round(placement.y + placement.height);
        this.pages[placement.pageIndex].textRegions.push({
          contentPath,
          bounds: {
            x: left,
            y: top,
            width: Math.max(1, right - left),
            height: Math.max(1, bottom - top),
          },
          style: {
            fontFamily: effectiveOptions.fontFamily ?? "sans-serif",
            fontSize: Math.round(effectiveOptions.size),
            fontWeight: effectiveOptions.weight === 700 ? 700 : 400,
            textAlign: effectiveOptions.align ?? "left",
          },
        });
      }
      if (contentPath && interactionTarget) {
        this.addInteraction(placement, contentPath, interactionTarget, text);
      }
    });
  }

  addRule(gapBefore = 0): void {
    const strokeWidth = this.theme.physical.stroke.standard;
    this.place(
      strokeWidth,
      (y) => `<line x1="${this.left}" y1="${y + strokeWidth / 2}" x2="${this.left + this.width}" y2="${y + strokeWidth / 2}" stroke="${this.theme.rule}" stroke-width="${strokeWidth}"/>`,
      gapBefore,
    );
  }

  addImage(
    image: ContentImage,
    contentPath: string,
    gapBefore = 0,
    options: {
      height?: number;
      fit?: "contain" | "cover";
      captionAlign?: TextOptions["align"];
    } = {},
  ): void {
    const imageHeight = options.height ?? Math.min(this.theme.detailImageHeight, this.width * 0.58);
    const fit = options.fit ?? "contain";
    const placement = this.place(
      imageHeight,
      (y) => {
        const imageElement = this.imageMarkup(
          image,
          this.left,
          y,
          this.width,
          imageHeight,
          contentPath,
          fit,
        );
        if (this.imageResolution(image)?.status === "resolved") return imageElement;
        const alt = clampLines(wrapText(image.alt || "图片", this.width * 0.86, this.theme.meta), 3);
        const lineHeight = this.theme.meta * 1.35;
        const firstY = y + imageHeight / 2 - (alt.lines.length * lineHeight) / 2;
        const labels = alt.lines.map((line, index) => textSvg(
          line,
          this.left + this.width * 0.07,
          firstY + index * lineHeight,
          this.width * 0.86,
          { size: this.theme.meta, color: this.theme.muted, align: "center" },
        ));
        return `${imageElement}${labels.join("")}`;
      },
      gapBefore,
      contentPath,
    );
    this.addImageInteraction(placement, contentPath, image, fit);
    if (image.caption) {
      this.addWrappedText(
        image.caption,
        { size: this.theme.meta, color: this.theme.muted, align: options.captionAlign },
        this.theme.physical.spacing.xs,
        `${contentPath}.caption`,
      );
    }
  }

  private newPage(): void {
    const page: PageState = { body: [], interactions: [], contentPaths: new Set(), textRegions: [] };
    if (this.pageDecoration) {
      page.body.push(this.pageDecoration(this.decorationBounds()));
    }
    this.pages.push(page);
    this.currentPageIndex += 1;
    this.y = this.top + (this.pageDecoration ? this.theme.gap : 0);
    if (!this.continuationTitle) return;
    const headerSize = this.theme.meta;
    const headerHeight = this.theme.meta * 1.7;
    this.addRaw(textSvg(this.continuationTitle, this.left, this.y, this.width, {
      size: headerSize,
      weight: 700,
      color: this.theme.muted,
      align: this.continuationAlign,
    }));
    this.y += headerHeight;
    this.addRule();
    this.y += this.theme.gap * 0.6;
  }

  finish(): SemanticLayoutPage[] {
    const pageCount = this.pages.length;
    return this.pages.map((page, index) => {
      const { width, height } = this.profile.logicalSize;
      const footerY = height - this.bottomInset - this.theme.footer;
      const footer = this.showFooter
        ? textSvg(`${index + 1} / ${pageCount}`, this.left, footerY, this.width, {
            size: this.theme.footer,
            color: this.theme.muted,
            weight: 700,
            align: "right",
          })
        : "";
      return {
        svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#FFFFFF"/>${page.body.join("")}${footer}</svg>`,
        interactions: page.interactions,
        contentPaths: [...page.contentPaths],
        textRegions: page.textRegions,
      };
    });
  }
}

function renderDetailBlock(
  composer: PageComposer,
  block: DetailBlock,
  contentPath: string,
  imageLed = false,
  align: TextOptions["align"] = "left",
): void {
  const { theme } = composer;

  switch (block.type) {
    case "paragraph":
      composer.addWrappedText(block.text, {
        size: theme.body,
        lineHeight: theme.bodyLine,
        color: theme.foreground,
        align,
      }, theme.gap, contentPath);
      break;
    case "heading":
      composer.addWrappedText(block.text, {
        size: block.level === 2 ? theme.heading2 : theme.heading3,
        weight: 700,
        lineHeight: (block.level === 2 ? theme.heading2 : theme.heading3) * 1.25,
        align,
      }, theme.gap * 1.3, contentPath);
      break;
    case "image":
      composer.addImage(
        block.image,
        `${contentPath}.image`,
        theme.gap,
        imageLed
          ? {
              height: Math.min(theme.detailImageHeight * 1.15, composer.contentWidth * 0.78),
              fit: "contain",
              captionAlign: align,
            }
          : { captionAlign: align },
      );
      break;
    case "list":
      block.items.forEach((item, index) => {
        const prefix = block.ordered ? `${index + 1}. ` : "• ";
        composer.addWrappedText(`${prefix}${item}`, {
          size: theme.body,
          lineHeight: theme.bodyLine,
          align,
        }, index === 0 ? theme.gap : 3, `${contentPath}.items[${index}]`);
      });
      break;
    case "link": {
      composer.addWrappedText(`↗ ${block.link.label}`, {
        size: theme.body,
        weight: 700,
        align,
      }, theme.gap, contentPath, block.link.target);
      composer.addWrappedText(block.link.description ?? targetDescription(block.link.target), {
        size: theme.meta,
        color: theme.muted,
        align,
      }, 2, contentPath, block.link.target);
      break;
    }
    case "quote":
      composer.addRule(theme.gap);
      composer.addWrappedText(`“${block.text}”`, {
        size: theme.body,
        lineHeight: theme.bodyLine,
        italic: true,
        align,
      }, theme.gap * 0.6, contentPath);
      if (block.attribution) {
        composer.addWrappedText(`— ${block.attribution}`, {
          size: theme.meta,
          color: theme.muted,
          align,
        }, 4, `${contentPath}.attribution`);
      }
      composer.addRule(theme.gap * 0.6);
      break;
  }
}

function layoutPostcard(
  page: DetailPage,
  profile: ScreenProfile,
  baseTheme: TypographyTheme,
  resolvedImages?: ReadonlyMap<string, ImageResolution>,
  imageTargets?: ReadonlyMap<string, string>,
  localWidgets: readonly InkLocalWidget[] = [],
): Omit<SemanticLayoutResult, "layoutStrategy"> {
  const landscape = profile.logicalSize.width > profile.logicalSize.height;
  // Landscape postcards have much less physical height. Keep type and touch
  // targets unchanged, but use the renderer's smaller physical spacing token
  // so a short visual message does not turn into a header-only first page.
  const theme: TypographyTheme = landscape
    ? {
        ...baseTheme,
        gap: Math.max(baseTheme.physical.spacing.sm, baseTheme.gap * 0.55),
        bodyLine: Math.max(baseTheme.body * 1.25, baseTheme.physical.spacing.lg),
      }
    : baseTheme;
  const localWidgetPaths = new Set(localWidgets.map((widget) => widget.contentPath));
  const localClockTitle = localWidgets.some((widget) =>
    widget.kind === "clock" && widget.contentPath === "page.title"
  );
  const composer = new PageComposer(
    profile,
    theme,
    page.title,
    resolvedImages,
    localClockTitle
      ? undefined
      : ({ x, y, width, height }) => `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${Math.max(theme.physical.radius.medium, Math.round(theme.gap * 0.35))}" fill="#FFFFFF" stroke="${theme.rule}" stroke-width="${theme.physical.stroke.strong}"/>`,
    "center",
    imageTargets,
    localWidgetPaths,
    !localClockTitle,
  );
  composer.setCursorY(
    composer.cursorY + (localClockTitle
      ? Math.max(theme.gap, profile.logicalSize.height * 0.12)
      : theme.gap),
  );

  if (page.eyebrow) {
    const clockDateSize = Math.max(theme.heading2, theme.subtitle * 1.4);
    composer.addWrappedText(page.eyebrow.toUpperCase(), {
      size: localClockTitle ? clockDateSize : theme.meta,
      weight: 700,
      color: localClockTitle ? theme.foreground : theme.muted,
      align: "center",
      letterSpacing: localClockTitle
        ? 0.2
        : profile.layoutStrategy === "xiaozhi-card-semantic-v1" ? 0.4 : 1.1,
    }, localClockTitle ? theme.gap * 0.25 : 0, "page.eyebrow");
  }
  if (page.heroImage) {
    composer.addImage(page.heroImage, "page.heroImage", theme.gap * 0.65, {
      height: Math.min(
        theme.detailImageHeight,
        composer.contentWidth * 0.58,
        profile.logicalSize.height * (landscape ? 0.22 : 0.36),
      ),
      fit: "contain",
      captionAlign: "center",
    });
  }
  const titleSize = localClockTitle
    ? Math.min(theme.title * 2.2, composer.contentWidth / 5.8)
    : theme.title;
  const clockRegionHeight = landscape
    ? Math.max(112, Math.min(136, Math.round(profile.logicalSize.height * 0.23)))
    : Math.max(140, Math.min(170, Math.round(profile.logicalSize.height * 0.16)));
  composer.addWrappedText(page.title, {
    size: titleSize,
    weight: localClockTitle ? 400 : 700,
    lineHeight: localClockTitle ? clockRegionHeight : titleSize * 1.18,
    align: "center",
    verticalAlign: localClockTitle ? "middle" : "top",
  }, theme.gap * 0.65, "page.title");
  if (page.summary) {
    composer.addWrappedText(page.summary, {
      size: theme.subtitle,
      color: theme.muted,
      lineHeight: theme.subtitle * 1.35,
      align: "center",
    }, theme.gap * 0.5, "page.summary");
  }
  const attribution = [page.byline, page.publishedAt].filter(Boolean).join(" · ");
  if (attribution) {
    composer.addWrappedText(attribution, {
      size: theme.meta,
      color: theme.muted,
      align: "center",
    }, theme.gap * 0.55, "page.attribution");
  }
  if (!localClockTitle) composer.addRule(theme.gap * 0.75);
  page.content.forEach((block, index) => {
    if (localClockTitle && block.type === "paragraph") {
      composer.addWrappedText(block.text, {
        size: theme.subtitle,
        color: theme.muted,
        lineHeight: theme.subtitle * 1.35,
        align: "center",
      }, theme.gap * 0.55, `page.content[${index}]`);
    } else {
      renderDetailBlock(composer, block, `page.content[${index}]`, false, "center");
    }
  });
  page.links?.forEach((link, index) => {
    renderDetailBlock(composer, { type: "link", link }, `page.links[${index}]`, false, "center");
  });

  return { pages: composer.finish(), warnings: composer.warnings };
}

function layoutDetail(
  page: DetailPage,
  profile: ScreenProfile,
  theme: TypographyTheme,
  resolvedImages?: ReadonlyMap<string, ImageResolution>,
  imageTargets?: ReadonlyMap<string, string>,
  localWidgets: readonly InkLocalWidget[] = [],
): Omit<SemanticLayoutResult, "layoutStrategy"> {
  if (page.layout === "postcard") {
    return layoutPostcard(page, profile, theme, resolvedImages, imageTargets, localWidgets);
  }
  const localWidgetPaths = new Set(localWidgets.map((widget) => widget.contentPath));
  const composer = new PageComposer(
    profile,
    theme,
    page.title,
    resolvedImages,
    undefined,
    "left",
    imageTargets,
    localWidgetPaths,
  );
  const imageLed = page.layout === "image-story";

  if (page.eyebrow) {
    composer.addWrappedText(page.eyebrow.toUpperCase(), {
      size: theme.meta,
      weight: 700,
      color: theme.muted,
      letterSpacing: profile.layoutStrategy === "xiaozhi-card-semantic-v1" ? 0.4 : 1.2,
    }, 0, "page.eyebrow");
  }
  if (imageLed && page.heroImage) {
    composer.addImage(page.heroImage, "page.heroImage", theme.gap * 0.65, {
      height: Math.min(theme.detailImageHeight * 1.22, composer.contentWidth * 0.62),
      fit: "cover",
    });
  }
  composer.addWrappedText(page.title, {
    size: theme.title,
    weight: 700,
    lineHeight: theme.title * 1.18,
  }, page.eyebrow ? theme.gap * 0.5 : 0, "page.title");
  if (page.summary) {
    composer.addWrappedText(page.summary, {
      size: theme.subtitle,
      color: theme.muted,
      lineHeight: theme.subtitle * 1.35,
    }, theme.gap * 0.6, "page.summary");
  }
  const attribution = [page.byline, page.publishedAt].filter(Boolean).join(" · ");
  if (attribution) {
    composer.addWrappedText(
      attribution,
      { size: theme.meta, color: theme.muted },
      theme.gap * 0.65,
      "page.attribution",
    );
  }
  if (page.navigation?.length) {
    renderCompactNavigation(composer, page);
  }
  if (!imageLed && page.heroImage) composer.addImage(page.heroImage, "page.heroImage", theme.gap);
  composer.addRule(theme.gap);
  page.content.forEach((block, index) => {
    renderDetailBlock(composer, block, `page.content[${index}]`, imageLed);
  });
  page.links?.forEach((link, index) => {
    renderDetailBlock(composer, { type: "link", link }, `page.links[${index}]`);
  });

  return { pages: composer.finish(), warnings: composer.warnings };
}

function layoutReader(
  page: ReaderPage,
  profile: ScreenProfile,
  theme: TypographyTheme,
): Omit<SemanticLayoutResult, "layoutStrategy"> {
  const composer = new PageComposer(profile, theme, "");
  composer.setCursorY(Math.max(0, composer.cursorY - theme.gap));
  page.content.forEach((block, index) => {
    renderDetailBlock(composer, block, `page.content[${index}]`);
  });
  return { pages: composer.finish(), warnings: composer.warnings };
}

function renderListItem(composer: PageComposer, item: ListItem, itemIndex: number): void {
  const { theme, contentLeft: left, contentWidth: width } = composer;
  const contentPath = `page.items[${itemIndex}]`;
  const showImage = Boolean(item.image);
  const imageWidth = showImage ? Math.min(theme.listImageWidth, width * 0.3) : 0;
  const imageGap = showImage ? (theme.gap * 0.7) : 0;
  const textLeft = left + imageWidth + imageGap;
  const textWidth = width - imageWidth - imageGap;
  const titleText = item.title ?? item.image?.alt ?? "图片";
  const titleResult = clampLines(wrapText(titleText, textWidth, theme.listTitle), theme.listTitleLines);
  const summaryResult = item.summary
    ? clampLines(wrapText(item.summary, textWidth, theme.listSummary), theme.listSummaryLines)
    : { lines: [] as string[], truncated: false };

  if (titleResult.truncated) composer.warn(`${contentPath}.title: shortened to fit one list row.`);
  if (summaryResult.truncated) composer.warn(`${contentPath}.summary: shortened to fit one list row.`);
  const eyebrowHeight = item.eyebrow ? theme.meta * 1.45 : 0;
  const titleLineHeight = theme.listTitle * 1.32;
  const summaryLineHeight = theme.listSummary * 1.35;
  const metadataHeight = item.metadata?.length ? theme.meta * 1.45 : 0;
  const textHeight = eyebrowHeight
    + titleResult.lines.length * titleLineHeight
    + summaryResult.lines.length * summaryLineHeight
    + metadataHeight
    + theme.gap * 0.45;
  const rowHeight = Math.max(textHeight, showImage ? theme.listImageHeight : 0);
  const imageHeight = showImage ? Math.min(theme.listImageHeight, rowHeight) : 0;

  const placement = composer.place(
    rowHeight,
    (top) => {
      const fragments: string[] = [];
      if (showImage && item.image) {
        fragments.push(composer.imageMarkup(
          item.image,
          left,
          top,
          imageWidth,
          imageHeight,
          `${contentPath}.image`,
          "cover",
        ));
        if (composer.imageResolution(item.image)?.status !== "resolved") {
          const marker = profileImageMarker(item.image);
          fragments.push(textSvg(marker, left, top + imageHeight / 2 - theme.meta * 0.6, imageWidth, {
            size: theme.meta,
            weight: 700,
            color: theme.muted,
            align: "center",
          }));
        }
      }

      let y = top;
      if (item.eyebrow) {
        fragments.push(textSvg(item.eyebrow.toUpperCase(), textLeft, y, textWidth, {
          size: theme.meta,
          weight: 700,
          color: theme.muted,
          letterSpacing: 0.4,
        }));
        y += eyebrowHeight;
      }
      for (const line of titleResult.lines) {
        fragments.push(textSvg(line, textLeft, y, textWidth, { size: theme.listTitle, weight: 700 }));
        y += titleLineHeight;
      }
      for (const line of summaryResult.lines) {
        fragments.push(textSvg(line, textLeft, y, textWidth, { size: theme.listSummary, color: theme.muted }));
        y += summaryLineHeight;
      }
      if (item.metadata?.length) {
        const metadata = item.metadata.map((entry) => `${entry.label}: ${entry.value}`).join(" · ");
        const metadataLine = clampLines(wrapText(metadata, textWidth, theme.meta), 1);
        if (metadataLine.truncated) {
          composer.warn(`${contentPath}.metadata: shortened to fit one list row.`);
        }
        fragments.push(textSvg(metadataLine.lines[0], textLeft, y, textWidth, {
          size: theme.meta,
          color: theme.muted,
        }));
      }
      if (item.link) {
        fragments.push(textSvg("↗", textLeft, top, textWidth, {
          size: Math.max(theme.meta, theme.physical.icon.small),
          weight: 700,
          align: "right",
        }));
      }
      return fragments.join("");
    },
    theme.gap,
    contentPath,
  );

  if (item.link) {
    composer.addInteraction(placement, `${contentPath}.link`, item.link.target, item.link.label);
  }
  if (item.image) {
    composer.addImageInteraction({
      pageIndex: placement.pageIndex,
      x: left,
      y: placement.y,
      width: imageWidth,
      height: imageHeight,
    }, `${contentPath}.image`, item.image, "cover");
  }
  composer.addRule(theme.gap * 0.45);
}

function profileImageMarker(image: ContentImage): string {
  return image.source.kind === "asset" ? "IMG" : "WEB";
}

function renderCompactNavigation(
  composer: PageComposer,
  page: Pick<ListPage, "navigation">,
): void {
  if (!page.navigation?.length) return;
  const { theme, contentLeft: left, contentWidth: width } = composer;
  const fontSize = Math.max(theme.meta, theme.physical.icon.small * 0.7);
  const horizontalPadding = Math.max(theme.physical.spacing.sm, Math.round(theme.gap * 0.45));
  const columnGap = Math.max(theme.physical.spacing.sm, Math.round(theme.gap * 0.35));
  const rowGap = Math.max(theme.physical.spacing.xs, Math.round(theme.gap * 0.22));
  const rowHeight = Math.max(
    theme.physical.minimumTouchTarget,
    Math.ceil(fontSize * 1.55 + theme.physical.spacing.xs),
  );
  const minimumWidth = Math.min(
    width,
    Math.max(theme.physical.minimumTouchTarget, fontSize * 3),
  );

  type NavigationPlacement = {
    index: number;
    width: number;
    displayLabel: string;
    link: NonNullable<ListPage["navigation"]>[number];
  };
  const rows: NavigationPlacement[][] = [];
  let row: NavigationPlacement[] = [];
  let usedWidth = 0;

  page.navigation.forEach((link, index) => {
    const itemWidth = Math.min(
      width,
      Math.max(minimumWidth, Math.ceil(textWidth(link.label, fontSize) + horizontalPadding * 2)),
    );
    const displayLabel = clampLines(
      wrapText(link.label, Math.max(1, itemWidth - horizontalPadding * 2), fontSize),
      1,
    ).lines[0];
    const additionalWidth = (row.length ? columnGap : 0) + itemWidth;
    if (row.length && usedWidth + additionalWidth > width) {
      rows.push(row);
      row = [];
      usedWidth = 0;
    }
    row.push({ index, width: itemWidth, displayLabel, link });
    usedWidth += (row.length > 1 ? columnGap : 0) + itemWidth;
  });
  if (row.length) rows.push(row);

  rows.forEach((items, rowIndex) => {
    const placement = composer.place(
      rowHeight,
      (top) => {
        let x = left;
        return items.map((item) => {
          const markup = [
            `<rect x="${x}" y="${top}" width="${item.width}" height="${rowHeight}" rx="${Math.max(theme.physical.radius.small, Math.round(rowHeight * 0.2))}" fill="#FFFFFF" stroke="${theme.rule}" stroke-width="${theme.physical.stroke.strong}"/>`,
            textSvg(
              item.displayLabel,
              x + horizontalPadding,
              top + Math.max(theme.physical.spacing.hair, Math.round((rowHeight - fontSize * 1.2) / 2)),
              item.width - horizontalPadding * 2,
              { size: fontSize, weight: 700, color: theme.foreground, align: "center" },
            ),
          ].join("");
          x += item.width + columnGap;
          return markup;
        }).join("");
      },
      rowIndex === 0 ? theme.gap * 0.45 : rowGap,
    );

    let x = left;
    for (const item of items) {
      composer.addInteraction({
        pageIndex: placement.pageIndex,
        x,
        y: placement.y,
        width: item.width,
        height: rowHeight,
      }, `page.navigation[${item.index}]`, item.link.target, item.link.label);
      x += item.width + columnGap;
    }
  });
}

function renderListHeader(
  composer: PageComposer,
  page: ListPage,
  profile: ScreenProfile,
  dense = false,
): void {
  const { theme } = composer;
  const compactLandscape = profile.logicalSize.width < 320
    && profile.logicalSize.width > profile.logicalSize.height;
  const denseHeader = dense || compactLandscape;
  const titleSize = denseHeader ? theme.listTitle : theme.title;
  const descriptionSize = denseHeader ? theme.meta : theme.subtitle;
  composer.addWrappedText(page.title, {
    size: titleSize,
    weight: 700,
    lineHeight: titleSize * 1.18,
  }, 0, "page.title");
  if (
    page.layout === "feed"
    && profile.layoutStrategy === "paper-s3-semantic-v1"
  ) {
    renderCompactNavigation(composer, page);
  }
  if (page.description) {
    composer.addWrappedText(page.description, {
      size: descriptionSize,
      color: theme.muted,
      lineHeight: descriptionSize * 1.3,
    }, denseHeader ? theme.physical.spacing.hair : theme.gap * 0.5, "page.description");
  }
  if (page.sourcePageInfo?.totalItems !== undefined) {
    composer.addWrappedText(
      `${page.sourcePageInfo.totalItems} 项`,
      { size: theme.meta, color: theme.muted },
      denseHeader ? theme.physical.spacing.hair : theme.gap * 0.4,
      "page.sourcePageInfo.totalItems",
    );
  }
  composer.addRule(denseHeader ? theme.physical.spacing.xs : theme.gap);
}

const DEVICE_SETTINGS_URL = "inkos://device/settings";

function renderGridHeaderWithSettings(
  composer: PageComposer,
  page: ListPage,
): boolean {
  const navigationIndex = page.navigation?.findIndex(
    (link) => link.target.kind === "url" && link.target.url === DEVICE_SETTINGS_URL,
  ) ?? -1;
  if (navigationIndex < 0 || !page.navigation) return false;

  const { theme } = composer;
  const link = page.navigation[navigationIndex];
  const top = composer.cursorY;
  const buttonSize = Math.max(theme.physical.minimumTouchTarget, theme.physical.icon.medium * 1.7);
  const gap = Math.max(theme.physical.spacing.sm, Math.round(theme.gap * 0.6));
  const titleWidth = composer.contentWidth - buttonSize - gap;
  const titleUnits = Math.max(1, textWidth(page.title, 1));
  const titleSize = Math.max(
    theme.listTitle,
    Math.min(theme.title, Math.floor(titleWidth / titleUnits)),
  );
  const headerHeight = Math.max(buttonSize, Math.ceil(titleSize * 1.3));
  const buttonX = composer.contentLeft + composer.contentWidth - buttonSize;
  const buttonY = top + (headerHeight - buttonSize) / 2;
  const iconSize = buttonSize * 0.58;
  const iconScale = iconSize / 24;
  const iconX = buttonX + (buttonSize - iconSize) / 2;
  const iconY = buttonY + (buttonSize - iconSize) / 2;
  const gearPath = "M19.43 12.98c.04-.32.07-.65.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.37-.31-.6-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98L14.5 2.42A.5.5 0 0 0 14 2h-4a.5.5 0 0 0-.49.42l-.38 2.65c-.61.25-1.17.58-1.69.98l-2.49-1a.5.5 0 0 0-.6.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65c-.05.32-.08.65-.08.98s.03.66.08.98l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46c.12.22.37.31.6.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65A.5.5 0 0 0 10 22h4a.5.5 0 0 0 .49-.42l.38-2.65c.61-.25 1.17-.58 1.69-.98l2.49 1c.23.09.48 0 .6-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65ZM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z";

  const placement = composer.placeAt(
    composer.contentLeft,
    top,
    composer.contentWidth,
    headerHeight,
    () => [
      textSvg(page.title, composer.contentLeft, top + (headerHeight - titleSize * 1.18) / 2,
        titleWidth, { size: titleSize, weight: 700 }),
      `<rect x="${buttonX}" y="${buttonY}" width="${buttonSize}" height="${buttonSize}" rx="${theme.physical.radius.medium}" fill="#FFFFFF" stroke="${theme.rule}" stroke-width="${theme.physical.stroke.strong}"/>`,
      `<path d="${gearPath}" transform="translate(${iconX} ${iconY}) scale(${iconScale})" fill="${theme.foreground}"/>`,
    ].join(""),
    "page.title",
  );
  composer.addInteraction({
    ...placement,
    x: buttonX,
    y: buttonY,
    width: buttonSize,
    height: buttonSize,
  }, `page.navigation[${navigationIndex}]`, link.target, link.label);
  composer.setCursorY(top + headerHeight);

  if (page.description) {
    composer.addWrappedText(page.description, {
      size: theme.subtitle,
      color: theme.muted,
      lineHeight: theme.subtitle * 1.3,
    }, theme.gap * 0.45, "page.description");
  }
  return true;
}

function layoutFeedList(
  page: ListPage,
  profile: ScreenProfile,
  theme: TypographyTheme,
  resolvedImages?: ReadonlyMap<string, ImageResolution>,
  imageTargets?: ReadonlyMap<string, string>,
): Omit<SemanticLayoutResult, "layoutStrategy"> {
  const composer = new PageComposer(
    profile, theme, page.title, resolvedImages, undefined, "left", imageTargets,
  );
  renderListHeader(composer, page, profile);
  page.items.forEach((item, index) => renderListItem(composer, item, index));
  return { pages: composer.finish(), warnings: composer.warnings };
}

function layoutGridList(
  page: ListPage,
  profile: ScreenProfile,
  theme: TypographyTheme,
  resolvedImages?: ReadonlyMap<string, ImageResolution>,
  imageTargets?: ReadonlyMap<string, string>,
): Omit<SemanticLayoutResult, "layoutStrategy"> {
  if (isDenseSevenColumnGrid(page)) {
    return layoutSevenColumnGrid(page, profile, theme, resolvedImages);
  }
  const composer = new PageComposer(
    profile, theme, page.title, resolvedImages, undefined, "left", imageTargets,
  );
  if (!renderGridHeaderWithSettings(composer, page)) {
    renderListHeader(composer, page, profile);
  }

  const compact = profile.logicalSize.width < 320;
  const landscape = profile.logicalSize.width > profile.logicalSize.height;
  const compactLandscape = compact && landscape;
  const physicalWidthMm = logicalPhysicalSizeMm(profile).width;
  const columnCount = compact
    ? (landscape ? 3 : 2)
    : physicalWidthMm >= 95
      ? 4
      : physicalWidthMm >= 70
        ? 3
        : 2;
  const gap = Math.max(theme.physical.spacing.sm, Math.round(theme.gap * 0.65));
  const columnWidth = (composer.contentWidth - gap * (columnCount - 1)) / columnCount;
  const hasImages = page.items.some((item) => item.image !== undefined);
  const imageHeight = hasImages ? Math.round(columnWidth * (compact ? 0.58 : 0.66)) : 0;
  const padding = compactLandscape
    ? theme.physical.spacing.hair
    : compact
      ? theme.physical.spacing.xs
      : theme.physical.spacing.sm;
  // A grid card title is a primary tap target, not supporting metadata. Using
  // the former summary size kept PaperS3 app names physically tiny even after
  // the portrait home moved to two columns. Keep compact displays conservative
  // but use the real list-title scale on high-density tablet-sized panels.
  const titleSize = compact ? Math.max(theme.meta, theme.meta + 1) : theme.listTitle;
  const summarySize = compact ? theme.meta : theme.listSummary;
  const titleLineLimit = compactLandscape ? 1 : 2;
  const summaryLineLimit = compact ? 1 : 2;
  const titleLineHeight = titleSize * 1.24;
  const summaryLineHeight = summarySize * 1.3;
  const eyebrowHeight = theme.meta * (compactLandscape ? 1.2 : 1.35);
  const metadataHeight = theme.meta * (compactLandscape ? 1.2 : 1.35);
  const cardHeight = imageHeight
    + padding * 2
    + eyebrowHeight
    + titleLineHeight * titleLineLimit
    + summaryLineHeight * summaryLineLimit
    + metadataHeight;
  let rowTop = composer.cursorY + gap;
  let column = 0;

  page.items.forEach((item, itemIndex) => {
    if (column === 0 && rowTop + cardHeight > composer.contentBottom) {
      composer.startContinuationPage();
      rowTop = composer.cursorY + gap;
    }

    const contentPath = `page.items[${itemIndex}]`;
    const x = composer.contentLeft + column * (columnWidth + gap);
    const y = rowTop;
    const innerWidth = columnWidth - padding * 2;
    const titleText = item.title ?? item.image?.alt ?? "项目";
    const title = clampLines(wrapText(titleText, innerWidth, titleSize), titleLineLimit);
    const summary = item.summary
      ? clampLines(wrapText(item.summary, innerWidth, summarySize), summaryLineLimit)
      : { lines: [] as string[], truncated: false };
    if (title.truncated) composer.warn(`${contentPath}.title: shortened to fit a grid cell.`);
    if (summary.truncated) composer.warn(`${contentPath}.summary: shortened to fit a grid cell.`);

    const placement = composer.placeAt(
      x,
      y,
      columnWidth,
      cardHeight,
      () => {
        const fragments = [
          `<rect x="${x}" y="${y}" width="${columnWidth}" height="${cardHeight}" rx="${Math.max(theme.physical.radius.small, Math.round(gap * 0.45))}" fill="#FFFFFF" stroke="${theme.rule}" stroke-width="${theme.physical.stroke.strong}"/>`,
        ];
        if (hasImages) {
          if (item.image) {
            fragments.push(composer.imageMarkup(
              item.image,
              x,
              y,
              columnWidth,
              imageHeight,
              `${contentPath}.image`,
              "cover",
            ));
          } else {
            fragments.push(`<rect x="${x}" y="${y}" width="${columnWidth}" height="${imageHeight}" fill="${theme.placeholder}"/>`);
          }
        }

        let textY = y + imageHeight + padding;
        if (item.eyebrow) {
          fragments.push(textSvg(item.eyebrow, x + padding, textY, innerWidth, {
            size: theme.meta,
            weight: 700,
            color: theme.muted,
          }));
        }
        textY += eyebrowHeight;
        for (let lineIndex = 0; lineIndex < titleLineLimit; lineIndex += 1) {
          const line = title.lines[lineIndex];
          if (line) {
            fragments.push(textSvg(line, x + padding, textY, innerWidth, {
              size: titleSize,
              weight: 700,
            }));
          }
          textY += titleLineHeight;
        }
        for (const line of summary.lines) {
          fragments.push(textSvg(line, x + padding, textY, innerWidth, {
            size: summarySize,
            color: theme.muted,
          }));
          textY += summaryLineHeight;
        }
        if (item.metadata?.length) {
          const metadataText = item.metadata.map((entry) => entry.value).join(" · ");
          const metadata = clampLines(wrapText(metadataText, innerWidth, theme.meta), 1);
          fragments.push(textSvg(metadata.lines[0], x + padding, y + cardHeight - metadataHeight, innerWidth, {
            size: theme.meta,
            color: theme.muted,
          }));
        }
        if (item.link) {
          fragments.push(textSvg("↗", x + padding, y + padding, innerWidth, {
            size: Math.max(theme.meta, theme.physical.icon.small),
            weight: 700,
            align: "right",
          }));
        }
        return fragments.join("");
      },
      contentPath,
    );

    if (item.link) {
      composer.addInteraction(placement, `${contentPath}.link`, item.link.target, item.link.label);
    }
    if (item.image) {
      composer.addImageInteraction({
        pageIndex: placement.pageIndex,
        x,
        y,
        width: columnWidth,
        height: imageHeight,
      }, `${contentPath}.image`, item.image, "cover");
    }
    column += 1;
    if (column === columnCount) {
      column = 0;
      rowTop += cardHeight + gap;
      composer.setCursorY(rowTop);
    }
  });

  if (column !== 0) composer.setCursorY(rowTop + cardHeight + gap);
  return { pages: composer.finish(), warnings: composer.warnings };
}

/**
 * A seven-column grid stays a normal list: weekday/date/time values remain
 * ordinary strings. Repeating seven eyebrow labels and at least four full rows
 * are enough for the renderer to choose this denser grid strategy without
 * adding a calendar node or coordinates to the content contract.
 */
function isDenseSevenColumnGrid(page: ListPage): boolean {
  if (page.items.length < 28 || page.items.length % 7 !== 0) return false;
  // The dense calendar treatment intentionally has no image slot. If any
  // semantic item carries an image, use the ordinary grid so that the image is
  // both visible and navigable instead of creating an unreachable preview.
  if (page.items.some((item) => item.image)) return false;
  const labels = page.items.slice(0, 7).map((item) => item.eyebrow);
  if (labels.some((label) => !label)) return false;
  return page.items.every((item, index) => item.eyebrow === labels[index % 7]);
}

function layoutSevenColumnGrid(
  page: ListPage,
  profile: ScreenProfile,
  theme: TypographyTheme,
  resolvedImages?: ReadonlyMap<string, ImageResolution>,
): Omit<SemanticLayoutResult, "layoutStrategy"> {
  const composer = new PageComposer(profile, theme, page.title, resolvedImages);
  const compact = Math.min(profile.logicalSize.width, profile.logicalSize.height) < 240;
  const landscape = profile.logicalSize.width > profile.logicalSize.height;
  renderListHeader(composer, page, profile, landscape || compact);

  const labels = page.items.slice(0, 7).map((item) => item.eyebrow ?? "");
  const gap = compact
    ? theme.physical.stroke.standard
    : Math.max(theme.physical.spacing.hair, Math.round(theme.gap * 0.22));
  const columnWidth = (composer.contentWidth - gap * 6) / 7;
  const weekdayHeight = compact ? 13 : Math.max(18, theme.meta * 1.5);
  const daySize = compact ? Math.max(8, theme.meta) : Math.max(12, theme.heading3 * 0.84);
  const detailSize = compact ? Math.max(6, theme.meta - 1) : theme.meta;
  const maximumRowHeight = compact ? (landscape ? 58 : 70) : (landscape ? 72 : 112);
  let itemIndex = 0;

  while (itemIndex < page.items.length) {
    if (itemIndex > 0) composer.startContinuationPage();

    const weekdayTop = composer.cursorY + gap;
    labels.forEach((label, column) => {
      const x = composer.contentLeft + column * (columnWidth + gap);
      composer.placeAt(
        x,
        weekdayTop,
        columnWidth,
        weekdayHeight,
        () => textSvg(label, x, weekdayTop, columnWidth, {
          size: detailSize,
          weight: 700,
          color: theme.muted,
          align: "center",
        }),
      );
    });

    const rowTop = weekdayTop + weekdayHeight + gap;
    const availableHeight = Math.max(1, composer.contentBottom - rowTop);
    const remainingWeeks = Math.ceil((page.items.length - itemIndex) / 7);
    const minimumRowHeight = compact ? (landscape ? 42 : 52) : 58;
    const rowsThatFit = Math.max(1, Math.floor(availableHeight / minimumRowHeight));
    const weeksThisPage = Math.min(remainingWeeks, rowsThatFit);
    const rowHeight = Math.min(maximumRowHeight, Math.floor((availableHeight - gap * (weeksThisPage - 1)) / weeksThisPage));
  const padding = compact ? theme.physical.spacing.hair : theme.physical.spacing.xs;

    for (let week = 0; week < weeksThisPage; week += 1) {
      const y = rowTop + week * (rowHeight + gap);
      for (let column = 0; column < 7 && itemIndex < page.items.length; column += 1) {
        const item = page.items[itemIndex];
        const contentPath = `page.items[${itemIndex}]`;
        const x = composer.contentLeft + column * (columnWidth + gap);
        const innerWidth = Math.max(1, columnWidth - padding * 2);
        const summary = item.summary
          ? clampLines(wrapText(item.summary, innerWidth, detailSize), compact ? 1 : 2)
          : { lines: [] as string[], truncated: false };
        if (summary.truncated) composer.warn(`${contentPath}.summary: shortened to fit a dense grid cell.`);
        const isToday = item.metadata?.some((entry) =>
          entry.label === "状态" && entry.value === "今天"
        ) ?? false;
        const metadata = item.metadata
          ?.filter((entry) => entry.label !== "状态")
          .map((entry) => entry.value)
          .join(" · ");
        const placement = composer.placeAt(
          x,
          y,
          columnWidth,
          rowHeight,
          () => {
            const fragments = [
              `<rect x="${x}" y="${y}" width="${columnWidth}" height="${rowHeight}" fill="${isToday ? "#444444" : "#FFFFFF"}" stroke="${isToday ? "#111111" : theme.rule}" stroke-width="${isToday ? theme.physical.stroke.strong : theme.physical.stroke.standard}"/>`,
              textSvg(item.title ?? "", x + padding, y + padding, innerWidth, {
                size: daySize,
                weight: 700,
                color: isToday ? "#FFFFFF" : theme.foreground,
                align: "center",
              }),
            ];
            let textY = y + padding + daySize * 1.35;
            for (const line of summary.lines) {
              fragments.push(textSvg(line, x + padding, textY, innerWidth, {
                size: detailSize,
                color: isToday ? "#FFFFFF" : theme.foreground,
                align: "center",
              }));
              textY += detailSize * 1.25;
            }
            if (metadata && !compact) {
              const line = clampLines(wrapText(metadata, innerWidth, detailSize), 1).lines[0];
              fragments.push(textSvg(line, x + padding, y + rowHeight - detailSize * 1.5, innerWidth, {
                size: detailSize,
                color: isToday ? "#FFFFFF" : theme.muted,
                align: "center",
              }));
            }
            return fragments.join("");
          },
          contentPath,
        );
        if (item.link) {
          composer.addInteraction(placement, `${contentPath}.link`, item.link.target, item.link.label);
        }
        itemIndex += 1;
      }
    }
    composer.setCursorY(rowTop + weeksThisPage * (rowHeight + gap));
  }

  return { pages: composer.finish(), warnings: composer.warnings };
}

function layoutCardboardList(
  page: ListPage,
  profile: ScreenProfile,
  theme: TypographyTheme,
  resolvedImages?: ReadonlyMap<string, ImageResolution>,
  imageTargets?: ReadonlyMap<string, string>,
): Omit<SemanticLayoutResult, "layoutStrategy"> {
  const composer = new PageComposer(
    profile, theme, page.title, resolvedImages, undefined, "left", imageTargets,
  );
  renderListHeader(composer, page, profile);

  const compact = profile.logicalSize.width < 320;
  const landscape = profile.logicalSize.width > profile.logicalSize.height;
  const compactLandscape = compact && landscape;
  const columnCount = compact ? (landscape ? 2 : 1) : (landscape ? 3 : 2);
  const gap = Math.max(theme.physical.spacing.sm, Math.round(theme.gap * 0.75));
  const columnWidth = (composer.contentWidth - gap * (columnCount - 1)) / columnCount;
  const padding = compactLandscape
    ? theme.physical.spacing.xs
    : compact
      ? theme.physical.spacing.sm
      : theme.physical.spacing.md;
  const titleSize = compact ? theme.listTitle : theme.heading2;
  const titleLineLimit = compactLandscape ? 1 : 2;
  const summaryLineLimit = compactLandscape ? 1 : 2;
  const titleLineHeight = titleSize * 1.16;
  const summarySize = compact ? theme.meta : theme.listSummary;
  const summaryLineHeight = summarySize * 1.3;
  const cardHeight = Math.max(
    compactLandscape ? 66 : compact ? 84 : 126,
    padding * 2
      + theme.meta * (compactLandscape ? 1.2 : 1.4)
      + titleLineHeight * titleLineLimit
      + summaryLineHeight * summaryLineLimit
      + theme.meta * (compactLandscape ? 1.15 : 1.35),
  );
  let rowTop = composer.cursorY + gap;
  let column = 0;

  page.items.forEach((item, itemIndex) => {
    if (column === 0 && rowTop + cardHeight > composer.contentBottom) {
      composer.startContinuationPage();
      rowTop = composer.cursorY + gap;
    }

    const contentPath = `page.items[${itemIndex}]`;
    const x = composer.contentLeft + column * (columnWidth + gap);
    const y = rowTop;
    const imageWidth = item.image ? Math.min(cardHeight - padding * 2, columnWidth * 0.32) : 0;
    const imageGap = item.image ? gap * 0.65 : 0;
    const textWidth = columnWidth - padding * 2 - imageWidth - imageGap;
    const textLeft = x + padding;
    const titleText = item.title ?? item.image?.alt ?? "卡片";
    const title = clampLines(wrapText(titleText, textWidth, titleSize), titleLineLimit);
    const summary = item.summary
      ? clampLines(wrapText(item.summary, textWidth, summarySize), summaryLineLimit)
      : { lines: [] as string[], truncated: false };
    if (title.truncated) composer.warn(`${contentPath}.title: shortened to fit a cardboard card.`);
    if (summary.truncated) composer.warn(`${contentPath}.summary: shortened to fit a cardboard card.`);

    const placement = composer.placeAt(
      x,
      y,
      columnWidth,
      cardHeight,
      () => {
        const fragments = [
          `<rect x="${x}" y="${y}" width="${columnWidth}" height="${cardHeight}" rx="${Math.max(theme.physical.radius.medium, Math.round(gap * 0.55))}" fill="#FFFFFF" stroke="${theme.rule}" stroke-width="${theme.physical.stroke.strong}"/>`,
        ];
        if (item.image) {
          fragments.push(composer.imageMarkup(
            item.image,
            x + columnWidth - padding - imageWidth,
            y + padding,
            imageWidth,
            cardHeight - padding * 2,
            `${contentPath}.image`,
            "contain",
          ));
        }
        let textY = y + padding;
        if (item.eyebrow) {
          fragments.push(textSvg(item.eyebrow, textLeft, textY, textWidth, {
            size: theme.meta,
            weight: 700,
            color: theme.muted,
          }));
        }
        textY += theme.meta * (compactLandscape ? 1.2 : 1.4);
        for (const line of title.lines) {
          fragments.push(textSvg(line, textLeft, textY, textWidth, {
            size: titleSize,
            weight: 700,
          }));
          textY += titleLineHeight;
        }
        for (const line of summary.lines) {
          fragments.push(textSvg(line, textLeft, textY, textWidth, {
            size: summarySize,
            color: theme.muted,
          }));
          textY += summaryLineHeight;
        }
        if (item.metadata?.length) {
          const metadataText = item.metadata.map((entry) => `${entry.label}: ${entry.value}`).join(" · ");
          const metadata = clampLines(wrapText(metadataText, textWidth, theme.meta), 1);
          fragments.push(textSvg(metadata.lines[0], textLeft, y + cardHeight - padding - theme.meta, textWidth, {
            size: theme.meta,
            color: theme.muted,
          }));
        }
        if (item.link) {
          fragments.push(textSvg("↗", textLeft, y + padding, textWidth, {
            size: Math.max(theme.meta, theme.physical.icon.small),
            weight: 700,
            align: "right",
          }));
        }
        return fragments.join("");
      },
      contentPath,
    );

    if (item.link) {
      composer.addInteraction(placement, `${contentPath}.link`, item.link.target, item.link.label);
    }
    if (item.image) {
      composer.addImageInteraction({
        pageIndex: placement.pageIndex,
        x: x + columnWidth - padding - imageWidth,
        y: y + padding,
        width: imageWidth,
        height: cardHeight - padding * 2,
      }, `${contentPath}.image`, item.image, "contain");
    }
    column += 1;
    if (column === columnCount) {
      column = 0;
      rowTop += cardHeight + gap;
      composer.setCursorY(rowTop);
    }
  });

  if (column !== 0) composer.setCursorY(rowTop + cardHeight + gap);
  return { pages: composer.finish(), warnings: composer.warnings };
}

function fallbackMasonryAspect(itemIndex: number): number {
  return [0.72, 1.42, 0.78, 0.66, 1.35, 0.74, 1.28, 0.84][itemIndex % 8];
}

function layoutMasonryList(
  page: ListPage,
  profile: ScreenProfile,
  theme: TypographyTheme,
  resolvedImages?: ReadonlyMap<string, ImageResolution>,
  imageTargets?: ReadonlyMap<string, string>,
): Omit<SemanticLayoutResult, "layoutStrategy"> {
  const composer = new PageComposer(
    profile, theme, page.title, resolvedImages, undefined, "left", imageTargets,
  );
  const landscape = profile.logicalSize.width > profile.logicalSize.height;
  renderListHeader(composer, page, profile, landscape);

  const compact = Math.min(profile.logicalSize.width, profile.logicalSize.height) < 240;
  const columnCount = compact
    ? (landscape ? 3 : 1)
    : landscape
      ? (profile.logicalSize.width >= 800 ? 4 : 3)
      : (profile.logicalSize.width >= 500 ? 3 : 2);
  const columnGap = Math.max(theme.physical.spacing.sm, Math.round(theme.gap * 0.72));
  const columnWidth = (composer.contentWidth - columnGap * (columnCount - 1)) / columnCount;
  const titleSize = compact ? theme.meta + 1 : theme.listSummary;
  const titleLineHeight = titleSize * 1.25;
  const metadataHeight = theme.meta * 1.35;
  const cardPadding = theme.physical.spacing.xs;
  let columnY = Array.from(
    { length: columnCount },
    () => composer.cursorY + theme.gap,
  );

  page.items.forEach((item, itemIndex) => {
    const contentPath = `page.items[${itemIndex}]`;
    const resolution = item.image ? composer.imageResolution(item.image) : undefined;
    const aspect = resolution?.status === "resolved"
      ? resolution.image.width / resolution.image.height
      : fallbackMasonryAspect(itemIndex);
    const imageHeight = Math.round(compact
      ? Math.max(
          columnWidth * (landscape ? 0.55 : 0.45),
          Math.min(columnWidth / Math.max(0.35, aspect), columnWidth * (landscape ? 1.15 : 0.7)),
        )
      : Math.max(
          columnWidth * (landscape ? 0.52 : 0.62),
          Math.min(columnWidth / Math.max(0.35, aspect), columnWidth * (landscape ? 1.18 : 1.48)),
        ));
    const titleText = item.title ?? item.image?.alt ?? "图片";
    const title = clampLines(wrapText(titleText, columnWidth, titleSize), compact ? 2 : 2);
    if (title.truncated) composer.warn(`${contentPath}.title: shortened to fit a masonry card.`);
    const hasMetadata = Boolean(item.metadata?.length);
    const cardHeight = imageHeight
      + theme.gap * 0.42
      + title.lines.length * titleLineHeight
      + (hasMetadata ? metadataHeight : 0)
      + theme.gap * 0.34;

    let column = columnY.reduce(
      (shortest, candidateY, candidate) => candidateY < columnY[shortest] ? candidate : shortest,
      0,
    );
    if (columnY[column] + cardHeight > composer.contentBottom) {
      composer.startContinuationPage();
      columnY = Array.from(
        { length: columnCount },
        () => composer.cursorY + theme.gap,
      );
      column = 0;
    }

    const x = composer.contentLeft + column * (columnWidth + columnGap);
    const y = columnY[column];
    const placement = composer.placeAt(
      x,
      y,
      columnWidth,
      cardHeight,
      () => {
        const fragments: string[] = [
          `<rect x="${x}" y="${y}" width="${columnWidth}" height="${cardHeight}" fill="#FFFFFF" stroke="${theme.rule}" stroke-width="${theme.physical.stroke.strong}"/>`,
        ];
        if (item.image) {
          fragments.push(composer.imageMarkup(
            item.image,
            x,
            y,
            columnWidth,
            imageHeight,
            `${contentPath}.image`,
            "cover",
          ));
          if (composer.imageResolution(item.image)?.status !== "resolved") {
            fragments.push(textSvg(
              profileImageMarker(item.image),
              x,
              y + imageHeight / 2 - theme.meta * 0.6,
              columnWidth,
              { size: theme.meta, weight: 700, color: theme.muted, align: "center" },
            ));
          }
        } else {
          fragments.push(`<rect x="${x}" y="${y}" width="${columnWidth}" height="${imageHeight}" fill="${theme.placeholder}"/>`);
        }

        let textY = y + imageHeight + theme.gap * 0.28;
        for (const line of title.lines) {
          fragments.push(textSvg(line, x + cardPadding, textY, columnWidth - cardPadding * 2, {
            size: titleSize,
            weight: 700,
          }));
          textY += titleLineHeight;
        }
        if (hasMetadata && item.metadata) {
          const metadataText = item.metadata.map((entry) => entry.value).join(" · ");
          const metadata = clampLines(
            wrapText(metadataText, columnWidth - cardPadding * 2, theme.meta),
            1,
          );
          fragments.push(textSvg(
            metadata.lines[0],
            x + cardPadding,
            textY,
            columnWidth - cardPadding * 2,
            {
              size: theme.meta,
              color: theme.muted,
            },
          ));
        }
        return fragments.join("");
      },
      contentPath,
    );

    if (item.link) {
      composer.addInteraction(placement, `${contentPath}.link`, item.link.target, item.link.label);
    }
    if (item.image) {
      composer.addImageInteraction({
        pageIndex: placement.pageIndex,
        x,
        y,
        width: columnWidth,
        height: imageHeight,
      }, `${contentPath}.image`, item.image, "cover");
    }
    columnY[column] = y + cardHeight + columnGap;
    composer.setCursorY(Math.max(...columnY));
  });

  return { pages: composer.finish(), warnings: composer.warnings };
}

function metadataValue(item: ListItem, label: string): string | undefined {
  return item.metadata?.find((entry) => entry.label === label)?.value;
}

function layoutBookshelfList(
  page: ListPage,
  profile: ScreenProfile,
  theme: TypographyTheme,
  resolvedImages?: ReadonlyMap<string, ImageResolution>,
  imageTargets?: ReadonlyMap<string, string>,
): Omit<SemanticLayoutResult, "layoutStrategy"> {
  const composer = new PageComposer(
    profile, theme, page.title, resolvedImages, undefined, "left", imageTargets,
  );
  const landscape = profile.logicalSize.width > profile.logicalSize.height;
  renderListHeader(composer, page, profile, landscape);

  const compact = Math.min(profile.logicalSize.width, profile.logicalSize.height) < 240;
  const columnCount = landscape
    ? (profile.logicalSize.width >= 800 ? 6 : profile.logicalSize.width >= 500 ? 4 : 3)
    : compact
      ? 2
      : 3;
  const columnGap = Math.max(
    theme.physical.spacing.sm,
    Math.round(theme.gap * (compact ? 0.7 : 0.85)),
  );
  const columnWidth = (composer.contentWidth - columnGap * (columnCount - 1)) / columnCount;
  const availableCardHeight = Math.max(52, composer.contentBottom - composer.cursorY - theme.gap);
  const titleSize = compact ? 10 : theme.listSummary;
  const titleLineHeight = titleSize * 1.24;
  const titleLines = compact || landscape ? 1 : 2;
  const textChromeHeight = theme.gap * 0.35
    + titleLineHeight * titleLines
    + theme.meta * 1.45
    + (compact ? theme.physical.spacing.md : theme.physical.spacing.lg)
    + theme.gap * 0.45;
  const coverHeight = Math.max(
    compact && landscape ? 38 : 64,
    Math.min(
      Math.round(columnWidth * (compact ? 1.22 : landscape ? 1.34 : 1.42)),
      Math.round(availableCardHeight - textChromeHeight),
    ),
  );
  const cardHeight = coverHeight
    + textChromeHeight;
  let rowTop = composer.cursorY + theme.gap;
  let column = 0;

  page.items.forEach((item, itemIndex) => {
    if (column === 0 && rowTop + cardHeight > composer.contentBottom) {
      composer.startContinuationPage();
      rowTop = composer.cursorY + theme.gap;
    }

    const contentPath = `page.items[${itemIndex}]`;
    const x = composer.contentLeft + column * (columnWidth + columnGap);
    const y = rowTop;
    const titleText = item.title ?? item.image?.alt ?? "未命名图书";
    const title = clampLines(wrapText(titleText, columnWidth, titleSize), titleLines);
    if (title.truncated) composer.warn(`${contentPath}.title: shortened to fit a bookshelf card.`);
    const author = metadataValue(item, "作者") ?? item.eyebrow ?? "";
    const progressText = metadataValue(item, "阅读进度");
    const parsedProgress = progressText ? Number.parseInt(progressText, 10) : 0;
    const progress = Number.isFinite(parsedProgress)
      ? Math.max(0, Math.min(100, parsedProgress)) / 100
      : 0;

    const placement = composer.placeAt(
      x,
      y,
      columnWidth,
      cardHeight,
      () => {
        const fragments: string[] = [
          `<rect x="${x}" y="${y}" width="${columnWidth}" height="${coverHeight}" fill="${theme.placeholder}" stroke="${theme.rule}" stroke-width="${theme.physical.stroke.standard}"/>`,
        ];
        if (item.image) {
          fragments.push(composer.imageMarkup(
            item.image,
            x,
            y,
            columnWidth,
            coverHeight,
            `${contentPath}.image`,
            "contain",
          ));
          if (composer.imageResolution(item.image)?.status !== "resolved") {
            fragments.push(textSvg("BOOK", x, y + coverHeight / 2 - theme.meta * 0.6, columnWidth, {
              size: theme.meta,
              weight: 700,
              color: theme.muted,
              align: "center",
            }));
          }
        } else {
          fragments.push(textSvg("BOOK", x, y + coverHeight / 2 - theme.meta * 0.6, columnWidth, {
            size: theme.meta,
            weight: 700,
            color: theme.muted,
            align: "center",
          }));
        }

        let textY = y + coverHeight + theme.gap * 0.28;
        for (let lineIndex = 0; lineIndex < titleLines; lineIndex += 1) {
          const line = title.lines[lineIndex] ?? "";
          if (line) {
            fragments.push(textSvg(line, x, textY, columnWidth, {
              size: titleSize,
              weight: 700,
            }));
          }
          textY += titleLineHeight;
        }
        if (author) {
          const authorLine = clampLines(wrapText(author, columnWidth, theme.meta), 1).lines[0];
          fragments.push(textSvg(authorLine, x, textY, columnWidth, {
            size: theme.meta,
            color: theme.muted,
          }));
        }

        const progressHeight = Math.max(theme.physical.stroke.strong, compact ? 3 : 4);
        const progressY = y + cardHeight - progressHeight - theme.physical.spacing.hair;
        fragments.push(`<rect x="${x}" y="${progressY}" width="${columnWidth}" height="${progressHeight}" fill="${theme.placeholder}" stroke="${theme.rule}" stroke-width="${theme.physical.stroke.standard}"/>`);
        if (progress > 0) {
          fragments.push(`<rect x="${x}" y="${progressY}" width="${columnWidth * progress}" height="${progressHeight}" fill="${theme.muted}"/>`);
        }
        return fragments.join("");
      },
      contentPath,
    );

    if (item.link) {
      composer.addInteraction(placement, `${contentPath}.link`, item.link.target, item.link.label);
    }
    if (item.image) {
      composer.addImageInteraction({
        pageIndex: placement.pageIndex,
        x,
        y,
        width: columnWidth,
        height: coverHeight,
      }, `${contentPath}.image`, item.image, "contain");
    }
    column += 1;
    if (column === columnCount) {
      column = 0;
      rowTop += cardHeight + columnGap;
      composer.setCursorY(rowTop);
    }
  });

  return { pages: composer.finish(), warnings: composer.warnings };
}

function layoutList(
  page: ListPage,
  profile: ScreenProfile,
  theme: TypographyTheme,
  resolvedImages?: ReadonlyMap<string, ImageResolution>,
  imageTargets?: ReadonlyMap<string, string>,
): Omit<SemanticLayoutResult, "layoutStrategy"> {
  switch (page.layout) {
    case "grid":
      return layoutGridList(page, profile, theme, resolvedImages, imageTargets);
    case "cardboard":
      return layoutCardboardList(page, profile, theme, resolvedImages, imageTargets);
    case "masonry":
      return layoutMasonryList(page, profile, theme, resolvedImages, imageTargets);
    case "bookshelf":
      return layoutBookshelfList(page, profile, theme, resolvedImages, imageTargets);
    case "feed":
    case "list":
      return layoutFeedList(page, profile, theme, resolvedImages, imageTargets);
  }
}

function layoutImage(
  page: ImagePage,
  profile: ScreenProfile,
  theme: TypographyTheme,
  resolvedImages?: ReadonlyMap<string, ImageResolution>,
): Omit<SemanticLayoutResult, "layoutStrategy"> {
  const { width, height } = profile.logicalSize;
  const resolution = resolvedImages?.get(imageSourceKey(page.image));
  const warnings: string[] = [];
  const fragments = [`<rect width="${width}" height="${height}" fill="#FFFFFF"/>`];

  if (resolution?.status === "resolved") {
    const preserveAspectRatio = page.layout === "cover" ? "xMidYMid slice" : "xMidYMid meet";
    const intent = page.image.renderIntent ?? "photo";
    fragments.push(
      `<image data-ink-photo="${intent === "photo"}" data-ink-image-intent="${intent}" x="0" y="0" width="${width}" height="${height}" href="${resolution.image.dataUri}" preserveAspectRatio="${preserveAspectRatio}"/>`,
    );

    if (page.layout === "contain") {
      const scale = Math.min(
        width / resolution.image.width,
        height / resolution.image.height,
      );
      const fittedWidth = resolution.image.width * scale;
      const fittedHeight = resolution.image.height * scale;
      const fittedX = (width - fittedWidth) / 2;
      const fittedY = (height - fittedHeight) / 2;
      fragments.push(
        `<rect x="${fittedX}" y="${fittedY}" width="${fittedWidth}" height="${fittedHeight}" fill="none" stroke="#111111" stroke-width="${theme.physical.stroke.strong}"/>`,
      );
    }
  } else {
    const sourceLabel = imageSourceLabel(page.image);
    const reason = page.image.source.kind === "asset"
      ? "needs an AssetResolver"
      : `could not be resolved (${resolution?.status === "unavailable" ? resolution.reason : "the remote image was not resolved"})`;
    warnings.push(`page.image: image '${sourceLabel}' ${reason}; rendered as a placeholder.`);
    fragments.push(
      `<rect x="0" y="0" width="${width}" height="${height}" fill="${theme.placeholder}" stroke="${theme.rule}" stroke-width="${theme.physical.stroke.standard}"/>`,
    );
    const altLines = clampLines(wrapText(page.image.alt || "图片", width * 0.8, theme.meta), 4);
    const lineHeight = theme.meta * 1.35;
    const firstY = height / 2 - altLines.lines.length * lineHeight / 2;
    altLines.lines.forEach((line, index) => {
      fragments.push(textSvg(line, width * 0.1, firstY + index * lineHeight, width * 0.8, {
        size: theme.meta,
        weight: 700,
        color: theme.muted,
        align: "center",
      }));
    });
  }

  const interactions: RenderInteraction[] = page.link
    ? [{
        contentPath: "page.link",
        label: page.link.label,
        bounds: { x: 0, y: 0, width, height },
        action: actionFor(page.link.target),
      }]
    : [];

  return {
    pages: [{
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" overflow="hidden">${fragments.join("")}</svg>`,
      interactions,
      contentPaths: ["page.image"],
      textRegions: [],
    }],
    warnings,
  };
}

class SemanticDeviceAdapter implements DeviceLayoutAdapter {
  constructor(
    readonly id: ScreenProfile["layoutStrategy"],
    readonly theme: BaseTypographyTheme,
  ) {}

  layout(
    document: ContentDocument,
    profile: ScreenProfile,
    options: SemanticLayoutOptions = {},
  ): SemanticLayoutResult {
    const displayMeta = options.displayMeta ?? DEFAULT_DISPLAY_META;
    const theme = themeForScreen(this.theme, profile, displayMeta.fontLevel);
    let result: Omit<SemanticLayoutResult, "layoutStrategy">;
    switch (document.page.kind) {
      case "detail":
        result = layoutDetail(
          document.page,
          profile,
          theme,
          options.resolvedImages,
          options.imageTargets,
          options.localWidgets,
        );
        break;
      case "list":
        result = layoutList(
          document.page,
          profile,
          theme,
          options.resolvedImages,
          options.imageTargets,
        );
        break;
      case "reader":
        result = layoutReader(document.page, profile, theme);
        break;
      case "image":
        result = layoutImage(document.page, profile, theme, options.resolvedImages);
        break;
    }
    return { layoutStrategy: this.id, ...result };
  }
}

export class LayoutStrategyRegistry {
  private readonly adapters = new Map<ScreenProfile["layoutStrategy"], DeviceLayoutAdapter>();

  constructor(adapters: DeviceLayoutAdapter[]) {
    for (const adapter of adapters) this.adapters.set(adapter.id, adapter);
  }

  resolve(profile: ScreenProfile): DeviceLayoutAdapter {
    const adapter = this.adapters.get(profile.layoutStrategy);
    if (!adapter) throw new Error(`No layout strategy registered for ${profile.layoutStrategy}`);
    return adapter;
  }
}

export const defaultLayoutStrategyRegistry = new LayoutStrategyRegistry([
  new SemanticDeviceAdapter("paper-s3-semantic-v1", PAPER_S3_THEME),
  new SemanticDeviceAdapter("xiaozhi-card-semantic-v1", XIAOZHI_CARD_THEME),
  new SemanticDeviceAdapter("paper-color-semantic-v1", PAPER_COLOR_THEME),
]);

export function layoutSemanticDocument(
  document: ContentDocument,
  profile: ScreenProfile,
  options: SemanticLayoutOptions = {},
  registry: LayoutStrategyRegistry = defaultLayoutStrategyRegistry,
): SemanticLayoutResult {
  return registry.resolve(profile).layout(document, profile, options);
}
