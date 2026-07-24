import type {
  ContentLink,
  DetailBlock,
  DetailPage,
  ListPage,
} from "../../rendering/contracts";
import { packagedDocument, type PackagedDocument } from "../contracts";
import { uuidV5 as namespacedUuidV5 } from "../uuid";
import type {
  CanonicalSourcePage,
  SemanticSourceBlock,
  SourceIngestionResult,
} from "./source";
import { DEFAULT_RSS_STYLE } from "./rss-style";

export const INKOS_SOURCE_NAMESPACE = "7779b454-0d2d-5e56-8d3c-9c972b987a7e";

export const DEFAULT_SOURCE_PRESENTATION = Object.freeze({
  feed: {
    kind: DEFAULT_RSS_STYLE.feed.kind,
    layout: DEFAULT_RSS_STYLE.feed.layout,
    itemLinkLabel: DEFAULT_RSS_STYLE.feed.linkLabel,
  },
  article: {
    kind: "detail",
    layout: "article",
    eyebrow: "WEB SOURCE",
  },
} as const);

export function uuidV5(name: string, namespace = INKOS_SOURCE_NAMESPACE): string {
  return namespacedUuidV5(name, namespace);
}

export function normalizeSourceIdentityUrl(value: string): string {
  const url = new URL(value);
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }
  const sorted = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    return leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue);
  });
  url.search = "";
  for (const [key, valuePart] of sorted) url.searchParams.append(key, valuePart);
  if (url.hash) {
    try {
      url.hash = decodeURIComponent(url.hash.slice(1)).normalize("NFC");
    } catch {
      // Keep the canonical source's escaped fragment if it cannot be decoded.
    }
  }
  return url.href;
}

export function sourceDocumentUuid(canonicalUrl: string): string {
  return uuidV5(`document:${normalizeSourceIdentityUrl(canonicalUrl)}`);
}

export function sourcePackageUuid(entryCanonicalUrl: string): string {
  return uuidV5(`package:${normalizeSourceIdentityUrl(entryCanonicalUrl)}`);
}

// These are the exact wire-contract limits from rendering/contracts. Source
// extraction has a larger per-document budget, so a single DOM leaf may be
// much larger than one protocol block even though the document as a whole is
// valid. Keep the normalization here, at the common source -> InkOS boundary,
// so HTTP, Chromium and future extractors receive the same protection.
const MAX_DETAIL_BODY_CHARACTERS = 20_000;
const MAX_DETAIL_SHORT_CHARACTERS = 500;
const MAX_DETAIL_LIST_ITEMS = 64;
const MAX_DETAIL_BLOCKS = 128;

function codePointSafeCut(value: string, requested: number): number {
  let cut = Math.min(requested, value.length);
  if (
    cut > 0
    && cut < value.length
    && /[\uD800-\uDBFF]/u.test(value[cut - 1])
    && /[\uDC00-\uDFFF]/u.test(value[cut])
  ) cut -= 1;
  return cut;
}

