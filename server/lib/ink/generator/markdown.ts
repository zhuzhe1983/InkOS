import { load } from "cheerio";
import { marked, type Token, type Tokens } from "marked";
import TurndownService from "turndown";

import { isDecorativeImage } from "./decorative-image";

const MAX_BLOCKS = 256;
const MAX_IMAGES = 24;
const MAX_TEXT_CHARACTERS = 240_000;
const MAX_LINKS = 512;

export type MarkdownSemanticBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "quote"; text: string; attribution?: string }
  | { type: "link"; link: { label: string; url: string } }
  | {
      type: "image";
      image: { url: string; alt: string; caption?: string };
    };

export interface MarkdownDocumentLink {
  label: string;
  url: string;
}

export interface MarkdownConversionStats {
  inputHtmlCharacters: number;
  markdownCharacters: number;
  textCharacters: number;
  blockCount: number;
  imageCount: number;
  linkCount: number;
  rootSelector:
    | ".mw-parser-output"
    | "[itemprop='articleBody']"
    | ".article-body"
    | ".article__main__content"
    | ".article-content"
    | ".post-content"
    | ".entry-content"
    | ".post-body"
    | ".story-body"
    | "main"
    | "article"
    | "[role='main']"
    | "body";
  truncated: boolean;
}

export interface RenderedHtmlMarkdownResult {
  markdown: string;
  blocks: MarkdownSemanticBlock[];
  links: MarkdownDocumentLink[];
  stats: MarkdownConversionStats;
}

export interface HtmlSemanticOptions {
  /**
   * A rendered page needs editorial-root selection. Feed content has already
   * been scoped by the RSS/Atom entry and must keep the complete fragment.
   */
  mode?: "rendered-page" | "feed-fragment";
}

type InlineSegment =
  | { type: "text"; value: string }
  | { type: "image"; url: string; alt: string; caption?: string };

/**
 * Common semantic article-body hooks used by editorial/CMS pages. Chromium
 * has already executed the page at this point, so these containers are a
 * stronger signal than the surrounding `article` shell, which often starts
 * with author cards, share controls and recommendations. The list stays
 * deliberately structural rather than host-specific.
 */
const ARTICLE_BODY_SELECTORS = [
  "[itemprop='articleBody']",
  ".article-body",
  ".article__main__content",
  ".article-content",
  ".post-content",
  ".entry-content",
  ".post-body",
  ".story-body",
] as const satisfies readonly MarkdownConversionStats["rootSelector"][];

// HTML5 permits an anchor to wrap an entire card. Turndown normally keeps the
// blank lines emitted by descendants such as div/p/figure, producing invalid
// Markdown in the form "[\n\n...\n\n](url)". Only these genuinely block-level
// descendants opt into the flattened link rule below; ordinary inline links
// keep Turndown's native formatting.
const BLOCK_LINK_DESCENDANT_SELECTOR = [
  "address",
  "article",
  "aside",
  "blockquote",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "ul",
].join(",");

const EDITORIAL_BOILERPLATE_PATTERN = /(?:\b(?:advertisement|affiliate disclosure|sponsored content)\b|利益相关声明|首页推荐|文章代表(?:作者)?个人观点|仅对标题和排版)/iu;

function normalizedText(value: string, maxLength?: number): string {
  const normalized = value.replace(/[\s\u00a0]+/gu, " ").trim();
  return maxLength === undefined || normalized.length <= maxLength
    ? normalized
    : normalized.slice(0, maxLength).trimEnd();
}

function markdownLinkDestination(value: string): string {
  const escaped = value.replace(/([<>()])/gu, "\\$1");
  return escaped.includes(" ") ? `<${escaped}>` : escaped;
}

