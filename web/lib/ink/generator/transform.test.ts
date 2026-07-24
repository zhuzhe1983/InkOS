import { describe, expect, it } from "vitest";

import { readInkArchive } from "../archive";
import {
  buildRenderedInkPackage,
  createInkDisplayVariant,
} from "../package-builder";
import {
  DEFAULT_SOURCE_PRESENTATION,
  transformIngestedSource,
  uuidV5,
} from "./transform";

const retrievedAt = "2026-07-16T08:00:00.000Z";

describe("source to semantic InkOS documents", () => {
  it("uses RFC UUIDv5 identity and keeps layout coordinates out of content", () => {
    expect(uuidV5("hello")).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
    const transformed = transformIngestedSource({
      seedUrl: "https://example.com/root#section",
      entryCanonicalUrl: "https://example.com/root#section",
      limits: { maxDepth: 1, maxDocuments: 2 },
      pages: [
        {
          canonicalUrl: "https://example.com/root#section",
          depth: 0,
          title: "Root",
          locale: "en",
          blocks: [{ type: "paragraph", text: "Root body" }],
          childLinks: [{ title: "Child", canonicalUrl: "https://example.com/child" }],
          provenance: {
            provider: "web",
            sourceUrl: "https://example.com/root#section",
            canonicalUrl: "https://example.com/root#section",
            retrievedAt,
          },
          revision: null,
          license: null,
          attribution: { name: "Example", url: "https://example.com/root#section" },
        },
        {
          canonicalUrl: "https://example.com/child",
          parentCanonicalUrl: "https://example.com/root#section",
          depth: 1,
          title: "Child",
          locale: "en",
          blocks: [{ type: "image", image: { url: "https://example.com/photo.jpg", alt: "Photo" } }],
          childLinks: [],
          provenance: {
            provider: "web",
            sourceUrl: "https://example.com/child",
            canonicalUrl: "https://example.com/child",
            retrievedAt,
          },
          revision: { id: "42", timestamp: "2026-07-01T00:00:00Z" },
          license: { name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
          attribution: { name: "Example", url: "https://example.com/child" },
        },
      ],
    });
    const [root, child] = transformed.documents;
    const serialized = JSON.stringify(transformed.documents);

    expect(root.parentUuid).toBeUndefined();
    expect(child.parentUuid).toBe(root.uuid);
    expect(root.content.page).toMatchObject({
      kind: "detail",
      links: expect.arrayContaining([expect.objectContaining({
        target: { kind: "document", documentId: child.uuid },
      })]),
    });
    expect(child.content.page).toMatchObject({ kind: "detail", layout: "image-story" });
    expect(serialized).not.toMatch(/"(?:x|y|width|height)"\s*:/u);
  });

  it("preserves identities when the same canonical source is rebuilt", () => {
    const url = "https://zh.wikipedia.org/wiki/Nook#电子墨水屏系列";
    const first = transformIngestedSource({
      seedUrl: url,
      entryCanonicalUrl: url,
      limits: { maxDepth: 0, maxDocuments: 1 },
      pages: [{
        canonicalUrl: url,
        depth: 0,
        title: "Nook",
        blocks: [{ type: "paragraph", text: "正文" }],
        childLinks: [],
        provenance: { provider: "wikimedia", sourceUrl: url, canonicalUrl: url, retrievedAt },
        revision: null,
        license: null,
        attribution: { name: "Wikipedia contributors", url },
      }],
    });
    const second = transformIngestedSource({
      seedUrl: url,
      entryCanonicalUrl: url,
      limits: { maxDepth: 0, maxDocuments: 1 },
      pages: [{
        canonicalUrl: url,
        depth: 0,
        title: "Changed title",
        blocks: [{ type: "paragraph", text: "更新正文" }],
        childLinks: [],
        provenance: { provider: "wikimedia", sourceUrl: url, canonicalUrl: url, retrievedAt },
        revision: null,
        license: null,
        attribution: { name: "Wikipedia contributors", url },
      }],
    });
    expect(second.packageId).toBe(first.packageId);
    expect(second.entryUuid).toBe(first.entryUuid);
  });

  it("keeps a primary reading action and more than three book links through final sidecars", async () => {
    const url = "https://gutenberg.org/ebooks/24230";
    const onlineUrl = "https://gutenberg.org/cache/epub/24230/pg24230-images.html";
    const donateUrl = "https://www.gutenberg.org/donate/";
    const transformed = transformIngestedSource({
      seedUrl: url,
      entryCanonicalUrl: url,
      limits: { maxDepth: 1, maxDocuments: 2 },
      pages: [{
        canonicalUrl: url,
        depth: 0,
        title: "今古奇觀 by Baowenglaoren",
        locale: "en",
        blocks: [
          { type: "paragraph", text: "Rendered Gutenberg book detail." },
          { type: "paragraph", text: "Read online now" },
          {
            type: "paragraph",
            text: "Readers can read online now or download a file for later.",
          },
          { type: "paragraph", text: "Download for free" },
        ],
        links: [
          { title: "Read online now", canonicalUrl: onlineUrl },
          { title: "EPUB3", canonicalUrl: "https://gutenberg.org/ebooks/24230.epub3.images" },
          { title: "Plain Text", canonicalUrl: "https://gutenberg.org/ebooks/24230.txt.utf-8" },
          { title: "EPUB", canonicalUrl: "https://gutenberg.org/ebooks/24230.epub.images" },
          { title: "Kindle", canonicalUrl: "https://gutenberg.org/ebooks/24230.kf8.images" },
          { title: "Download HTML", canonicalUrl: "https://gutenberg.org/cache/epub/24230/pg24230-h.zip" },
        ],
        childLinks: [{ title: "Donate", canonicalUrl: donateUrl }],
        provenance: { provider: "web", sourceUrl: url, canonicalUrl: url, retrievedAt },
        revision: null,
        license: null,
        attribution: { name: "gutenberg.org", url },
      }, {
        canonicalUrl: donateUrl,
        parentCanonicalUrl: url,
        depth: 1,
        title: "Donate",
        blocks: [{ type: "paragraph", text: "Support Project Gutenberg." }],
        childLinks: [],
        provenance: {
          provider: "web",
          sourceUrl: donateUrl,
          canonicalUrl: donateUrl,
          retrievedAt,
        },
        revision: null,
        license: null,
        attribution: { name: "gutenberg.org", url: donateUrl },
      }],
    });

    const page = transformed.documents[0].content.page;
    expect(page.kind).toBe("detail");
    if (page.kind !== "detail") throw new Error("Expected Gutenberg detail page");
    expect(page.links?.length).toBeGreaterThan(3);
    expect(page.content[0]).toEqual({
      type: "link",
      link: {
        label: "Read online now",
        target: { kind: "url", url: onlineUrl },
      },
    });
    expect(page.content).not.toContainEqual({
      type: "paragraph",
      text: "Read online now",
    });
    expect(page.content).toContainEqual({
      type: "paragraph",
      text: "Download for free",
    });
    expect(page.content).toContainEqual({
      type: "paragraph",
      text: "Readers can read online now or download a file for later.",
    });
    expect(page.links).toContainEqual(expect.objectContaining({
      label: "Donate",
      target: expect.objectContaining({ kind: "document" }),
    }));

    const built = await buildRenderedInkPackage({
      packageId: transformed.packageId,
      slug: "gutenberg-24230",
      revision: 1,
      title: "今古奇觀 by Baowenglaoren",
      entryUuid: transformed.entryUuid,
      createdAt: retrievedAt,
      generator: { name: "gutenberg-regression", version: "1.0.0" },
      provenance: {
        seeds: [{
          url,
          title: "今古奇觀 by Baowenglaoren",
          retrievedAt,
        }],
        crawl: { maxDepth: 1, maxDocuments: 2 },
      },
      variants: [createInkDisplayVariant("m5stack-paper-s3-portrait", {
        orientation: "portrait",
        fontLevel: 0,
        invert: false,
      })],
      documents: transformed.documents,
    });
    const archive = await readInkArchive(built.archive);
    const index = archive.manifest.documents.find(
      (candidate) => candidate.uuid === transformed.entryUuid,
    );
    const variant = index?.variants[0];
    if (!variant) throw new Error("Expected a rendered Gutenberg PaperS3 variant");
    const interactions = variant.pages.flatMap((renderedPage) =>
      (archive.sidecars.get(renderedPage.sidecarPath)?.interactions ?? [])
        .map((interaction) => ({
          ...interaction,
          renderedPageIndex: renderedPage.pageIndex,
        }))
    ).filter((interaction) =>
      interaction.contentPath.startsWith("page.links[")
      || interaction.contentPath.startsWith("page.content[")
    );

    expect(new Set(interactions.map((interaction) => interaction.contentPath)).size)
      .toBeGreaterThan(3);
    expect(interactions).toContainEqual(expect.objectContaining({
      renderedPageIndex: 0,
      contentPath: "page.content[0]",
      label: "↗ Read online now",
      targetUrl: onlineUrl,
    }));
    const readingInteractions = interactions.filter((interaction) =>
      interaction.targetUrl === onlineUrl
    );
    expect(readingInteractions.length).toBeGreaterThan(0);
    expect(readingInteractions.every((interaction) =>
      interaction.renderedPageIndex === 0
      && interaction.contentPath === "page.content[0]"
      && interaction.bounds.width > 0
      && interaction.bounds.height > 0
    )).toBe(true);
  });

  it("keeps a standalone source action in body order without duplicating it in the footer", () => {
    const url = "https://example.com/posts/42";
    const actionUrl = "https://example.com/reports/full.pdf";
    const transformed = transformIngestedSource({
      seedUrl: url,
      entryCanonicalUrl: url,
      limits: { maxDepth: 0, maxDocuments: 1 },
      pages: [{
        canonicalUrl: url,
        depth: 0,
        title: "结构化正文",
        blocks: [
          { type: "paragraph", text: "操作之前的正文。" },
          {
            type: "link",
            link: { label: "下载完整报告", url: actionUrl },
          },
          { type: "paragraph", text: "操作之后的正文。" },
        ],
        links: [{ title: "下载完整报告", canonicalUrl: actionUrl }],
        childLinks: [],
        provenance: { provider: "web", sourceUrl: url, canonicalUrl: url, retrievedAt },
        revision: null,
        license: null,
        attribution: { name: "Example", url },
      }],
    });

    const page = transformed.documents[0].content.page;
    expect(page.kind).toBe("detail");
    if (page.kind !== "detail") throw new Error("Expected detail page");
    expect(page.content.slice(0, 3)).toEqual([
      { type: "paragraph", text: "操作之前的正文。" },
      {
        type: "link",
        link: {
          label: "下载完整报告",
          target: { kind: "url", url: actionUrl },
        },
      },
      { type: "paragraph", text: "操作之后的正文。" },
    ]);
    expect(page.links).not.toContainEqual(expect.objectContaining({
      label: "下载完整报告",
    }));
  });

  it("turns repeated source entries into a feed and links packaged children by UUID", () => {
    const rootUrl = "https://example.com/";
    const firstUrl = "https://example.com/news/first";
    const secondUrl = "https://example.com/news/second";
    const transformed = transformIngestedSource({
      seedUrl: rootUrl,
      entryCanonicalUrl: rootUrl,
      limits: { maxDepth: 1, maxDocuments: 2 },
      pages: [
        {
          canonicalUrl: rootUrl,
          depth: 0,
          title: "Latest stories",
          blocks: [
            { type: "image", image: { url: "https://example.com/avatar.jpg", alt: "Author avatar" } },
          ],
          feedItems: [
            {
              title: "First story",
              summary: "First summary",
              publishedAt: "2026-07-16T07:30:00.000Z",
              image: { url: "https://example.com/first.jpg", alt: "First photo" },
              canonicalUrl: firstUrl,
            },
            {
              title: "Second story",
              summary: "Second summary",
              image: { url: "https://example.com/second.jpg", alt: "Second photo" },
              canonicalUrl: secondUrl,
            },
          ],
          navigation: [
            { title: "首页", canonicalUrl: rootUrl },
            { title: "第一篇", canonicalUrl: firstUrl },
            { title: "问答", canonicalUrl: "https://example.com/qa" },
          ],
          childLinks: [{ title: "First story", canonicalUrl: firstUrl }],
          provenance: { provider: "web", sourceUrl: rootUrl, canonicalUrl: rootUrl, retrievedAt },
          revision: null,
          license: null,
          attribution: { name: "Example", url: rootUrl },
        },
        {
          canonicalUrl: firstUrl,
          parentCanonicalUrl: rootUrl,
          depth: 1,
          title: "First story",
          blocks: [{ type: "paragraph", text: "First full article." }],
          childLinks: [],
          provenance: { provider: "web", sourceUrl: firstUrl, canonicalUrl: firstUrl, retrievedAt },
          revision: null,
          license: null,
          attribution: { name: "Example", url: firstUrl },
        },
      ],
    });

    const root = transformed.documents[0];
    const child = transformed.documents[1];
    expect(root.content.page).toEqual({
      kind: "list",
      layout: "feed",
      title: "Latest stories",
      navigation: [
        {
          label: "首页",
          target: { kind: "document", documentId: root.uuid },
        },
        {
          label: "第一篇",
          target: { kind: "document", documentId: child.uuid },
        },
        {
          label: "问答",
          target: { kind: "url", url: "https://example.com/qa" },
        },
      ],
      items: [
        {
          id: expect.any(String),
          title: "First story",
          summary: "First summary",
          metadata: [{ label: "发布时间", value: "2026-07-16" }],
          image: {
            source: { kind: "remote", url: "https://example.com/first.jpg" },
            alt: "First photo",
          },
          link: {
            label: "阅读详情",
            target: { kind: "document", documentId: child.uuid },
          },
        },
        {
          id: expect.any(String),
          title: "Second story",
          summary: "Second summary",
          image: {
            source: { kind: "remote", url: "https://example.com/second.jpg" },
            alt: "Second photo",
          },
          link: {
            label: "阅读详情",
            target: { kind: "url", url: secondUrl },
          },
        },
      ],
      sourcePageInfo: { totalItems: 2 },
    });
    expect(child.content.page.kind).toBe("detail");
    const serialized = JSON.stringify(root.content);
    expect(serialized).not.toContain("avatar.jpg");
    expect(serialized).not.toMatch(/"(?:x|y|width|height)"\s*:/u);
  });

  it("uses explicit feed/article defaults when optional syndication fields are absent", () => {
    const feedUrl = "https://example.com/minimal.xml";
    const articleUrl = "https://example.com/articles/minimal";
    const transformed = transformIngestedSource({
      seedUrl: feedUrl,
      entryCanonicalUrl: feedUrl,
      limits: { maxDepth: 1, maxDocuments: 2 },
      pages: [{
        canonicalUrl: feedUrl,
        depth: 0,
        title: "Minimal feed",
        blocks: [{ type: "paragraph", text: "Minimal feed RSS/Atom feed" }],
        feedItems: [{
          title: "Minimal article",
          canonicalUrl: articleUrl,
        }],
        childLinks: [{ title: "Minimal article", canonicalUrl: articleUrl }],
        provenance: {
          provider: "web",
          sourceUrl: feedUrl,
          canonicalUrl: feedUrl,
          retrievedAt,
        },
        revision: null,
        license: null,
        attribution: { name: "Minimal feed", url: feedUrl },
      }, {
        canonicalUrl: articleUrl,
        parentCanonicalUrl: feedUrl,
        depth: 1,
        title: "Minimal article",
        blocks: [],
        childLinks: [],
        provenance: {
          provider: "web",
          sourceUrl: articleUrl,
          canonicalUrl: articleUrl,
          retrievedAt,
        },
        revision: null,
        license: null,
        attribution: { name: "Example author", url: articleUrl },
      }],
    });

    const feed = transformed.documents[0];
    const article = transformed.documents[1];
    expect(DEFAULT_SOURCE_PRESENTATION).toEqual({
      feed: { kind: "list", layout: "feed", itemLinkLabel: "阅读详情" },
      article: { kind: "detail", layout: "article", eyebrow: "WEB SOURCE" },
    });
    expect(feed.content.page).toEqual({
      kind: "list",
      layout: "feed",
      title: "Minimal feed",
      items: [{
        id: expect.any(String),
        title: "Minimal article",
        link: {
          label: "阅读详情",
          target: { kind: "document", documentId: article.uuid },
        },
      }],
      sourcePageInfo: { totalItems: 1 },
    });
    expect(article.content.page).toMatchObject({
      kind: "detail",
      layout: "article",
      title: "Minimal article",
      eyebrow: "WEB SOURCE",
      byline: "Example author",
      content: [{ type: "paragraph", text: "Minimal article" }],
    });
    expect(article.content.page).not.toHaveProperty("hero");
    expect(article.content.page).not.toHaveProperty("publishedAt");
  });

  it("applies the file-backed RSS style to channel, item and detail semantics", () => {
    const feedUrl = "https://example.com/rss.xml";
    const articleUrl = "https://example.com/posts/42";
    const transformed = transformIngestedSource({
      seedUrl: feedUrl,
      entryCanonicalUrl: feedUrl,
      limits: { maxDepth: 1, maxDocuments: 2 },
      pages: [{
        canonicalUrl: feedUrl,
        depth: 0,
        title: "InkOS RSS",
        blocks: [{ type: "paragraph", text: "适合墨水屏阅读的频道说明。" }],
        isSyndicationFeed: true,
        feedItems: [{
          title: "结构化文章",
          summary: "列表摘要",
          author: "RSS 作者",
          publishedAt: "2026-07-20T00:00:00.000Z",
          canonicalUrl: articleUrl,
        }],
        childLinks: [{ title: "结构化文章", canonicalUrl: articleUrl }],
        provenance: {
          provider: "web",
          sourceUrl: feedUrl,
          canonicalUrl: feedUrl,
          retrievedAt,
        },
        revision: null,
        license: null,
        attribution: { name: "InkOS RSS", url: "https://example.com/" },
      }, {
        canonicalUrl: articleUrl,
        parentCanonicalUrl: feedUrl,
        depth: 1,
        title: "结构化文章",
        blocks: [
          { type: "paragraph", text: "详情正文。" },
          {
            type: "image",
            image: { url: "https://example.com/photo.jpg", alt: "正文配图" },
          },
        ],
        childLinks: [],
        provenance: {
          provider: "web",
          sourceUrl: articleUrl,
          canonicalUrl: articleUrl,
          retrievedAt,
        },
        revision: null,
        license: null,
        attribution: { name: "example.com", url: articleUrl },
        syndication: {
          author: "RSS 作者",
          publishedAt: "2026-07-20T00:00:00.000Z",
          summary: "列表摘要",
        },
      }],
    });

    expect(transformed.documents[0].content.page).toMatchObject({
      kind: "list",
      layout: "feed",
      title: "InkOS RSS",
      description: "适合墨水屏阅读的频道说明。",
      navigation: [
        {
          label: "频道主页",
          target: { kind: "url", url: "https://example.com/" },
          description: "打开频道网站",
        },
      ],
      items: [{
        title: "结构化文章",
        summary: "列表摘要",
        eyebrow: "RSS 作者",
        metadata: [{ label: "发布时间", value: "2026-07-20" }],
        link: {
          label: "阅读详情",
          target: {
            kind: "document",
            documentId: transformed.documents[1].uuid,
          },
        },
      }],
    });
    expect(transformed.documents[1].content.page).toMatchObject({
      kind: "detail",
      layout: "image-story",
      title: "结构化文章",
      eyebrow: "RSS",
      byline: "RSS 作者",
      publishedAt: "2026-07-20T00:00:00.000Z",
    });
    expect(JSON.stringify(transformed.documents)).not.toMatch(
      /"(?:x|y|width|height)"\s*:/u,
    );
  });

  it("promotes only explicit RSS reading, paging and section actions into navigation", () => {
    const articleUrl = "https://example.com/posts/42";
    const nextUrl = "https://example.com/posts/43";
    const categoryUrl = "https://example.com/categories/tools";
    const referenceUrl = "https://example.net/traffic-monitor";
    const analysisUrl = "https://example.net/analysis";
    const whitepaperUrl = "https://example.net/whitepaper";
    const transformed = transformIngestedSource({
      seedUrl: articleUrl,
      entryCanonicalUrl: articleUrl,
      limits: { maxDepth: 0, maxDocuments: 1 },
      pages: [{
        canonicalUrl: articleUrl,
        depth: 0,
        title: "RSS 结构化文章",
        blocks: [
          { type: "paragraph", text: "正文第一段。" },
          { type: "link", link: { label: "查看全文", url: articleUrl } },
          { type: "link", link: { label: "下一篇：设备配置", url: nextUrl } },
          { type: "link", link: { label: "技术白皮书", url: whitepaperUrl } },
          { type: "paragraph", text: "正文第二段。" },
        ],
        navigation: [{ title: "首页", canonicalUrl: "https://example.com/" }],
        links: [
          { title: "查看全文", canonicalUrl: articleUrl },
          { title: "栏目：效率工具", canonicalUrl: categoryUrl },
          { title: "TrafficMonitor", canonicalUrl: referenceUrl },
          { title: "分析文章", canonicalUrl: analysisUrl },
        ],
        childLinks: [],
        provenance: {
          provider: "web",
          sourceUrl: "https://example.com/feed.xml",
          canonicalUrl: articleUrl,
          retrievedAt,
        },
        revision: null,
        license: null,
        attribution: { name: "RSS 作者", url: articleUrl },
        syndication: {
          author: "RSS 作者",
          publishedAt: "2026-07-20T00:00:00.000Z",
        },
      }],
    });

    const page = transformed.documents[0].content.page;
    expect(page.kind).toBe("detail");
    if (page.kind !== "detail") throw new Error("Expected detail page");
    expect(page.navigation).toEqual([
      {
        label: "查看全文",
        target: { kind: "url", url: articleUrl },
        description: "打开来源网站继续阅读",
      },
      {
        label: "下一篇：设备配置",
        target: { kind: "url", url: nextUrl },
        description: "打开相邻内容",
      },
      {
        label: "栏目：效率工具",
        target: { kind: "url", url: categoryUrl },
        description: "打开栏目导航",
      },
      {
        label: "首页",
        target: { kind: "url", url: "https://example.com/" },
      },
    ]);
    expect(page.content).toEqual([
      { type: "paragraph", text: "正文第一段。" },
      {
        type: "link",
        link: {
          label: "技术白皮书",
          target: { kind: "url", url: whitepaperUrl },
        },
      },
      { type: "paragraph", text: "正文第二段。" },
    ]);
    expect(page.links).toEqual([
      {
        label: "TrafficMonitor",
        target: { kind: "url", url: referenceUrl },
      },
      {
        label: "分析文章",
        target: { kind: "url", url: analysisUrl },
      },
    ]);
  });

  it("removes only a normalized duplicate first heading and preserves a distinct section heading", () => {
    const duplicateUrl = "https://example.com/repeated";
    const duplicate = transformIngestedSource({
      seedUrl: duplicateUrl,
      entryCanonicalUrl: duplicateUrl,
      limits: { maxDepth: 0, maxDocuments: 1 },
      pages: [{
        canonicalUrl: duplicateUrl,
        depth: 0,
        title: "Repeated　Title",
        blocks: [
          { type: "heading", level: 1, text: "Repeated Title" },
          { type: "paragraph", text: "Article body." },
          { type: "heading", level: 2, text: "Repeated Title" },
        ],
        childLinks: [],
        provenance: { provider: "web", sourceUrl: duplicateUrl, canonicalUrl: duplicateUrl, retrievedAt },
        revision: null,
        license: null,
        attribution: { name: "Example", url: duplicateUrl },
      }],
    });
    expect(duplicate.documents[0].content.page).toMatchObject({
      kind: "detail",
      content: [
        { type: "paragraph", text: "Article body." },
        { type: "heading", level: 2, text: "Repeated Title" },
      ],
    });

    const nookUrl = "https://zh.wikipedia.org/wiki/Nook#电子墨水屏系列";
    const nook = transformIngestedSource({
      seedUrl: nookUrl,
      entryCanonicalUrl: nookUrl,
      limits: { maxDepth: 0, maxDocuments: 1 },
      pages: [{
        canonicalUrl: nookUrl,
        depth: 0,
        title: "Nook — 电子墨水屏系列",
        blocks: [
          { type: "heading", level: 3, text: "电子墨水屏系列" },
          { type: "paragraph", text: "章节正文。" },
        ],
        childLinks: [],
        provenance: { provider: "wikimedia", sourceUrl: nookUrl, canonicalUrl: nookUrl, retrievedAt },
        revision: null,
        license: null,
        attribution: { name: "Wikipedia contributors", url: nookUrl },
      }],
    });
    expect(nook.documents[0].content.page).toMatchObject({
      kind: "detail",
      content: [
        { type: "heading", level: 3, text: "电子墨水屏系列" },
        { type: "paragraph", text: "章节正文。" },
      ],
    });
  });

  it("splits a 20k+ rendered leaf at paragraph, sentence, then Unicode-safe hard boundaries", () => {
    const url = "https://example.com/book";
    const giantLeaf = `${"甲".repeat(12_000)}。${"乙".repeat(10_000)}！\n\n丙${"𠮷".repeat(10_250)}`;
    const transformed = transformIngestedSource({
      seedUrl: url,
      entryCanonicalUrl: url,
      limits: { maxDepth: 0, maxDocuments: 1 },
      pages: [{
        canonicalUrl: url,
        depth: 0,
        title: "长篇正文",
        blocks: [
          { type: "heading", level: 2, text: "第一章" },
          { type: "paragraph", text: giantLeaf },
          { type: "quote", text: `${"引".repeat(20_100)}。`, attribution: "作者" },
        ],
        links: [{ title: "下一章", canonicalUrl: "https://example.com/book/chapter-2" }],
        childLinks: [],
        provenance: { provider: "web", sourceUrl: url, canonicalUrl: url, retrievedAt },
        revision: null,
        license: null,
        attribution: { name: "Example", url },
      }],
    });
    const page = transformed.documents[0].content.page;
    expect(page.kind).toBe("detail");
    if (page.kind !== "detail") throw new Error("Expected detail page");

    const paragraphs = page.content.filter((block) => block.type === "paragraph");
    expect(paragraphs.length).toBeGreaterThan(2);
    expect(paragraphs.every((block) => block.text.length <= 20_000)).toBe(true);
    expect(paragraphs.every((block) => !/[\uD800-\uDBFF]$/u.test(block.text))).toBe(true);
    expect(paragraphs.map((block) => block.text).join("").replace(/\s/gu, ""))
      .toBe(giantLeaf.replace(/\s/gu, ""));

    const quotes = page.content.filter((block) => block.type === "quote");
    expect(quotes.length).toBe(2);
    expect(quotes.every((block) => block.text.length <= 20_000)).toBe(true);
    expect(quotes[0]).not.toHaveProperty("attribution");
    expect(quotes[1]).toMatchObject({ attribution: "作者" });
    expect(page.links).toEqual(expect.arrayContaining([{
      label: "下一章",
      target: { kind: "url", url: "https://example.com/book/chapter-2" },
    }]));
  });

  it("normalizes oversized semantic lists before applying maxDetailBlocks", () => {
    const url = "https://example.com/directory";
    const longItem = "尾".repeat(1_201);
    const directoryItems = Array.from({ length: 130 }, (_, index) => `目录 ${index + 1}`);
    const listItems = [longItem, ...directoryItems];
    const transformed = transformIngestedSource({
      seedUrl: url,
      entryCanonicalUrl: url,
      limits: { maxDepth: 0, maxDocuments: 1 },
      pages: [{
        canonicalUrl: url,
        depth: 0,
        title: "目录",
        blocks: [
          { type: "list", ordered: true, items: listItems },
        ],
        childLinks: [],
        provenance: { provider: "web", sourceUrl: url, canonicalUrl: url, retrievedAt },
        revision: null,
        license: null,
        attribution: { name: "Example", url },
      }],
    }, { maxDetailBlocks: 2 });
    const page = transformed.documents[0].content.page;
    expect(page.kind).toBe("detail");
    if (page.kind !== "detail") throw new Error("Expected detail page");

    const lists = page.content.filter((block) => block.type === "list");
    expect(lists).toHaveLength(2);
    expect(lists.every((block) => block.items.length <= 64)).toBe(true);
    expect(lists.every((block) => block.items.every((item) => item.length <= 500))).toBe(true);
    const normalizedItems = lists.flatMap((block) => block.items);
    expect(normalizedItems.slice(0, 3).join("")).toBe(longItem);
    expect(normalizedItems.slice(3)).toEqual(directoryItems.slice(0, 125));
  });
});