function naturalTextCut(value: string, maximum: number): number {
  const safeMaximum = codePointSafeCut(value, maximum);
  const minimum = Math.floor(safeMaximum * 0.5);
  const prefix = value.slice(0, safeMaximum);
  let sentenceCut = 0;
  const sentenceBoundary = /(?:[。！？!?；;]+[”’"'）)\]】》〉」』]*|\.+[”’"'）)\]】》〉」』]*(?=\s|$))/gu;
  for (const match of prefix.matchAll(sentenceBoundary)) {
    const end = (match.index ?? 0) + match[0].length;
    if (end >= minimum) sentenceCut = end;
  }
  if (sentenceCut > 0) return codePointSafeCut(value, sentenceCut);

  for (let index = safeMaximum; index >= minimum; index -= 1) {
    if (/\s/u.test(value[index - 1] ?? "")) return codePointSafeCut(value, index);
  }
  return safeMaximum;
}

/**
 * Split source text without reordering or silently discarding its tail.
 * Existing paragraph boundaries win, then sentence/word boundaries, with a
 * Unicode-safe hard limit as the final fallback.
 */
function splitDetailText(value: string, maximum: number): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const paragraphs = trimmed.split(/\r?\n(?:[\t ]*\r?\n)+/u);
  const chunks: string[] = [];

  for (const paragraphValue of paragraphs) {
    let remaining = paragraphValue.trim();
    while (remaining.length > maximum) {
      const cut = naturalTextCut(remaining, maximum);
      const chunk = remaining.slice(0, cut).trimEnd();
      if (chunk) chunks.push(chunk);
      remaining = remaining.slice(cut).trimStart();
    }
    if (remaining) chunks.push(remaining);
  }
  return chunks;
}

function boundedShortText(value: string): string {
  const trimmed = value.trim();
  return trimmed.slice(0, codePointSafeCut(trimmed, MAX_DETAIL_SHORT_CHARACTERS));
}

/**
 * Feed timestamps are source metadata rather than reading content. Rendering
 * a full RFC 3339 value (including seconds, milliseconds and `Z`) consumes an
 * entire high-DPI PaperS3 row, while a stable calendar date communicates the
 * useful ordering information without assuming the reader's timezone.
 */
function feedPublishedDate(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString().slice(0, 10)
    : boundedShortText(value);
}

function toDetailBlocks(
  block: SemanticSourceBlock,
  uuidByCanonicalUrl: ReadonlyMap<string, string>,
): DetailBlock[] {
  switch (block.type) {
    case "heading": {
      const chunks = splitDetailText(block.text, MAX_DETAIL_SHORT_CHARACTERS);
      return chunks.map((text, index) => index === 0
        ? { type: "heading", level: block.level <= 2 ? 2 : 3, text }
        : { type: "paragraph", text });
    }
    case "paragraph":
      return splitDetailText(block.text, MAX_DETAIL_BODY_CHARACTERS)
        .map((text) => ({ type: "paragraph", text }));
    case "list": {
      // Detail list items use the short-text contract (500 chars), while each
      // list block is limited to 64 items. Splitting rather than truncating is
      // important for book chapters and generated directory pages.
      const items = block.items.flatMap((item) =>
        splitDetailText(item, MAX_DETAIL_SHORT_CHARACTERS)
      );
      const lists: DetailBlock[] = [];
      for (let offset = 0; offset < items.length; offset += MAX_DETAIL_LIST_ITEMS) {
        lists.push({
          type: "list",
          ordered: block.ordered,
          items: items.slice(offset, offset + MAX_DETAIL_LIST_ITEMS),
        });
      }
      return lists;
    }
    case "quote": {
      const chunks = splitDetailText(block.text, MAX_DETAIL_BODY_CHARACTERS);
      const attribution = block.attribution ? boundedShortText(block.attribution) : "";
      return chunks.map((text, index) => ({
        type: "quote",
        text,
        ...(attribution && index === chunks.length - 1 ? { attribution } : {}),
      }));
    }
    case "link": {
      const label = boundedShortText(block.link.label);
      if (!label) return [];
      const targetUuid = uuidByCanonicalUrl.get(block.link.url);
      return [{
        type: "link",
        link: {
          label,
          target: targetUuid
            ? { kind: "document", documentId: targetUuid }
            : { kind: "url", url: block.link.url },
        },
      }];
    }
    case "image":
      return [{
        type: "image",
        image: {
          source: { kind: "remote", url: block.image.url },
          alt: boundedShortText(block.image.alt),
          ...(block.image.caption && boundedShortText(block.image.caption)
            ? { caption: boundedShortText(block.image.caption) }
            : {}),
        },
      }];
  }
}

function positiveRevision(page: CanonicalSourcePage): number {
  const numeric = Number(page.revision?.id);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 1;
}

function normalizedHeadingIdentity(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function semanticNavigation(
  page: CanonicalSourcePage,
  uuidByIdentityUrl: ReadonlyMap<string, string>,
  entryCanonicalUrl: string,
  entryUuid: string,
): ContentLink[] | undefined {
  const links = page.navigation?.slice(0, 32).map((item) => {
    const identityUrl = normalizeSourceIdentityUrl(item.canonicalUrl);
    const targetUuid = identityUrl === normalizeSourceIdentityUrl(entryCanonicalUrl)
      ? entryUuid
      : uuidByIdentityUrl.get(identityUrl);
    return {
      label: item.title,
      target: targetUuid
        ? { kind: "document" as const, documentId: targetUuid }
        : { kind: "url" as const, url: item.canonicalUrl },
    };
  });
  return links?.length ? links : undefined;
}

function normalizedReadingActionIdentity(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/^[^\p{L}\p{N}]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function isPrimaryReadingAction(link: ContentLink): boolean {
  return /^(?:read (?:this )?(?:book )?online(?: now)?|read now|start reading|在线阅读|立即阅读|开始阅读|阅读本书)$/iu
    .test(normalizedReadingActionIdentity(link.label));
}

type RssNavigationRole = "reading" | "paging" | "section";

/**
 * RSS bodies regularly contain dozens of ordinary citations. Promote only
 * labels that explicitly describe movement or a reading action; short anchor
 * text alone is never enough to make a link navigation.
 */
function rssNavigationRole(label: string): RssNavigationRole | undefined {
  const identity = normalizedReadingActionIdentity(label)
    .replace(/[^\p{L}\p{N}]+$/gu, "")
    .replace(/[：:]\s*/gu, "：");
  if (
    /^(?:原文(?:链接)?|全文|完整文章|(?:查看|阅读|打开)(?:原文|全文|详情|完整(?:文章|内容))|(?:继续|开始|立即)阅读(?:原文|全文)?|全文阅读|阅读更多|read more|continue reading|view (?:the )?original|read (?:the )?(?:full|original) article|open (?:the )?original)$/iu
      .test(identity)
  ) return "reading";
  if (
    /^(?:(?:上一|下一)(?:页|篇|章|条|则)(?:[：:].{1,120})?|前一篇(?:[：:].{1,120})?|后一篇(?:[：:].{1,120})?|返回(?:列表|文章列表)|previous(?: page| article| post)?|next(?: page| article| post)?|older(?: posts?)?|newer(?: posts?)?)$/iu
      .test(identity)
  ) return "paging";
  if (
    /^(?:(?:首页|主页|目录|归档|分类|标签|专题|专栏)|(?:返回|前往|进入)(?:首页|主页|栏目|专栏|分类|标签|归档|目录)|(?:栏目|专栏|分类|标签|归档|目录)[：:].{1,120}|(?:频道主页|文章列表|全部文章|更多文章|全部内容|table of contents|archive|categories))$/iu
      .test(identity)
  ) return "section";
  return undefined;
}

function rssNavigationDescription(role: RssNavigationRole): string {
  switch (role) {
    case "reading":
      return "打开来源网站继续阅读";
    case "paging":
      return "打开相邻内容";
    case "section":
      return "打开栏目导航";
  }
}

function linkTargetIdentity(link: ContentLink): string {
  return link.target.kind === "document"
    ? `document:${link.target.documentId}`
    : `url:${normalizeSourceIdentityUrl(link.target.url)}`;
}

function sameContentLink(left: ContentLink, right: ContentLink): boolean {
  return left.label === right.label
    && linkTargetIdentity(left) === linkTargetIdentity(right);
}

function uniqueContentLinks(links: readonly ContentLink[]): ContentLink[] {
  return links.filter((link, index, all) =>
    all.findIndex((candidate) => sameContentLink(candidate, link)) === index
  );
}

function hasNavigationTarget(
  links: readonly ContentLink[],
  candidate: ContentLink,
): boolean {
  const target = linkTargetIdentity(candidate);
  return links.some((link) => linkTargetIdentity(link) === target);
}

function sameFeedDestination(left: string, right: string): boolean {
  const comparable = (value: string): string => {
    const url = new URL(normalizeSourceIdentityUrl(value));
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/gu, "");
    return url.href;
  };
  return comparable(left) === comparable(right);
}

function detailPage(
  page: CanonicalSourcePage,
  uuidByCanonicalUrl: ReadonlyMap<string, string>,
  navigation: ContentLink[] | undefined,
  options: TransformSourceOptions,
): DetailPage {
  const isSyndicationDetail = page.syndication !== undefined;
  let firstHeadingSeen = false;
  const titleIdentity = normalizedHeadingIdentity(page.title);
  const semanticBlocks = page.blocks.filter((block) => {
    if (block.type !== "heading" || firstHeadingSeen) return true;
    firstHeadingSeen = true;
    return normalizedHeadingIdentity(block.text) !== titleIdentity;
  });
  const requestedMaxDetailBlocks = options.maxDetailBlocks ?? MAX_DETAIL_BLOCKS;
  const maxDetailBlocks = Math.max(
    1,
    Math.min(MAX_DETAIL_BLOCKS, Math.trunc(requestedMaxDetailBlocks)),
  );
  // Expand first and only then apply the page block budget. Otherwise one
  // oversized source list/paragraph can bypass the protocol's per-block
  // bounds, or be counted as one block before becoming several wire blocks.
  const expandedContent: DetailBlock[] = semanticBlocks.flatMap((block) =>
    toDetailBlocks(block, uuidByCanonicalUrl)
  );
  const bodyContent: DetailBlock[] = expandedContent.length > 0
    ? expandedContent
    : [{ type: "paragraph", text: page.title }];
  const currentDocumentUuid = uuidByCanonicalUrl.get(page.canonicalUrl);
  const rssBodyNavigation = isSyndicationDetail
    ? bodyContent.flatMap((block) => {
        if (block.type !== "link") return [];
        const role = rssNavigationRole(block.link.label);
        const target = block.link.target.kind === "document"
          && block.link.target.documentId === currentDocumentUuid
          ? { kind: "url" as const, url: page.canonicalUrl }
          : block.link.target;
        return role
          ? [{
              ...block.link,
              target,
              description: block.link.description ?? rssNavigationDescription(role),
            }]
          : [];
      })
    : [];
  const readableBodyContent = rssBodyNavigation.length
    ? bodyContent.filter((block) =>
        block.type !== "link"
        || rssNavigationRole(block.link.label) === undefined
      )
    : bodyContent;
  let content = readableBodyContent.slice(0, maxDetailBlocks);

  const childLinks = page.childLinks.flatMap((child) => {
    const targetUuid = uuidByCanonicalUrl.get(child.canonicalUrl);
    return targetUuid
      ? [{
          label: child.title,
          target: { kind: "document" as const, documentId: targetUuid },
          description: "打开离线包中的关联页面",
        }]
      : [];
  });
  const sourceLinks: DetailPage["links"] = isSyndicationDetail
    ? []
    : [{
        label: `来源：${page.attribution.name}`,
        target: { kind: "url", url: page.attribution.url },
      }];
  if (page.license?.url) {
    sourceLinks.push({
      label: `许可：${page.license.name}`,
      target: { kind: "url", url: page.license.url },
    });
  }

  const visibleLinks: DetailPage["links"] = (page.links ?? []).flatMap((link) => {
    const targetUuid = uuidByCanonicalUrl.get(link.canonicalUrl);
    const linksToCurrentDocument =
      normalizeSourceIdentityUrl(link.canonicalUrl)
      === normalizeSourceIdentityUrl(page.canonicalUrl);
    return [{
      label: link.title,
      target: targetUuid && !linksToCurrentDocument
        ? { kind: "document" as const, documentId: targetUuid }
        : { kind: "url" as const, url: link.canonicalUrl },
    }];
  });
  const rssVisibleNavigation = isSyndicationDetail
    ? visibleLinks.flatMap((link) => {
        const role = rssNavigationRole(link.label);
        return role
          ? [{ ...link, description: link.description ?? rssNavigationDescription(role) }]
          : [];
      })
    : [];
  const primaryReadingActionIndex = isSyndicationDetail
    ? -1
    : visibleLinks.findIndex(isPrimaryReadingAction);
  const primaryReadingAction = primaryReadingActionIndex >= 0
    ? visibleLinks[primaryReadingActionIndex]
    : undefined;
  if (primaryReadingAction) {
    // Keep the source page's reading CTA near the title instead of burying it
    // after a long book/article body. Chromium-to-Markdown extraction may also
    // retain the same visible button label as a standalone paragraph; remove
    // only that exact normalized duplicate so users never encounter a later
    // inert copy. This remains an ordinary semantic link block; the renderer
    // still owns every device-specific coordinate.
    const primaryIdentity =
      normalizedReadingActionIdentity(primaryReadingAction.label);
    const deduplicatedBody = readableBodyContent.filter((block) =>
      (
        block.type !== "paragraph"
        || normalizedReadingActionIdentity(block.text) !== primaryIdentity
      )
      && (
        block.type !== "link"
        || block.link.label !== primaryReadingAction.label
        || JSON.stringify(block.link.target) !== JSON.stringify(primaryReadingAction.target)
      )
    );
    content = [
      { type: "link", link: primaryReadingAction },
      ...deduplicatedBody.slice(0, Math.max(0, maxDetailBlocks - 1)),
    ];
  }
  const footerVisibleLinksBeforeContentDedupe = primaryReadingAction
    ? visibleLinks.filter((_, index) => index !== primaryReadingActionIndex)
    : visibleLinks.filter((link) =>
        !rssVisibleNavigation.some((navigationLink) =>
          sameContentLink(navigationLink, link)
        )
      );
  const inlineContentLinks = content.flatMap((block) =>
    block.type === "link" ? [block.link] : []
  );
  const footerVisibleLinks = footerVisibleLinksBeforeContentDedupe.filter(
    (candidate) => !inlineContentLinks.some((inline) =>
      inline.label === candidate.label
      && JSON.stringify(inline.target) === JSON.stringify(candidate.target)
    ),
  );
  // Visible page actions carry the author's intended hierarchy. A background
  // archive crawl may materialize additional child pages (for example Donate
  // or category pages), but those crawl edges must not displace a prominent
  // action such as Gutenberg's "Read online now" from the front of the list.
  const deduplicatedLinks = [...footerVisibleLinks, ...childLinks, ...sourceLinks].filter(
    (link, index, links) => links.findIndex((candidate) =>
      candidate.label === link.label
      && JSON.stringify(candidate.target) === JSON.stringify(link.target)
    ) === index,
  );
  let resolvedNavigation = navigation;
  if (isSyndicationDetail) {
    const rssNavigationCandidates = uniqueContentLinks([
      ...rssBodyNavigation,
      ...rssVisibleNavigation,
    ]);
    const canonicalIdentity = normalizeSourceIdentityUrl(page.canonicalUrl);
    const originalAction = rssNavigationCandidates.find((link) =>
      link.target.kind === "url"
      && normalizeSourceIdentityUrl(link.target.url) === canonicalIdentity
      && rssNavigationRole(link.label) === "reading"
    ) ?? {
      label: "查看原文",
      target: { kind: "url" as const, url: page.canonicalUrl },
      description: "在来源网站打开原文",
    };
    resolvedNavigation = uniqueContentLinks([
      originalAction,
      ...rssNavigationCandidates.filter((link) => !sameContentLink(link, originalAction)),
      ...(navigation ?? []),
    ]).slice(0, 32);
  }
  const hasImage = page.blocks.some((block) => block.type === "image");

  return {
    kind: isSyndicationDetail
      ? DEFAULT_RSS_STYLE.article.kind
      : DEFAULT_SOURCE_PRESENTATION.article.kind,
    layout: isSyndicationDetail
      ? hasImage
        ? DEFAULT_RSS_STYLE.article.layoutWithImage
        : DEFAULT_RSS_STYLE.article.layoutWithoutImage
      : hasImage
        ? "image-story"
        : DEFAULT_SOURCE_PRESENTATION.article.layout,
    title: page.title,
    eyebrow: page.provenance.provider === "wikimedia"
      ? "WIKIMEDIA"
      : isSyndicationDetail
        ? DEFAULT_RSS_STYLE.article.eyebrow
        : DEFAULT_SOURCE_PRESENTATION.article.eyebrow,
    byline: page.syndication?.author ?? page.attribution.name,
    ...(page.syndication?.publishedAt || page.revision?.timestamp
      ? { publishedAt: page.syndication?.publishedAt ?? page.revision?.timestamp }
      : {}),
    content,
    ...(resolvedNavigation?.length ? { navigation: resolvedNavigation } : {}),
    links: deduplicatedLinks.slice(0, 16),
  };
}

function feedPage(
  page: CanonicalSourcePage,
  uuidByCanonicalUrl: ReadonlyMap<string, string>,
  navigation: ContentLink[] | undefined,
  options: TransformSourceOptions,
): ListPage {
  const presentation = page.isSyndicationFeed
    ? {
        kind: DEFAULT_RSS_STYLE.feed.kind,
        layout: DEFAULT_RSS_STYLE.feed.layout,
        itemLinkLabel: DEFAULT_RSS_STYLE.feed.linkLabel,
      }
    : DEFAULT_SOURCE_PRESENTATION.feed;
  const items = (page.feedItems ?? []).slice(0, options.maxFeedItems ?? 128).map((item) => {
    let targetUuid = uuidByCanonicalUrl.get(item.canonicalUrl);
    if (!targetUuid) {
      const sameTitleChildren = page.childLinks.filter((child) => child.title === item.title);
      if (sameTitleChildren.length === 1) {
        targetUuid = uuidByCanonicalUrl.get(sameTitleChildren[0].canonicalUrl);
      }
    }
    return {
      id: sourceDocumentUuid(item.canonicalUrl),
      title: item.title,
      ...(item.summary ? { summary: item.summary } : {}),
      ...(item.author ? { eyebrow: item.author } : {}),
      ...(item.publishedAt
        ? { metadata: [{ label: "发布时间", value: feedPublishedDate(item.publishedAt) }] }
        : {}),
      ...(item.image
        ? {
            image: {
              source: { kind: "remote" as const, url: item.image.url },
              alt: item.image.alt,
            },
          }
        : {}),
      link: {
        label: presentation.itemLinkLabel,
        target: targetUuid
          ? { kind: "document" as const, documentId: targetUuid }
          : { kind: "url" as const, url: item.canonicalUrl },
      },
    };
  });
  const channelDescription = page.isSyndicationFeed
    && DEFAULT_RSS_STYLE.feed.description === "channel"
    ? page.blocks
      .filter((block) => block.type === "paragraph")
      .map((block) => block.text)
      .find(Boolean)
    : undefined;
  let resolvedNavigation = navigation ? [...navigation] : [];
  if (page.isSyndicationFeed) {
    const channelHome = !sameFeedDestination(page.attribution.url, page.canonicalUrl)
      ? {
          label: "频道主页",
          target: { kind: "url" as const, url: page.attribution.url },
          description: "打开频道网站",
        }
      : undefined;
    if (channelHome && !hasNavigationTarget(resolvedNavigation, channelHome)) {
      resolvedNavigation.unshift(channelHome);
    }
    resolvedNavigation = uniqueContentLinks(resolvedNavigation).slice(0, 32);
  }

  return {
    kind: presentation.kind,
    layout: presentation.layout,
    title: page.title,
    ...(channelDescription ? { description: channelDescription } : {}),
    ...(resolvedNavigation.length ? { navigation: resolvedNavigation } : {}),
    items,
    sourcePageInfo: { totalItems: items.length },
  };
}

export interface TransformedSourceCollection {
  packageId: string;
  entryUuid: string;
  documents: PackagedDocument[];
}

export interface TransformSourceOptions {
  maxFeedItems?: number;
  maxDetailBlocks?: number;
}

export function transformIngestedSource(
  result: SourceIngestionResult,
  options: TransformSourceOptions = {},
): TransformedSourceCollection {
  const uuidByCanonicalUrl = new Map(
    result.pages.map((page) => [page.canonicalUrl, sourceDocumentUuid(page.canonicalUrl)]),
  );
  const uuidByIdentityUrl = new Map(
    result.pages.map((page) => [
      normalizeSourceIdentityUrl(page.canonicalUrl),
      sourceDocumentUuid(page.canonicalUrl),
    ]),
  );
  const entryUuid = uuidByCanonicalUrl.get(result.entryCanonicalUrl);
  if (!entryUuid) throw new Error("Ingested source entry is missing from its page collection");

  const documents = result.pages.map((page) => {
    const uuid = uuidByCanonicalUrl.get(page.canonicalUrl)!;
    const navigation = semanticNavigation(
      page,
      uuidByIdentityUrl,
      result.entryCanonicalUrl,
      entryUuid,
    );
    const parentUuid = page.parentCanonicalUrl
      ? uuidByCanonicalUrl.get(page.parentCanonicalUrl)
      : undefined;
    if (page.canonicalUrl !== result.entryCanonicalUrl && !parentUuid) {
      throw new Error(`Source page '${page.canonicalUrl}' does not have a packaged parent`);
    }
    return packagedDocument({
      uuid,
      ...(parentUuid ? { parentUuid } : {}),
      source: {
        url: page.canonicalUrl,
        title: page.title,
        retrievedAt: page.provenance.retrievedAt,
        ...(page.license?.name ? { license: page.license.name } : {}),
      },
      content: {
        schemaVersion: "inkos.content/v2",
        id: uuid,
        revision: positiveRevision(page),
        locale: page.locale ?? "und",
        ...(page.revision?.timestamp ? { updatedAt: page.revision.timestamp } : {}),
        page: page.feedItems && page.feedItems.length > 0
          ? feedPage(page, uuidByCanonicalUrl, navigation, options)
          : detailPage(page, uuidByCanonicalUrl, navigation, options),
      },
    });
  });

  return {
    packageId: sourcePackageUuid(result.entryCanonicalUrl),
    entryUuid,
    documents,
  };
}