function markdownLinkTitle(value: string | null): string {
  const title = value?.replace(/(\n+\s*)+/gu, "\n").replace(/"/gu, '\\"') ?? "";
  return title ? ` "${title}"` : "";
}

function absoluteHttpUrl(value: string | null | undefined, baseUrl: URL): string | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;

  try {
    const url = new URL(candidate, baseUrl);
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

function firstSrcsetUrl(value: string | null | undefined): string | undefined {
  const firstCandidate = value?.split(",", 1)[0]?.trim();
  if (!firstCandidate) return undefined;
  return firstCandidate.split(/\s+/u, 1)[0];
}

function appendTextSegment(segments: InlineSegment[], value: string): void {
  if (!value) return;
  const previous = segments.at(-1);
  if (previous?.type === "text") {
    previous.value += value;
  } else {
    segments.push({ type: "text", value });
  }
}

function inlineSegments(tokens: readonly Token[] | undefined, baseUrl: URL): InlineSegment[] {
  const segments: InlineSegment[] = [];

  const visit = (token: Token): void => {
    if (token.type === "image") {
      const image = token as Tokens.Image;
      const url = absoluteHttpUrl(image.href, baseUrl);
      if (url) {
        segments.push({
          type: "image",
          url,
          alt: normalizedText(image.text, 2_000),
          ...(image.title ? { caption: normalizedText(image.title, 2_000) } : {}),
        });
      }
      return;
    }

    if (token.type === "br") {
      appendTextSegment(segments, " ");
      return;
    }

    if ("tokens" in token && Array.isArray(token.tokens) && token.tokens.length > 0) {
      token.tokens.forEach(visit);
      return;
    }

    if (token.type === "text" || token.type === "escape" || token.type === "codespan") {
      appendTextSegment(segments, token.text);
      return;
    }

    if (token.type === "html") return;
    if ("text" in token && typeof token.text === "string") {
      appendTextSegment(segments, token.text);
    }
  };

  tokens?.forEach(visit);
  return segments;
}

function inlineCompositeText(tokens: readonly Token[] | undefined, baseUrl: URL): string {
  return normalizedText(
    inlineSegments(tokens, baseUrl)
      .map((segment) => segment.type === "text" ? segment.value : segment.alt)
      .join(" "),
  );
}

function semanticLinkFromToken(
  token: Tokens.Link,
  baseUrl: URL,
): { label: string; url: string; visibleText: string } | undefined {
  const url = absoluteHttpUrl(token.href, baseUrl);
  if (!url) return undefined;
  const segments = inlineSegments(token.tokens, baseUrl);
  const visibleText = normalizedText(
    segments
      .filter((segment): segment is Extract<InlineSegment, { type: "text" }> =>
        segment.type === "text"
      )
      .map((segment) => segment.value)
      .join(" "),
    2_000,
  );
  const compositeLabel = normalizedText(
    segments
      .map((segment) => segment.type === "text" ? segment.value : segment.alt)
      .join(" "),
    2_000,
  );
  return { label: compositeLabel || url, url, visibleText };
}

function standaloneLinkToken(
  tokens: readonly Token[] | undefined,
): Tokens.Link | undefined {
  const meaningful = tokens?.filter((token) => {
    if (token.type === "space") return false;
    return token.type !== "text" || normalizedText(token.text).length > 0;
  }) ?? [];
  return meaningful.length === 1 && meaningful[0].type === "link"
    ? meaningful[0] as Tokens.Link
    : undefined;
}

function blockTokenText(tokens: readonly Token[], baseUrl: URL): string {
  const parts: string[] = [];
  for (const token of tokens) {
    if (token.type === "space") continue;
    if (token.type === "list") {
      const nestedItems = (token as Tokens.List).items
        .map((item) => blockTokenText(item.tokens, baseUrl))
        .filter(Boolean);
      if (nestedItems.length) parts.push(nestedItems.join("；"));
      continue;
    }
    if (token.type === "paragraph" || token.type === "text" || token.type === "heading") {
      const text = normalizedText(
        inlineSegments(token.tokens, baseUrl)
          .filter((segment): segment is Extract<InlineSegment, { type: "text" }> => segment.type === "text")
          .map((segment) => segment.value)
          .join(" "),
      );
      if (text) parts.push(text);
      continue;
    }
    if (token.type === "code") {
      const text = normalizedText(token.text);
      if (text) parts.push(text);
      continue;
    }
    if ("tokens" in token && Array.isArray(token.tokens)) {
      const text = blockTokenText(token.tokens, baseUrl);
      if (text) parts.push(text);
    } else if ("text" in token && typeof token.text === "string") {
      const text = normalizedText(token.text);
      if (text) parts.push(text);
    }
  }
  return normalizedText(parts.join(" "));
}

function imagesInTokens(tokens: readonly Token[] | undefined, baseUrl: URL): InlineSegment[] {
  const images: InlineSegment[] = [];
  const visit = (token: Token): void => {
    if (token.type === "image") {
      const segment = inlineSegments([token], baseUrl)[0];
      if (segment?.type === "image") images.push(segment);
      return;
    }
    if (token.type === "list") {
      const list = token as Tokens.List;
      list.items.forEach((item) => item.tokens.forEach(visit));
      return;
    }
    if (token.type === "table") {
      const table = token as Tokens.Table;
      [...table.header, ...table.rows.flat()]
        .forEach((cell) => cell.tokens.forEach(visit));
      return;
    }
    if ("tokens" in token && Array.isArray(token.tokens)) token.tokens.forEach(visit);
  };
  tokens?.forEach(visit);
  return images;
}

function semanticTextCharacters(block: MarkdownSemanticBlock): number {
  switch (block.type) {
    case "heading":
    case "paragraph":
      return block.text.length;
    case "list":
      return block.items.reduce((sum, item) => sum + item.length, 0);
    case "quote":
      return block.text.length + (block.attribution?.length ?? 0);
    case "link":
      return block.link.label.length;
    case "image":
      return 0;
  }
}

function truncateTextBlock(
  block: Exclude<MarkdownSemanticBlock, { type: "image" }>,
  available: number,
): Exclude<MarkdownSemanticBlock, { type: "image" }> | undefined {
  if (available <= 0) return undefined;
  if (block.type === "heading" || block.type === "paragraph") {
    const text = block.text.slice(0, available).trimEnd();
    return text ? { ...block, text } : undefined;
  }
  if (block.type === "quote") {
    const text = block.text.slice(0, available).trimEnd();
    if (!text) return undefined;
    const remaining = available - text.length;
    const attribution = remaining > 0 ? block.attribution?.slice(0, remaining).trimEnd() : undefined;
    return { type: "quote", text, ...(attribution ? { attribution } : {}) };
  }
  if (block.type === "link") {
    const label = block.link.label.slice(0, available).trimEnd();
    return label
      ? { type: "link", link: { ...block.link, label } }
      : undefined;
  }

  const items: string[] = [];
  let remaining = available;
  for (const item of block.items) {
    if (remaining <= 0) break;
    const next = item.slice(0, remaining).trimEnd();
    if (next) items.push(next);
    remaining -= next.length;
    if (next.length < item.length) break;
  }
  return items.length ? { ...block, items } : undefined;
}

function markdownToSemantic(
  markdown: string,
  baseUrl: URL,
): {
  blocks: MarkdownSemanticBlock[];
  links: MarkdownDocumentLink[];
  textCharacters: number;
  imageCount: number;
  truncated: boolean;
} {
  const tokens = marked.lexer(markdown, { gfm: true });
  const blocks: MarkdownSemanticBlock[] = [];
  const links: MarkdownDocumentLink[] = [];
  const linkIndexByUrl = new Map<string, number>();
  const linkLabelQuality: number[] = [];
  let textCharacters = 0;
  let imageCount = 0;
  let textBudgetExhausted = false;
  let truncated = false;

  const push = (block: MarkdownSemanticBlock): void => {
    if (blocks.length >= MAX_BLOCKS) {
      truncated = true;
      return;
    }
    if (block.type === "image") {
      if (imageCount >= MAX_IMAGES) {
        truncated = true;
        return;
      }
      imageCount += 1;
      blocks.push(block);
      return;
    }
    if (textBudgetExhausted) {
      truncated = true;
      return;
    }

    const characters = semanticTextCharacters(block);
    const available = MAX_TEXT_CHARACTERS - textCharacters;
    if (characters <= available) {
      textCharacters += characters;
      blocks.push(block);
      return;
    }

    const limited = truncateTextBlock(block, available);
    if (limited) {
      textCharacters += semanticTextCharacters(limited);
      blocks.push(limited);
    }
    textBudgetExhausted = true;
    truncated = true;
  };

  const pushImage = (segment: Extract<InlineSegment, { type: "image" }>): void => {
    push({
      type: "image",
      image: {
        url: segment.url,
        alt: segment.alt,
        ...(segment.caption ? { caption: segment.caption } : {}),
      },
    });
  };

  const collectLink = (token: Token): void => {
    if (token.type === "link") {
      const semanticLink = semanticLinkFromToken(token as Tokens.Link, baseUrl);
      if (semanticLink) {
        const { label, url, visibleText } = semanticLink;
        // One destination may be represented first by a cover/icon and later
        // by a prominent textual action. Keep one deterministic interaction,
        // but let visible anchor text replace image-derived or URL fallback
        // labels so the user's actual call to action survives URL deduplication.
        const quality = visibleText ? 2 : label !== url ? 1 : 0;
        const existingIndex = linkIndexByUrl.get(url);
        if (existingIndex !== undefined) {
          if (quality > (linkLabelQuality[existingIndex] ?? 0)) {
            links[existingIndex] = { label, url };
            linkLabelQuality[existingIndex] = quality;
          }
        } else if (links.length >= MAX_LINKS) {
          truncated = true;
        } else {
          linkIndexByUrl.set(url, links.length);
          linkLabelQuality.push(quality);
          links.push({ label, url });
        }
      }
    }
    if (token.type === "list") {
      const list = token as Tokens.List;
      list.items.forEach((item) => item.tokens.forEach(collectLink));
      return;
    }
    if (token.type === "table") {
      const table = token as Tokens.Table;
      [...table.header, ...table.rows.flat()]
        .forEach((cell) => cell.tokens.forEach(collectLink));
      return;
    }
    if ("tokens" in token && Array.isArray(token.tokens)) token.tokens.forEach(collectLink);
  };
  tokens.forEach(collectLink);

  for (const token of tokens) {
    if (blocks.length >= MAX_BLOCKS) {
      truncated = true;
      break;
    }

    if (token.type === "heading") {
      const segments = inlineSegments(token.tokens, baseUrl);
      const text = normalizedText(
        segments
          .filter((segment): segment is Extract<InlineSegment, { type: "text" }> => segment.type === "text")
          .map((segment) => segment.value)
          .join(" "),
      );
      if (text) {
        push({
          type: "heading",
          level: Math.min(6, Math.max(1, token.depth)) as 1 | 2 | 3 | 4 | 5 | 6,
          text,
        });
      }
      segments.filter((segment): segment is Extract<InlineSegment, { type: "image" }> => segment.type === "image")
        .forEach(pushImage);
      continue;
    }

    if (token.type === "paragraph" || token.type === "text") {
      const actionToken = standaloneLinkToken(token.tokens);
      const action = actionToken
        ? semanticLinkFromToken(actionToken, baseUrl)
        : undefined;
      if (actionToken && action) {
        inlineSegments(actionToken.tokens, baseUrl)
          .filter((segment): segment is Extract<InlineSegment, { type: "image" }> =>
            segment.type === "image"
          )
          .forEach(pushImage);
        push({
          type: "link",
          link: { label: action.label, url: action.url },
        });
        continue;
      }
      const segments = inlineSegments(token.tokens, baseUrl);
      for (const segment of segments) {
        if (segment.type === "image") {
          pushImage(segment);
        } else {
          const text = normalizedText(segment.value);
          if (text) push({ type: "paragraph", text });
        }
      }
      continue;
    }

    if (token.type === "table") {
      const table = token as Tokens.Table;
      const headers = table.header.map((cell) =>
        inlineCompositeText(cell.tokens, baseUrl)
      );
      const items = table.rows.map((row) => normalizedText(
        row.map((cell, index) => {
          const value = inlineCompositeText(cell.tokens, baseUrl);
          const header = headers[index] ?? "";
          if (header && value) return `${header}：${value}`;
          return value || header;
        }).filter(Boolean).join("；"),
      )).filter(Boolean);
      if (items.length) {
        push({ type: "list", ordered: false, items });
      } else {
        const headerText = normalizedText(headers.filter(Boolean).join("；"));
        if (headerText) push({ type: "paragraph", text: headerText });
      }
      imagesInTokens([table], baseUrl)
        .filter((segment): segment is Extract<InlineSegment, { type: "image" }> =>
          segment.type === "image"
        )
        .forEach(pushImage);
      continue;
    }

    if (token.type === "list") {
      const list = token as Tokens.List;
      const items = list.items
        .map((item) => blockTokenText(item.tokens, baseUrl))
        .filter(Boolean);
      if (items.length) push({ type: "list", ordered: list.ordered, items });
      imagesInTokens(list.items.flatMap((item) => item.tokens), baseUrl)
        .filter((segment): segment is Extract<InlineSegment, { type: "image" }> => segment.type === "image")
        .forEach(pushImage);
      continue;
    }

    if (token.type === "blockquote") {
      const blockquote = token as Tokens.Blockquote;
      const parts = blockquote.tokens
        .filter((child) => child.type !== "space")
        .map((child) => blockTokenText([child], baseUrl))
        .filter(Boolean);
      let attribution: string | undefined;
      const finalPart = parts.at(-1);
      if (finalPart?.startsWith("— ")) {
        attribution = normalizedText(finalPart.slice(2));
        parts.pop();
      }
      const text = normalizedText(parts.join(" "));
      if (text) push({ type: "quote", text, ...(attribution ? { attribution } : {}) });
      imagesInTokens(blockquote.tokens, baseUrl)
        .filter((segment): segment is Extract<InlineSegment, { type: "image" }> => segment.type === "image")
        .forEach(pushImage);
      continue;
    }

    if (token.type === "code") {
      const text = token.text
        .replace(/\r\n?/gu, "\n")
        .replace(/[ \t]+\n/gu, "\n")
        .trim();
      if (text) push({ type: "paragraph", text });
    }
  }

  return { blocks, links, textCharacters, imageCount, truncated };
}

/**
 * Converts Chromium's final rendered HTML into a transport-neutral Markdown
 * document and the semantic blocks consumed by InkOS. The conversion is
 * deliberately deterministic: it neither executes page code nor calls an LLM.
 */
export function renderedHtmlToMarkdown(
  html: string,
  baseUrlInput: URL | string,
  options: HtmlSemanticOptions = {},
): RenderedHtmlMarkdownResult {
  const baseUrl = baseUrlInput instanceof URL ? new URL(baseUrlInput.href) : new URL(baseUrlInput);
  const mode = options.mode ?? "rendered-page";
  const $ = load(html, { scriptingEnabled: false });

  $(
    "script,style,noscript,template,iframe,object,embed,form,input,button,select,textarea," +
    "svg,canvas,video,audio,.mw-editsection,.reference,.reflist,.mw-references-wrap,.navbox,.metadata,.noprint",
  ).remove();
  $("[hidden],[aria-hidden='true'],[aria-hidden='TRUE']").remove();
  $("[style]").each((_, element) => {
    const inlineStyle = ($(element).attr("style") ?? "").replace(/\s+/gu, "");
    if (/(?:^|;)(?:display:none|visibility:hidden)(?:;|$)/iu.test(inlineStyle)) {
      $(element).remove();
    }
  });

  $("a[href]").each((_, element) => {
    const anchor = $(element);
    const url = absoluteHttpUrl(anchor.attr("href"), baseUrl);
    if (url) anchor.attr("href", url);
    else anchor.removeAttr("href");
  });

  $("img").each((_, element) => {
    const image = $(element);
    const renderedCollapsed = image.attr("data-ink-rendered-width") === "0"
      || image.attr("data-ink-rendered-height") === "0";
    const pictureCandidates: Array<string | undefined> = [];
    image.closest("picture").children("source").each((__, sourceElement) => {
      const source = $(sourceElement);
      pictureCandidates.push(
        firstSrcsetUrl(source.attr("data-srcset")),
        firstSrcsetUrl(source.attr("srcset")),
        source.attr("data-src"),
        source.attr("src"),
      );
    });
    const renderedCurrentCandidates = [image.attr("data-current-src")];
    const fallbackCandidates = [image.attr("src")];
    const lazyCandidates = [
      image.attr("data-src"),
      image.attr("data-original"),
      firstSrcsetUrl(image.attr("data-srcset")),
      firstSrcsetUrl(image.attr("srcset")),
    ];
    // currentSrc is authoritative after a real render. A collapsed lazy image
    // commonly still points at a transparent placeholder, so prefer its
    // deferred source attributes until it receives a rendered box.
    const candidates = renderedCollapsed
      ? [...lazyCandidates, ...pictureCandidates, ...renderedCurrentCandidates, ...fallbackCandidates]
      : [...renderedCurrentCandidates, ...pictureCandidates, ...fallbackCandidates, ...lazyCandidates];
    const url = candidates
      .map((candidate) => absoluteHttpUrl(candidate, baseUrl))
      .find((candidate): candidate is string => Boolean(candidate));
    if (!url) {
      image.remove();
      return;
    }
    if (isDecorativeImage({
      alt: image.attr("alt"),
      ariaHidden: image.attr("aria-hidden"),
      caption: image.closest("figure").find("figcaption").first().text(),
      className: image.attr("class"),
      height: image.attr("height"),
      id: image.attr("id"),
      parentClassName: image.parent().attr("class"),
      renderedHeight: image.attr("data-ink-rendered-height"),
      renderedHidden: image.attr("data-ink-rendered-hidden"),
      renderedWidth: image.attr("data-ink-rendered-width"),
      role: image.attr("role"),
      source: url,
      width: image.attr("width"),
    })) {
      image.remove();
      return;
    }
    image.attr("src", url);
    image.removeAttr("srcset");
    image.removeAttr("data-srcset");
  });

  $("blockquote").each((_, element) => {
    const quote = $(element);
    const attributionNode = quote.find("cite,footer").first();
    const attribution = normalizedText(attributionNode.text(), 2_000);
    if (attribution) quote.attr("data-ink-attribution", attribution);
    quote.find("cite,footer").remove();
  });

  $("figure").each((_, element) => {
    const figure = $(element);
    const caption = normalizedText(figure.find("figcaption").first().text(), 2_000);
    if (caption) figure.find("img").first().attr("title", caption);
    figure.find("figcaption").remove();
  });

  let rootSelector: MarkdownConversionStats["rootSelector"] = "body";
  let root = mode === "feed-fragment"
    ? $("body").first()
    : $(".mw-parser-output").first();
  if (mode === "rendered-page" && root.length) {
    rootSelector = ".mw-parser-output";
  } else if (mode === "rendered-page") {
    // Pick the most substantial explicit prose container. Some pages contain
    // several article cards after the real story, so `.first()` alone is not
    // sufficient. An 80-character/text-or-image floor avoids selecting tiny
    // teaser widgets that happen to reuse a CMS class name.
    let proseRoot = $("inkos-no-such-element");
    let proseRootSelector: MarkdownConversionStats["rootSelector"] | undefined;
    let proseRootScore = -1;
    for (const selector of ARTICLE_BODY_SELECTORS) {
      $(selector).each((_, element) => {
        const candidate = $(element);
        const textLength = normalizedText(candidate.text()).length;
        const imageCount = candidate.find("img").length;
        if (textLength < 80 && imageCount === 0) return;
        const score = textLength + Math.min(imageCount, 8) * 160;
        const currentElement = proseRoot.get(0);
        const candidateElement = candidate.get(0);
        const candidateIsSubstantialNestedRoot = Boolean(
          currentElement
          && candidateElement
          && candidate.parents().toArray().includes(currentElement)
          && score >= proseRootScore * 0.35,
        );
        const currentIsNestedInsideCandidate = Boolean(
          currentElement
          && candidateElement
          && proseRoot.parents().toArray().includes(candidateElement),
        );
        // Prefer a deeper body hook when it retains a meaningful share of the
        // wrapper's content. This drops disclosure/header wrappers such as
        // `.article-body > .article__main__content`, without letting a single
        // long nested paragraph replace the complete story.
        if (!candidateIsSubstantialNestedRoot && (currentIsNestedInsideCandidate || score <= proseRootScore)) return;
        proseRoot = candidate;
        proseRootSelector = selector;
        proseRootScore = score;
      });
    }

    if (proseRoot.length && proseRootSelector) {
      root = proseRoot;
      rootSelector = proseRootSelector;
    } else {
      const candidates = ["main", "article", "[role='main']"] as const;
      for (const selector of candidates) {
        root = $(selector).first();
        if (root.length) {
          rootSelector = selector;
          break;
        }
      }
    }
  }
  if (!root.length) root = $("body").first();

  // Breadcrumbs are navigation metadata even when schema.org marks each
  // crumb as an itemListElement. On body-root pages, page-level header/footer
  // chrome is likewise not reading content and can otherwise crowd out the
  // primary actions that follow it.
  root.find(
    ".breadcrumb,[aria-label='breadcrumb'],[itemtype$='BreadcrumbList']",
  ).remove();
  if (mode === "rendered-page" && rootSelector === "body") {
    root.find("header,footer").remove();
  }

  // Editorial CMSes commonly place a disclosure/community-recommendation
  // notice before an early horizontal rule inside the otherwise correct body
  // node. Keeping it would consume every block in the realtime first-frame
  // budget. Remove only a short, explicitly recognizable preamble when a
  // substantial article continues after the separator.
  const earlySeparator = root.children("hr").first();
  if (earlySeparator.length && earlySeparator.index() <= 5) {
    const preamble = earlySeparator.prevAll();
    const preambleText = normalizedText(preamble.text());
    const articleText = normalizedText(earlySeparator.nextAll().text());
    if (
      EDITORIAL_BOILERPLATE_PATTERN.test(preambleText)
      && articleText.length >= 160
    ) {
      preamble.remove();
      earlySeparator.remove();
    }
  }

  const turndown = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "_",
    strongDelimiter: "**",
    linkStyle: "inlined",
  });
  turndown.addRule("inkos-table-cell", {
    filter: ["th", "td"],
    replacement: (content) => {
      const cell = content
        .replace(/\|/gu, "\\|")
        .replace(/\s+/gu, " ")
        .trim();
      return `| ${cell} `;
    },
  });
  turndown.addRule("inkos-table-row", {
    filter: "tr",
    replacement: (content) => {
      const row = content.replace(/\s+/gu, " ").trim();
      return row ? `\n${row}|` : "";
    },
  });
  turndown.addRule("inkos-table", {
    filter: "table",
    replacement: (content) => {
      const rows = content
        .split("\n")
        .map((row) => row.trim())
        .filter((row) => row.startsWith("|") && row.endsWith("|"));
      if (!rows.length) return "";
      const columns = Math.max(1, rows[0].split("|").length - 2);
      const delimiter = `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`;
      return `\n\n${rows[0]}\n${delimiter}${rows.slice(1).map((row) => `\n${row}`).join("")}\n\n`;
    },
  });
  turndown.addRule("inkos-heading-with-breaks", {
    filter: ["h1", "h2", "h3", "h4", "h5", "h6"],
    replacement: (content, node) => {
      // A hard break has no block-level meaning inside a heading. Leaving the
      // newline in place makes CommonMark end the ATX heading and parse the
      // remainder as a separate paragraph (and can look like a duplicate
      // title). Preserve inline Markdown, but collapse its layout whitespace.
      const heading = normalizedText(content);
      if (!heading) return "";
      const level = Number(node.nodeName.slice(1));
      return `\n\n${"#".repeat(level)} ${heading}\n\n`;
    },
  });
  turndown.addRule("inkos-block-link", {
    filter: (node) => node.nodeName === "A"
      && node.hasAttribute("href")
      && Boolean(node.querySelector(BLOCK_LINK_DESCENDANT_SELECTOR)),
    replacement: (content, node) => {
      // Keep images and other inline Markdown inside the link; flatten only
      // the whitespace introduced by block descendants so the result remains
      // one valid CommonMark link token.
      const label = normalizedText(content);
      if (!label) return "";
      const href = markdownLinkDestination(node.getAttribute("href") ?? "");
      return `[${label}](${href}${markdownLinkTitle(node.getAttribute("title"))})`;
    },
  });
  turndown.addRule("inkos-blockquote-attribution", {
    filter: (node) => node.nodeName === "BLOCKQUOTE" && node.hasAttribute("data-ink-attribution"),
    replacement: (content, node) => {
      const quoted = content.trim().split("\n").map((line) => line ? `> ${line}` : ">").join("\n");
      const attribution = normalizedText(node.getAttribute("data-ink-attribution") ?? "", 2_000);
      return `\n\n${quoted}\n>\n> — ${turndown.escape(attribution)}\n\n`;
    },
  });

  const markdown = turndown.turndown(root.html() ?? "").trim();
  const semantic = markdownToSemantic(markdown, baseUrl);

  return {
    markdown,
    blocks: semantic.blocks,
    links: semantic.links,
    stats: {
      inputHtmlCharacters: html.length,
      markdownCharacters: markdown.length,
      textCharacters: semantic.textCharacters,
      blockCount: semantic.blocks.length,
      imageCount: semantic.imageCount,
      linkCount: semantic.links.length,
      rootSelector,
      truncated: semantic.truncated,
    },
  };
}

/**
 * Normalizes HTML carried inside RSS/Atom without treating it as a whole web
 * page. It shares the same inert sanitizer, URL policy, image classifier,
 * Markdown conversion and semantic budgets as Chromium captures.
 */
export function renderedHtmlFragmentToMarkdown(
  html: string,
  baseUrlInput: URL | string,
): RenderedHtmlMarkdownResult {
  return renderedHtmlToMarkdown(html, baseUrlInput, { mode: "feed-fragment" });
}

export const MARKDOWN_CONVERSION_LIMITS = Object.freeze({
  maxBlocks: MAX_BLOCKS,
  maxImages: MAX_IMAGES,
  maxTextCharacters: MAX_TEXT_CHARACTERS,
  maxLinks: MAX_LINKS,
});
