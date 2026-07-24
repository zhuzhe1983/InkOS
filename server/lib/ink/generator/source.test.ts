import { describe, expect, it, vi } from "vitest";

import {
  ingestSource,
  SourceIngestionError,
  WIKIMEDIA_USER_AGENT,
} from "./source";

const FIXED_NOW = new Date("2026-07-16T08:00:00.000Z");

function publicLookup() {
  return vi.fn(async () => [{ address: "93.184.216.34", family: 4 }] as const);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function htmlResponse(html: string, headers: Record<string, string> = {}): Response {
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

function xmlResponse(xml: string, contentType: string): Response {
  return new Response(xml, {
    status: 200,
    headers: { "content-type": `${contentType}; charset=utf-8` },
  });
}

function wikiMetadata(options: {
  title: string;
  canonicalUrl: string;
  pageId: number;
  revisionId?: number;
  locale?: string;
}) {
  return {
    query: {
      general: { sitename: "Wikipedia", lang: options.locale ?? "zh" },
      rightsinfo: {
        text: "Creative Commons Attribution-Share Alike 4.0",
        url: "https://creativecommons.org/licenses/by-sa/4.0/",
      },
      pages: [{
        pageid: options.pageId,
        ns: 0,
        title: options.title,
        pagelanguagehtmlcode: options.locale ?? "zh",
        canonicalurl: options.canonicalUrl,
        fullurl: options.canonicalUrl,
        lastrevid: options.revisionId ?? 42,
        revisions: [{
          revid: options.revisionId ?? 42,
          timestamp: "2026-07-01T00:00:00Z",
        }],
      }],
    },
  };
}

function actionUrl(input: string | URL): URL {
  return input instanceof URL ? input : new URL(input);
}

describe("safe source ingestion", () => {
  it("converts RSS 2.0 into a semantic feed with safe HTTPS links, dates and images", async () => {
    const fetcher = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("accept")).toContain("application/rss+xml");
      return xmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
          <channel>
            <title>InkOS Daily</title>
            <link>https://example.com/</link>
            <description><![CDATA[<p>Fresh e-paper reading.</p>]]></description>
            <language>zh-CN</language>
            <lastBuildDate>Thu, 16 Jul 2026 08:00:00 GMT</lastBuildDate>
            <item>
              <title>First story</title>
              <link>https://example.com/posts/first</link>
              <description>&lt;p&gt;First &lt;strong&gt;summary&lt;/strong&gt;.&lt;/p&gt;&lt;p&gt;&lt;a href="https://example.com/posts/first"&gt;查看全文&lt;/a&gt;&lt;/p&gt;</description>
              <pubDate>Thu, 16 Jul 2026 07:30:00 GMT</pubDate>
              <media:content url="https://cdn.example.com/first.jpg" type="image/jpeg" />
            </item>
            <item>
              <title>Second story</title>
              <link>https://example.com/posts/second</link>
              <description><![CDATA[<p>Second summary.</p><img src="https://cdn.example.com/second.png" />]]></description>
              <pubDate>2026-07-15T12:00:00+08:00</pubDate>
            </item>
            <item>
              <title>Unsafe cleartext destination</title>
              <link>http://internal.example/private</link>
            </item>
          </channel>
        </rss>`, "application/rss+xml");
    });

    const result = await ingestSource({
      seedUrl: "https://example.com/feed.xml",
      mode: "http",
      maxDepth: 0,
      maxDocuments: 1,
    }, { fetch: fetcher, lookup: publicLookup(), now: () => FIXED_NOW });

    expect(result.entryCanonicalUrl).toBe("https://example.com/feed.xml");
    expect(result.pages[0]).toMatchObject({
      title: "InkOS Daily",
      locale: "zh-CN",
      blocks: [{ type: "paragraph", text: "Fresh e-paper reading." }],
      revision: {
        id: String(Date.parse("2026-07-16T08:00:00.000Z")),
        timestamp: "2026-07-16T08:00:00.000Z",
      },
    });
    expect(result.pages[0].feedItems).toEqual([
      {
        title: "First story",
        summary: "First summary.",
        publishedAt: "2026-07-16T07:30:00.000Z",
        image: { url: "https://cdn.example.com/first.jpg", alt: "First story" },
        canonicalUrl: "https://example.com/posts/first",
      },
      {
        title: "Second story",
        summary: "Second summary.",
        publishedAt: "2026-07-15T04:00:00.000Z",
        image: { url: "https://cdn.example.com/second.png", alt: "Second story" },
        canonicalUrl: "https://example.com/posts/second",
      },
    ]);
    expect(JSON.stringify(result.pages[0])).not.toContain("internal.example");
  });

  it("honors RSS content precedence and inherited xml:base for links and images", async () => {
    const fetcher = vi.fn(async () => xmlResponse(`<?xml version="1.0" encoding="utf-8"?>
      <rss version="2.0"
           xmlns:content="http://purl.org/rss/1.0/modules/content/"
           xmlns:dc="http://purl.org/dc/elements/1.1/"
           xmlns:media="http://search.yahoo.com/mrss/">
        <channel xml:base="https://example.com/news/">
          <title>Base-aware RSS</title>
          <link>./</link>
          <description>频道说明</description>
          <item xml:base="2026/">
            <title>RSS precedence</title>
            <link>story.html</link>
            <dc:creator>命名空间作者</dc:creator>
            <dc:date>2026-07-23T12:00:00Z</dc:date>
            <pubDate>Fri, 24 Jul 2026 06:30:00 GMT</pubDate>
            <description><![CDATA[
              <p>这是一段比正文更长的列表摘要，但它仍然只负责列表预览，不能因为字符更多就覆盖 content encoded 的正文优先级。</p>
            ]]></description>
            <content:encoded xml:base="../assets/"><![CDATA[
              <p>较短的订阅正文仍应优先。</p>
              <p><a href="guide.html">正文链接</a></p>
              <img src="body.jpg" alt="正文图片">
            ]]></content:encoded>
            <media:thumbnail url="thumb.jpg" />
          </item>
        </channel>
      </rss>`, "application/rss+xml"));

    const result = await ingestSource({
      seedUrl: "https://example.com/feeds/rss.xml",
      mode: "http",
      maxDepth: 0,
      maxDocuments: 1,
    }, { fetch: fetcher, lookup: publicLookup(), now: () => FIXED_NOW });

    expect(result.pages[0].attribution.url).toBe("https://example.com/news/");
    expect(result.pages[0].feedItems).toEqual([{
      title: "RSS precedence",
      summary: "这是一段比正文更长的列表摘要，但它仍然只负责列表预览，不能因为字符更多就覆盖 content encoded 的正文优先级。",
      author: "命名空间作者",
      publishedAt: "2026-07-24T06:30:00.000Z",
      image: {
        url: "https://example.com/news/2026/thumb.jpg",
        alt: "RSS precedence",
      },
      canonicalUrl: "https://example.com/news/2026/story.html",
      articleBody: {
        source: "rss-content-encoded",
        quality: "teaser",
        blocks: [
          { type: "paragraph", text: "较短的订阅正文仍应优先。" },
          {
            type: "link",
            link: {
              label: "正文链接",
              url: "https://example.com/news/assets/guide.html",
            },
          },
          {
            type: "image",
            image: {
              url: "https://example.com/news/assets/body.jpg",
              alt: "正文图片",
            },
          },
        ],
        links: [{
          title: "正文链接",
          canonicalUrl: "https://example.com/news/assets/guide.html",
        }],
      },
    }]);
  });

  it("converts an Atom response captured by Chromium and drops unsafe entries", async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en">
        <title>Release notes</title>
        <subtitle>Stable project updates</subtitle>
        <updated>2026-07-16T08:05:00Z</updated>
        <link rel="alternate" href="https://example.org/releases" />
        <entry>
          <title>Version 2.0</title>
          <link rel="alternate" href="https://example.org/releases/2" />
          <link rel="enclosure" type="image/png" href="https://cdn.example.org/v2.png" />
          <published>2026-07-16T08:00:00Z</published>
          <summary type="html">&lt;p&gt;Faster and clearer.&lt;/p&gt;&lt;a href="https://example.org/releases/2"&gt;Continue reading ›&lt;/a&gt;</summary>
        </entry>
        <entry>
          <title>Unsafe entry</title>
          <link rel="alternate" href="http://localhost/private" />
        </entry>
      </feed>`;
    const capture = vi.fn(async () => ({
      requestedUrl: "https://example.org/atom.xml",
      finalUrl: "https://example.org/atom.xml",
      status: 200,
      title: "Syndication feed",
      partial: false,
      warnings: [],
      timings: {
        browserAcquireMs: 10,
        navigateMs: 20,
        domSettleMs: 0,
        captureMs: 0,
        totalMs: 30,
      },
      html: xml,
    }));

    const result = await ingestSource({
      seedUrl: "https://example.org/atom.xml",
      mode: "chromium",
      maxDepth: 0,
      maxDocuments: 1,
    }, { capture, lookup: publicLookup(), now: () => FIXED_NOW });

    expect(result.pages[0]).toMatchObject({
      title: "Release notes",
      locale: "en",
      attribution: { name: "Release notes", url: "https://example.org/releases" },
      feedItems: [{
        title: "Version 2.0",
        summary: "Faster and clearer.",
        publishedAt: "2026-07-16T08:00:00.000Z",
        image: { url: "https://cdn.example.org/v2.png", alt: "Version 2.0" },
        canonicalUrl: "https://example.org/releases/2",
      }],
    });
    expect(result.timings).toMatchObject({ chromium_total_ms: 30, navigate_ms: 20 });
    expect(JSON.stringify(result.pages[0])).not.toContain("localhost");
  });

  it("prefers full Atom HTML over its teaser and materializes a semantic detail without a second capture", async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom" xml:lang="zh-CN">
        <title>完整内容订阅</title>
        <subtitle>频道说明</subtitle>
        <link rel="alternate" href="https://www.ruanyifeng.com/blog/" />
        <entry>
          <title>完整文章</title>
          <link rel="alternate" href="https://www.ruanyifeng.com/blog/2026/07/full.html" />
          <author><name>测试作者</name></author>
          <published>2026-07-20T08:00:00+08:00</published>
          <summary type="html">&lt;p&gt;这是列表使用的短摘要。&lt;/p&gt;</summary>
          <content type="html" xml:base="http://www.ruanyifeng.com/blog/">&lt;h2&gt;正文小节&lt;/h2&gt;
            &lt;p&gt;这是订阅携带的完整正文第一段，它包含足够的信息用于判断这不是一个只负责引流的短摘要，并且应当直接成为设备上的详情内容。&lt;/p&gt;
            &lt;p&gt;这是完整正文第二段，继续说明 HTML 会先转成 Markdown，再归一化为标题、段落、列表、引用、图片和安全链接等语义块。&lt;/p&gt;
            &lt;ul&gt;&lt;li&gt;保留列表&lt;/li&gt;&lt;li&gt;保持顺序&lt;/li&gt;&lt;/ul&gt;
            &lt;blockquote&gt;结构先于坐标。&lt;/blockquote&gt;
            &lt;p&gt;&lt;a href="../read/full"&gt;相关阅读&lt;/a&gt;&lt;/p&gt;
            &lt;img src="../images/full.jpg" alt="正文配图"&gt;
          </content>
        </entry>
      </feed>`;
    const capture = vi.fn(async (url: string) => {
      expect(url).toBe("https://www.ruanyifeng.com/blog/atom.xml");
      return {
        requestedUrl: url,
        finalUrl: url,
        status: 200,
        title: "Syndication feed",
        partial: false,
        warnings: [],
        timings: {
          browserAcquireMs: 1,
          navigateMs: 2,
          domSettleMs: 0,
          captureMs: 0,
          totalMs: 3,
        },
        html: xml,
      };
    });

    const result = await ingestSource({
      seedUrl: "https://www.ruanyifeng.com/blog/atom.xml",
      mode: "chromium",
      maxDepth: 1,
      maxDocuments: 2,
    }, { capture, lookup: publicLookup(), now: () => FIXED_NOW });

    expect(capture).toHaveBeenCalledTimes(1);
    expect(result.pages).toHaveLength(2);
    expect(result.pages[0]).toMatchObject({
      isSyndicationFeed: true,
      title: "完整内容订阅",
      blocks: [{ type: "paragraph", text: "频道说明" }],
      feedItems: [{
        title: "完整文章",
        summary: "这是列表使用的短摘要。",
        author: "测试作者",
        publishedAt: "2026-07-20T00:00:00.000Z",
        image: {
          url: "https://www.ruanyifeng.com/images/full.jpg",
          alt: "完整文章",
        },
        articleBody: {
          source: "atom-content",
          quality: "substantive",
        },
      }],
    });
    expect(result.pages[0].feedItems?.[0].articleBody?.links).toEqual([{
      title: "相关阅读",
      canonicalUrl: "https://www.ruanyifeng.com/read/full",
    }]);
    expect(result.pages[1]).toMatchObject({
      canonicalUrl: "https://www.ruanyifeng.com/blog/2026/07/full.html",
      parentCanonicalUrl: "https://www.ruanyifeng.com/blog/atom.xml",
      title: "完整文章",
      attribution: {
        name: "测试作者",
        url: "https://www.ruanyifeng.com/blog/2026/07/full.html",
      },
      syndication: {
        author: "测试作者",
        publishedAt: "2026-07-20T00:00:00.000Z",
        summary: "这是列表使用的短摘要。",
      },
    });
    expect(result.pages[1].blocks).toContainEqual({
      type: "image",
      image: {
        url: "https://www.ruanyifeng.com/images/full.jpg",
        alt: "正文配图",
      },
    });
    expect(JSON.stringify(result.pages)).not.toMatch(/<script|style=|xml:base/iu);
  });

  it("inherits Atom feed/source metadata and safely degrades content src", async () => {
    const fetcher = vi.fn(async () => xmlResponse(`<?xml version="1.0" encoding="utf-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom"
            xml:lang="zh-CN"
            xml:base="https://example.org/journal/">
        <title>Base-aware Atom</title>
        <subtitle>Atom channel</subtitle>
        <author><name>Feed Author</name></author>
        <link rel="alternate" href="../home" />
        <entry xml:base="2026/">
          <title>Source author entry</title>
          <link rel="alternate" xml:base="stories/" href="first.html" />
          <link rel="enclosure" type="image/jpeg" href="cover.jpg" />
          <source><author><name>Source Author</name></author></source>
          <updated>2026-07-24T09:00:00Z</updated>
          <published>2026-07-23T08:00:00Z</published>
          <summary type="html">&lt;p&gt;更长的 Atom 列表摘要仍然不能覆盖 content 正文。&lt;/p&gt;</summary>
          <content type="html" xml:base="../assets/">&lt;p&gt;Atom 正文优先。&lt;/p&gt;
            &lt;div xml:base="nested/"&gt;
              &lt;p&gt;&lt;a href="guide.html#part"&gt;Atom 正文链接&lt;/a&gt;&lt;/p&gt;
              &lt;img src="body.jpg" alt="Atom 正文图片"&gt;
            &lt;/div&gt;
          </content>
        </entry>
        <entry xml:base="2026/">
          <title>External Atom content</title>
          <link rel="alternate" href="summary.html" />
          <updated>2026-07-22T07:00:00Z</updated>
          <published>not-a-date</published>
          <summary type="html">&lt;p&gt;外部正文的安全摘要。&lt;/p&gt;</summary>
          <content type="html" xml:base="../payload/" src="full.html" />
        </entry>
        <entry>
          <title>Unsafe external content</title>
          <id>tag:example.org,2026:unsafe</id>
          <content type="html" src="http://elsewhere.example/private" />
        </entry>
      </feed>`, "application/atom+xml"));

    const result = await ingestSource({
      seedUrl: "https://example.org/feeds/atom.xml",
      mode: "http",
      maxDepth: 0,
      maxDocuments: 1,
    }, { fetch: fetcher, lookup: publicLookup(), now: () => FIXED_NOW });

    expect(result.pages[0].attribution.url).toBe("https://example.org/home");
    expect(result.pages[0].feedItems).toHaveLength(2);
    expect(result.pages[0].feedItems?.[0]).toEqual({
      title: "Source author entry",
      summary: "更长的 Atom 列表摘要仍然不能覆盖 content 正文。",
      author: "Source Author",
      publishedAt: "2026-07-23T08:00:00.000Z",
      image: {
        url: "https://example.org/journal/2026/cover.jpg",
        alt: "Source author entry",
      },
      canonicalUrl: "https://example.org/journal/2026/stories/first.html",
      articleBody: {
        source: "atom-content",
        quality: "teaser",
        blocks: [
          { type: "paragraph", text: "Atom 正文优先。" },
          {
            type: "link",
            link: {
              label: "Atom 正文链接",
              url: "https://example.org/journal/assets/nested/guide.html#part",
            },
          },
          {
            type: "image",
            image: {
              url: "https://example.org/journal/assets/nested/body.jpg",
              alt: "Atom 正文图片",
            },
          },
        ],
        links: [{
          title: "Atom 正文链接",
          canonicalUrl: "https://example.org/journal/assets/nested/guide.html#part",
        }],
      },
    });
    expect(result.pages[0].feedItems?.[1]).toEqual({
      title: "External Atom content",
      summary: "外部正文的安全摘要。",
      author: "Feed Author",
      publishedAt: "2026-07-22T07:00:00.000Z",
      canonicalUrl: "https://example.org/journal/2026/summary.html",
      articleBody: {
        source: "atom-summary",
        quality: "teaser",
        blocks: [{ type: "paragraph", text: "外部正文的安全摘要。" }],
        links: [{
          title: "查看订阅正文",
          canonicalUrl: "https://example.org/journal/payload/full.html",
        }],
      },
    });
    expect(JSON.stringify(result.pages[0])).not.toContain("elsewhere.example");
  });

  it("keeps Atom text constructs literal instead of interpreting angle brackets as HTML", async () => {
    const fetcher = vi.fn(async () => xmlResponse(`<?xml version="1.0" encoding="utf-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Literal Atom</title>
        <link rel="alternate" href="https://example.org/" />
        <entry>
          <title>Generic syntax</title>
          <link rel="alternate" href="https://example.org/posts/generics" />
          <summary type="text">Summary with &lt;T&gt;.</summary>
          <content type="text">Use &lt;code&gt;x &amp; y&lt;/code&gt; with &lt;T&gt; literally.</content>
        </entry>
      </feed>`, "application/atom+xml"));

    const result = await ingestSource({
      seedUrl: "https://example.org/feed.xml",
      mode: "http",
      maxDepth: 0,
      maxDocuments: 1,
    }, { fetch: fetcher, lookup: publicLookup(), now: () => FIXED_NOW });

    expect(result.pages[0].feedItems?.[0]).toMatchObject({
      summary: "Summary with <T>.",
      articleBody: {
        source: "atom-content",
        blocks: [{
          type: "paragraph",
          text: "Use <code>x & y</code> with <T> literally.",
        }],
        links: [],
      },
    });
  });

  it("inherits RSS document-root xml:base through channel and item URLs", async () => {
    const fetcher = vi.fn(async () => xmlResponse(`<?xml version="1.0" encoding="utf-8"?>
      <rss version="2.0" xml:base="https://content.example/base/">
        <channel>
          <title>Root Base RSS</title>
          <link>./</link>
          <description>Root base channel</description>
          <item>
            <title>Relative story</title>
            <link>stories/one.html</link>
            <description><![CDATA[
              <p>Body from root base.</p>
              <img src="images/one.jpg" alt="Root image">
            ]]></description>
          </item>
        </channel>
      </rss>`, "application/rss+xml"));

    const result = await ingestSource({
      seedUrl: "https://feeds.example/rss.xml",
      mode: "http",
      maxDepth: 0,
      maxDocuments: 1,
    }, { fetch: fetcher, lookup: publicLookup(), now: () => FIXED_NOW });

    expect(result.pages[0].attribution.url).toBe("https://content.example/base/");
    expect(result.pages[0].feedItems?.[0]).toMatchObject({
      canonicalUrl: "https://content.example/base/stories/one.html",
      image: {
        url: "https://content.example/base/images/one.jpg",
        alt: "Relative story",
      },
    });
  });

  it("keeps a title-and-link-only RSS item usable without inventing optional fields", async () => {
    const fetcher = vi.fn(async () => xmlResponse(`<?xml version="1.0" encoding="utf-8"?>
      <rss version="2.0">
        <channel>
          <title>Minimal feed</title>
          <link>https://example.net/</link>
          <item>
            <title>Minimal article</title>
            <link>https://example.net/articles/minimal</link>
          </item>
        </channel>
      </rss>`, "application/rss+xml"));

    const result = await ingestSource({
      seedUrl: "https://example.net/feed.xml",
      mode: "http",
      maxDepth: 0,
      maxDocuments: 1,
    }, { fetch: fetcher, lookup: publicLookup(), now: () => FIXED_NOW });

    expect(result.pages[0].blocks).toEqual([
      { type: "paragraph", text: "Minimal feed RSS/Atom feed" },
    ]);
    expect(result.pages[0].feedItems).toEqual([{
      title: "Minimal article",
      canonicalUrl: "https://example.net/articles/minimal",
    }]);
    expect(result.pages[0]).not.toHaveProperty("locale");
    expect(result.pages[0].feedItems?.[0]).not.toHaveProperty("summary");
    expect(result.pages[0].feedItems?.[0]).not.toHaveProperty("publishedAt");
    expect(result.pages[0].feedItems?.[0]).not.toHaveProperty("image");
  });

  it("materializes a source-link detail when a sparse feed item's linked page is unavailable", async () => {
    const fetcher = vi.fn(async (input: string | URL) => {
      const url = actionUrl(input);
      if (url.href !== "https://example.net/feed.xml") {
        throw new TypeError("linked article unavailable");
      }
      return xmlResponse(`<?xml version="1.0" encoding="utf-8"?>
        <rss version="2.0">
          <channel>
            <title>Sparse feed</title>
            <link>https://example.net/</link>
            <item>
              <title>Link-only article</title>
              <link>https://example.net/articles/link-only</link>
            </item>
          </channel>
        </rss>`, "application/rss+xml");
    });

    const result = await ingestSource({
      seedUrl: "https://example.net/feed.xml",
      mode: "http",
      maxDepth: 1,
      maxDocuments: 2,
    }, { fetch: fetcher, lookup: publicLookup(), now: () => FIXED_NOW });

    expect(result.pages).toHaveLength(2);
    expect(result.pages[1]).toMatchObject({
      canonicalUrl: "https://example.net/articles/link-only",
      title: "Link-only article",
      blocks: [{
        type: "link",
        link: {
          label: "查看原文",
          url: "https://example.net/articles/link-only",
        },
      }],
      syndication: {},
    });
  });

  it("upgrades legacy same-host cleartext feed permalinks to HTTPS only", async () => {
    const fetcher = vi.fn(async () => xmlResponse(`<?xml version="1.0" encoding="utf-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom" xml:lang="zh-CN">
        <title>Legacy HTTPS feed</title>
        <link rel="alternate" href="http://example.org/blog/" />
        <entry>
          <title>Still-published legacy permalink</title>
          <link rel="alternate" href="http://example.org/blog/post-1.html" />
          <updated>2026-07-18T08:00:00Z</updated>
        </entry>
        <entry>
          <title>Cross-host cleartext stays blocked</title>
          <link rel="alternate" href="http://elsewhere.example/post-2" />
        </entry>
      </feed>`, "application/atom+xml"));

    const result = await ingestSource({
      seedUrl: "https://example.org/feed.xml",
      mode: "http",
      maxDepth: 0,
      maxDocuments: 1,
    }, { fetch: fetcher, lookup: publicLookup(), now: () => FIXED_NOW });

    expect(result.pages[0].attribution.url).toBe("https://example.org/blog/");
    expect(result.pages[0].feedItems).toEqual([{
      title: "Still-published legacy permalink",
      publishedAt: "2026-07-18T08:00:00.000Z",
      canonicalUrl: "https://example.org/blog/post-1.html",
    }]);
    expect(JSON.stringify(result.pages[0])).not.toContain("elsewhere.example");
  });

  it("uses Tieba's public hot-topic data when its HTML landing page is blocked", async () => {
    const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = actionUrl(input);
      expect(url.href).toBe("https://tieba.baidu.com/hottopic/browse/topicList");
      expect(new Headers(init?.headers).get("accept")).toBe("application/json");
      return jsonResponse({
        data: {
          bang_topic: {
            topic_list: [{
              topic_name: "墨水屏阅读体验",
              topic_desc: "大家在讨论高 DPI 墨水屏。",
              discuss_num: 1234,
              create_time: 1784383185,
              topic_pic: "https://tiebapic.baidu.com/forum/pic/item/example.jpg",
              topic_url: "https://tieba.baidu.com/hottopic/browse/hottopic?topic_id=42&amp;topic_name=ink",
            }, {
              topic_name: "不安全话题",
              topic_url: "http://tieba.baidu.com/unsafe",
            }],
          },
        },
      });
    });
    const capture = vi.fn();

    const result = await ingestSource({
      seedUrl: "https://tieba.baidu.com/",
      mode: "chromium",
      maxDepth: 0,
      maxDocuments: 1,
    }, { fetch: fetcher, capture, lookup: publicLookup(), now: () => FIXED_NOW });

    expect(capture).not.toHaveBeenCalled();
    expect(result.pages[0]).toMatchObject({
      canonicalUrl: "https://tieba.baidu.com/",
      title: "百度贴吧 · 热议话题",
      locale: "zh-CN",
      attribution: { name: "百度贴吧", url: "https://tieba.baidu.com/" },
      feedItems: [{
        title: "墨水屏阅读体验",
        summary: "大家在讨论高 DPI 墨水屏。 · 1,234 次讨论",
        image: {
          url: "https://tiebapic.baidu.com/forum/pic/item/example.jpg",
          alt: "墨水屏阅读体验",
        },
        canonicalUrl: "https://tieba.baidu.com/hottopic/browse/hottopic?topic_id=42&topic_name=ink",
      }],
    });
    expect(result.pages[0].revision?.id).toMatch(/^json-sha256:[0-9a-f]{64}$/u);
    expect(JSON.stringify(result.pages[0])).not.toContain("/unsafe");
  });

  it("rejects syndication DTD/entity declarations as inert-data violations", async () => {
    const fetcher = vi.fn(async () => xmlResponse(`<?xml version="1.0"?>
      <!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
      <rss version="2.0"><channel><title>&xxe;</title>
        <item><title>Story</title><link>https://example.com/story</link></item>
      </channel></rss>`, "application/rss+xml"));

    await expect(ingestSource({
      seedUrl: "https://example.com/feed.xml",
      mode: "http",
    }, { fetch: fetcher, lookup: publicLookup() })).rejects.toMatchObject({
      code: "SOURCE_BLOCKED",
    });
  });

  it("honors a Wikimedia anchor by resolving and parsing only that section", async () => {
    const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = actionUrl(input);
      expect(url.pathname).toBe("/w/api.php");
      expect(url.searchParams.get("maxlag")).toBe("5");
      expect(new Headers(init?.headers).get("user-agent")).toBe(WIKIMEDIA_USER_AGENT);

      if (url.searchParams.get("action") === "query") {
        return jsonResponse(wikiMetadata({
          title: "Nook",
          canonicalUrl: "https://zh.wikipedia.org/wiki/Nook",
          pageId: 1737574,
          revisionId: 79939623,
        }));
      }
      if (url.searchParams.get("prop") === "tocdata") {
        return jsonResponse({
          parse: {
            tocdata: {
              sections: [
                { index: "1", line: "历史", anchor: "历史" },
                { index: "2", line: "电子墨水屏系列", anchor: "电子墨水屏系列" },
                { index: "5", line: "彩色液晶显示屏系列", anchor: "彩色液晶显示屏系列" },
              ],
            },
          },
        });
      }
      expect(url.searchParams.get("section")).toBe("2");
      return jsonResponse({
        parse: {
          displaytitle: "Nook",
          text: "<div class='mw-parser-output'><h3>电子墨水屏系列</h3><p>这里只保留电子墨水屏内容。</p></div>",
          links: [],
          revid: 79939623,
        },
      });
    });

    const result = await ingestSource({
      seedUrl: "https://zh.wikipedia.org/wiki/Nook#%E7%94%B5%E5%AD%90%E5%A2%A8%E6%B0%B4%E5%B1%8F%E7%B3%BB%E5%88%97",
      maxDepth: 0,
      maxDocuments: 8,
    }, {
      fetch: fetcher,
      lookup: publicLookup(),
      now: () => FIXED_NOW,
    });

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].canonicalUrl).toContain("#%E7%94%B5%E5%AD%90%E5%A2%A8%E6%B0%B4%E5%B1%8F%E7%B3%BB%E5%88%97");
    expect(result.pages[0].title).toBe("Nook — 电子墨水屏系列");
    expect(result.pages[0].blocks).toEqual([
      { type: "heading", level: 3, text: "电子墨水屏系列" },
      { type: "paragraph", text: "这里只保留电子墨水屏内容。" },
    ]);
    expect(result.pages[0].provenance.provider).toBe("wikimedia");
    expect(result.pages[0].revision?.id).toBe("79939623");
    expect(result.pages[0].license?.name).toContain("Creative Commons");
    expect(result.pages[0].attribution.name).toBe("Wikipedia contributors");
  });

  it("crawls only namespace-0 Wikimedia links, respects maxDocuments, and canonicalizes redirects", async () => {
    const queriedTitles: string[] = [];
    const fetcher = vi.fn(async (input: string | URL) => {
      const url = actionUrl(input);
      const action = url.searchParams.get("action");
      const title = url.searchParams.get("titles");
      if (action === "query" && title) {
        queriedTitles.push(title);
        if (title === "Root") {
          return jsonResponse(wikiMetadata({
            title: "Root",
            canonicalUrl: "https://en.wikipedia.org/wiki/Root",
            pageId: 1,
            locale: "en",
          }));
        }
        expect(title).toBe("Alias A");
        return jsonResponse(wikiMetadata({
          title: "Canonical A",
          canonicalUrl: "https://en.wikipedia.org/wiki/Canonical_A",
          pageId: 2,
          locale: "en",
        }));
      }
      if (url.searchParams.get("pageid") === "1") {
        return jsonResponse({
          parse: {
            displaytitle: "Root",
            text: "<div class='mw-parser-output'><h1>Root</h1><p>Entry text.</p></div>",
            links: [
              { ns: 1, title: "Talk:Root", exists: true },
              { ns: 0, title: "Alias A", exists: true },
              { ns: 0, title: "Child B", exists: true },
            ],
          },
        });
      }
      return jsonResponse({
        parse: {
          displaytitle: "Canonical A",
          text: "<div class='mw-parser-output'><h1>Canonical A</h1><p>Child text.</p></div>",
          links: [],
        },
      });
    });

    const result = await ingestSource({
      seedUrl: "https://en.wikipedia.org/wiki/Root",
      maxDepth: 1,
      maxDocuments: 2,
    }, {
      fetch: fetcher,
      lookup: publicLookup(),
      now: () => FIXED_NOW,
    });

    expect(result.pages.map((page) => page.canonicalUrl)).toEqual([
      "https://en.wikipedia.org/wiki/Root",
      "https://en.wikipedia.org/wiki/Canonical_A",
    ]);
    expect(result.pages[0].childLinks).toEqual([
      { title: "Alias A", canonicalUrl: "https://en.wikipedia.org/wiki/Canonical_A" },
    ]);
    expect(result.pages[1].parentCanonicalUrl).toBe(result.pages[0].canonicalUrl);
    expect(queriedTitles).toEqual(["Root", "Alias A"]);
    expect(queriedTitles).not.toContain("Talk:Root");
    expect(queriedTitles).not.toContain("Child B");
  });

  it("adds the canonical Nook Simple Touch article for the requested Nook e-ink seed", async () => {
    const fetcher = vi.fn(async (input: string | URL) => {
      const url = actionUrl(input);
      const host = url.hostname;
      const title = url.searchParams.get("titles");
      if (url.searchParams.get("action") === "query") {
        return host === "zh.wikipedia.org"
          ? jsonResponse(wikiMetadata({
              title: "Nook",
              canonicalUrl: "https://zh.wikipedia.org/wiki/Nook",
              pageId: 10,
            }))
          : jsonResponse(wikiMetadata({
              title: "Nook Simple Touch",
              canonicalUrl: "https://en.wikipedia.org/wiki/Nook_Simple_Touch",
              pageId: 11,
              locale: "en",
            }));
      }
      if (url.searchParams.get("prop") === "tocdata") {
        return jsonResponse({
          parse: { tocdata: { sections: [{ index: "2", line: "电子墨水屏系列", anchor: "电子墨水屏系列" }] } },
        });
      }
      if (host === "zh.wikipedia.org") {
        return jsonResponse({
          parse: {
            displaytitle: "Nook",
            text: "<div class='mw-parser-output'><h3>电子墨水屏系列</h3><p>Nook 阅读器系列。</p></div>",
            links: [{ ns: 0, title: "Nook Simple Touch", exists: false }],
          },
        });
      }
      expect(title).toBeNull();
      return jsonResponse({
        parse: {
          displaytitle: "Nook Simple Touch",
          text: "<div class='mw-parser-output'><h1>Nook Simple Touch</h1><p>An e-reader.</p></div>",
          links: [],
        },
      });
    });

    const result = await ingestSource({
      seedUrl: "https://zh.wikipedia.org/wiki/Nook#电子墨水屏系列",
      maxDepth: 1,
      maxDocuments: 2,
    }, {
      fetch: fetcher,
      lookup: publicLookup(),
      now: () => FIXED_NOW,
    });

    expect(result.pages).toHaveLength(2);
    expect(result.pages[1]).toMatchObject({
      canonicalUrl: "https://en.wikipedia.org/wiki/Nook_Simple_Touch",
      title: "Nook Simple Touch",
      locale: "en",
      depth: 1,
    });
    expect(result.pages[0].childLinks).toEqual([
      { title: "Nook Simple Touch", canonicalUrl: "https://en.wikipedia.org/wiki/Nook_Simple_Touch" },
    ]);
  });

  it("rejects a redirect to a private address before issuing the redirected request", async () => {
    const fetcher = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "https://127.0.0.1/admin" },
    }));

    await expect(ingestSource({
      seedUrl: "https://example.com/article",
      maxDepth: 0,
      maxDocuments: 1,
    }, {
      fetch: fetcher,
      lookup: publicLookup(),
      now: () => FIXED_NOW,
    })).rejects.toMatchObject({ code: "SOURCE_BLOCKED" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a hostname if any DNS answer is private", async () => {
    const fetcher = vi.fn();
    const lookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.7", family: 4 },
    ]);

    await expect(ingestSource({ seedUrl: "https://example.com/" }, {
      fetch: fetcher,
      lookup,
    })).rejects.toMatchObject({ code: "SOURCE_BLOCKED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("allows an RFC 2544 fake-IP answer while retaining the other SSRF checks", async () => {
    const fetcher = vi.fn(async () => htmlResponse(`
      <!doctype html><html><head><title>Proxy egress</title></head><body>
        <main><h1>Proxy egress</h1><p>Content reached through trusted local TUN DNS.</p></main>
      </body></html>
    `));
    const lookup = vi.fn(async () => [{ address: "198.18.2.163", family: 4 }] as const);

    const result = await ingestSource({
      seedUrl: "https://www.cnbeta.com.tw/",
      maxDepth: 0,
      maxDocuments: 1,
    }, { fetch: fetcher, lookup, now: () => FIXED_NOW });

    expect(result.pages[0].title).toBe("Proxy egress");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a bracketed private IPv6 literal without attempting DNS or fetch", async () => {
    const fetcher = vi.fn();
    const lookup = vi.fn();

    await expect(ingestSource({ seedUrl: "https://[::1]/admin" }, {
      fetch: fetcher,
      lookup,
    })).rejects.toMatchObject({ code: "SOURCE_BLOCKED" });
    expect(lookup).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("extracts allowlisted generic HTML semantics without executing source HTML", async () => {
    const fetcher = vi.fn(async () => htmlResponse(`
      <!doctype html>
      <html lang="en">
        <head>
          <title>Fallback</title>
          <link rel="canonical" href="/guide" />
          <link rel="license" href="https://creativecommons.org/licenses/by/4.0/" title="CC BY 4.0" />
          <meta name="author" content="Example Author" />
        </head>
        <body>
          <main>
            <h1>Safe guide</h1>
            <script>globalThis.sourceExecuted = true</script>
            <p>First paragraph.</p>
            <h2>Steps</h2>
            <ol><li>One</li><li>Two</li></ol>
            <blockquote>Quoted words <cite>Author</cite></blockquote>
            <figure><img src="/cover.png" alt="Cover" /><figcaption>Book cover</figcaption></figure>
            <img class="author-avatar" src="/avatar.png" width="32" height="32" alt="Example Author" />
            <img src="/placeholder.gif" data-original="/article-large.jpg"
                 width="1200" height="800" alt="Lazy editorial photo" />
            <img class="share-icon" src="/qr.png" width="48" height="48" alt="Article QR code" />
            <a href="/child">Child page</a>
            <a href="https://other.example/private">External</a>
          </main>
        </body>
      </html>
    `, { etag: '"rev-1"' }));

    const result = await ingestSource({
      seedUrl: "https://example.com/start",
      maxDepth: 0,
      maxDocuments: 1,
    }, {
      fetch: fetcher,
      lookup: publicLookup(),
      now: () => FIXED_NOW,
    });

    expect(result.entryCanonicalUrl).toBe("https://example.com/guide");
    expect(result.pages[0]).toMatchObject({
      title: "Safe guide",
      locale: "en",
      revision: { id: 'etag:"rev-1"' },
      license: { name: "CC BY 4.0" },
      attribution: { name: "Example Author", url: "https://example.com/guide" },
    });
    expect(result.pages[0].blocks).toContainEqual({ type: "paragraph", text: "First paragraph." });
    expect(result.pages[0].blocks).toContainEqual({ type: "list", ordered: true, items: ["One", "Two"] });
    expect(result.pages[0].blocks).toContainEqual({ type: "quote", text: "Quoted words", attribution: "Author" });
    expect(result.pages[0].blocks).toContainEqual({
      type: "image",
      image: { url: "https://example.com/cover.png", alt: "Cover", caption: "Book cover" },
    });
    expect(result.pages[0].blocks).toContainEqual({
      type: "image",
      image: { url: "https://example.com/article-large.jpg", alt: "Lazy editorial photo" },
    });
    expect(result.pages[0].blocks).toContainEqual({
      type: "image",
      image: { url: "https://example.com/qr.png", alt: "Article QR code" },
    });
    expect(JSON.stringify(result.pages[0].blocks)).not.toContain("avatar.png");
    expect(JSON.stringify(result.pages[0].blocks)).not.toContain("placeholder.gif");
    expect(result.pages[0].blocks.some((block) => JSON.stringify(block).includes("sourceExecuted"))).toBe(false);
  });

  it("recognizes a repeated editorial feed and crawls its article links before ordinary navigation", async () => {
    const requestedPaths: string[] = [];
    const fetcher = vi.fn(async (input: string | URL) => {
      const url = actionUrl(input);
      requestedPaths.push(url.pathname);
      if (url.pathname !== "/") {
        const title = url.pathname.split("/").filter(Boolean).at(-1)?.toLocaleUpperCase() ?? "Story";
        return htmlResponse(`
          <!doctype html><html lang="en"><head><title>${title}</title></head>
          <body><main><article><h1>${title}</h1><p>Complete article body for ${title}.</p></article></main></body></html>
        `);
      }
      return htmlResponse(`
        <!doctype html><html lang="en"><head><title>Daily Wire</title></head><body>
          <main>
            <h1>Latest stories</h1>
            <nav><a href="/questions">Questions</a><a href="/archive">Archive</a></nav>
            <div class="article-feed">
              <article class="story-card">
                <img class="author-avatar" src="/people/alice.jpg" width="32" height="32" alt="Alice" />
                <h2><a href="/news/alpha">Alpha discovery</a></h2>
                <p class="story-excerpt">A concise Alpha summary.</p>
                <img class="featured-photo" src="/images/alpha.jpg" width="640" height="360" alt="Alpha landscape" />
              </article>
              <article class="story-card">
                <h2><a href="/news/beta">Beta launch</a></h2>
                <p class="story-excerpt">A concise Beta summary.</p>
                <img class="featured-photo" src="/images/beta.jpg" width="640" height="360" alt="Beta launch" />
              </article>
              <article class="story-card">
                <h2><a href="/news/gamma">Gamma field notes</a></h2>
                <p class="story-excerpt">A concise Gamma summary.</p>
                <img class="featured-photo" src="/images/gamma.jpg" width="640" height="360" alt="Gamma field" />
              </article>
            </div>
          </main>
        </body></html>
      `);
    });

    const result = await ingestSource({
      seedUrl: "https://example.com/",
      maxDepth: 1,
      maxDocuments: 4,
    }, {
      fetch: fetcher,
      lookup: publicLookup(),
      now: () => FIXED_NOW,
    });

    expect(requestedPaths).toEqual(["/", "/news/alpha", "/news/beta", "/news/gamma"]);
    expect(result.pages.map((page) => page.title)).toEqual([
      "Latest stories",
      "ALPHA",
      "BETA",
      "GAMMA",
    ]);
    expect(result.pages[0].feedItems).toEqual([
      {
        title: "Alpha discovery",
        summary: "A concise Alpha summary.",
        image: { url: "https://example.com/images/alpha.jpg", alt: "Alpha landscape" },
        canonicalUrl: "https://example.com/news/alpha",
      },
      {
        title: "Beta launch",
        summary: "A concise Beta summary.",
        image: { url: "https://example.com/images/beta.jpg", alt: "Beta launch" },
        canonicalUrl: "https://example.com/news/beta",
      },
      {
        title: "Gamma field notes",
        summary: "A concise Gamma summary.",
        image: { url: "https://example.com/images/gamma.jpg", alt: "Gamma field" },
        canonicalUrl: "https://example.com/news/gamma",
      },
    ]);
    expect(JSON.stringify(result.pages[0].feedItems)).not.toContain("alice.jpg");
    expect(JSON.stringify(result.pages[0].blocks)).not.toContain("alice.jpg");
    expect(result.pages[0].childLinks.map((link) => link.canonicalUrl)).toEqual([
      "https://example.com/news/alpha",
      "https://example.com/news/beta",
      "https://example.com/news/gamma",
    ]);
    expect(result.pages[0].navigation).toEqual([
      { title: "Questions", canonicalUrl: "https://example.com/questions" },
      { title: "Archive", canonicalUrl: "https://example.com/archive" },
    ]);
  });

  it("recognizes repeated whole-card links and keeps pagination out of crawl priority", async () => {
    const searchUrl = "https://example.com/ebooks/search/?query=l.zh";
    const requestedUrls: string[] = [];
    const capture = vi.fn(async (input: string) => {
      requestedUrls.push(input);
      const url = new URL(input);
      const timings = {
        browserAcquireMs: 1,
        navigateMs: 2,
        domSettleMs: 3,
        captureMs: 4,
        totalMs: 10,
      };
      if (url.pathname.startsWith("/ebooks/") && url.pathname !== "/ebooks/search/") {
        const title = url.pathname.endsWith("25716") ? "灵历集光" : "Book detail";
        return {
          requestedUrl: input,
          finalUrl: input,
          status: 200,
          title,
          locale: "zh",
          partial: false,
          warnings: [],
          timings,
          html: `<!doctype html><html lang="zh"><head><title>${title}</title></head><body>
            <main><article><h1>${title}</h1><p>这是图书详情页的完整正文，用于确认搜索结果中的书目链接会优先于捐赠、页脚和下一页链接进入抓取队列。这里再补充一段稳定的图书介绍，确保真实正文达到语义抽取的最低长度，并能作为独立详情页被保留。</p></article></main>
          </body></html>`,
        };
      }
      return {
        requestedUrl: input,
        finalUrl: input,
        status: 200,
        title: "Books: Language: Chinese",
        locale: "en",
        partial: false,
        warnings: [],
        timings,
        html: `<!doctype html><html lang="en"><head><title>Books: Language: Chinese</title></head><body>
          <header><a href="/donate/">Donate</a></header>
          <div id="content"><h1>Books: Language: Chinese</h1><ul class="results">
            <li class="statusline"><span class="links"><a title="Go to the next page of results." href="/ebooks/search/?query=l.zh&amp;start_index=26">Next</a></span></li>
            <li class="booklink"><a class="link" href="/ebooks/25716">
              <img class="cover-thumb" src="/cache/epub/25716/pg25716.cover.small.jpg" width="120" height="180" alt="" />
              <span class="content"><span class="title">灵历集光 (Chinese)</span><span class="subtitle">Shangjie Song</span><span class="extra">27039 downloads</span></span>
            </a></li>
            <li class="booklink"><a class="link" href="/ebooks/20968">
              <img class="cover-thumb" src="/cache/epub/20968/pg20968.cover.small.jpg" width="120" height="180" alt="" />
              <span class="content"><span class="title">Three Hundred Tang Poems, Volume 1 (Chinese)</span><span class="subtitle">Various</span><span class="extra">20925 downloads</span></span>
            </a></li>
            <li class="booklink"><a class="link" href="/ebooks/24141">
              <img class="cover-thumb" src="/cache/epub/24141/pg24141.cover.small.jpg" width="120" height="180" alt="" />
              <span class="content"><span class="title">警世通言 (Chinese)</span><span class="subtitle">Menglong Feng</span><span class="extra">10535 downloads</span></span>
            </a></li>
            <li class="statusline"><span class="links"><a title="Go to the next page of results." href="/ebooks/search/?query=l.zh&amp;start_index=26">Next</a></span></li>
          </ul></div>
          <footer><ul><li><a href="/about/">About Project Gutenberg</a></li></ul></footer>
        </body></html>`,
      };
    });

    const result = await ingestSource({
      seedUrl: searchUrl,
      mode: "chromium",
      maxDepth: 1,
      maxDocuments: 2,
    }, { capture, lookup: publicLookup(), now: () => FIXED_NOW });

    expect(requestedUrls).toEqual([searchUrl, "https://example.com/ebooks/25716"]);
    expect(result.pages[0].feedItems).toEqual([
      {
        title: "灵历集光 (Chinese)",
        summary: "Shangjie Song · 27039 downloads",
        image: {
          url: "https://example.com/cache/epub/25716/pg25716.cover.small.jpg",
          alt: "灵历集光 (Chinese)",
        },
        canonicalUrl: "https://example.com/ebooks/25716",
      },
      {
        title: "Three Hundred Tang Poems, Volume 1 (Chinese)",
        summary: "Various · 20925 downloads",
        image: {
          url: "https://example.com/cache/epub/20968/pg20968.cover.small.jpg",
          alt: "Three Hundred Tang Poems, Volume 1 (Chinese)",
        },
        canonicalUrl: "https://example.com/ebooks/20968",
      },
      {
        title: "警世通言 (Chinese)",
        summary: "Menglong Feng · 10535 downloads",
        image: {
          url: "https://example.com/cache/epub/24141/pg24141.cover.small.jpg",
          alt: "警世通言 (Chinese)",
        },
        canonicalUrl: "https://example.com/ebooks/24141",
      },
    ]);
    expect(result.pages[0].navigation).toEqual([{
      title: "Next",
      canonicalUrl: "https://example.com/ebooks/search/?query=l.zh&start_index=26",
    }]);
    expect(result.pages[0].childLinks).toEqual([{
      title: "灵历集光 (Chinese)",
      canonicalUrl: "https://example.com/ebooks/25716",
    }]);
  });

  it("keeps a Gutenberg book detail despite schema.org breadcrumb list items", async () => {
    const bookUrl = "https://gutenberg.org/ebooks/24230";
    const onlineUrl = "https://gutenberg.org/cache/epub/24230/pg24230-images.html";
    const capture = vi.fn(async () => ({
      requestedUrl: bookUrl,
      finalUrl: bookUrl,
      status: 200,
      title: "今古奇觀 by Baowenglaoren | Project Gutenberg",
      locale: "en",
      partial: false,
      warnings: [],
      timings: {
        browserAcquireMs: 1,
        navigateMs: 2,
        domSettleMs: 3,
        captureMs: 4,
        totalMs: 10,
      },
      html: `<!doctype html><html lang="en"><head>
        <title>今古奇觀 by Baowenglaoren | Project Gutenberg</title>
      </head><body>
        <ol class="breadcrumbs" itemscope itemtype="https://schema.org/BreadcrumbList">
          <li class="breadcrumb first" itemprop="itemListElement"
              itemscope itemtype="https://schema.org/ListItem">
            <a href="/" title="Go to the Main page." itemprop="item">
              <span itemprop="name">Project Gutenberg</span>
            </a>
            <meta itemprop="position" content="0">
          </li>
          <li class="breadcrumb next" itemprop="itemListElement"
              itemscope itemtype="https://schema.org/ListItem">
            <a href="/ebooks/" title="Start a new search." itemprop="item">
              <span itemprop="name">78,978 free eBooks</span>
            </a>
            <meta itemprop="position" content="1">
          </li>
        </ol>
        <div id="content">
          <h1>今古奇觀 by Baowenglaoren</h1>
          <a href="${onlineUrl}" title="Read now!">
            <img src="/cache/epub/24230/pg24230.cover.medium.jpg"
                 alt="" title="Book Cover" width="200" height="300">
          </a>
          <p>This rendered description contains enough meaningful book detail
             to remain a document after Chromium has executed the page.</p>
          <a href="${onlineUrl}" title="Read this book online now">Read online now</a>
          <h2>Download for free</h2>
          <a href="/ebooks/24230.epub3.images">EPUB3 ★ Recommended for most devices!</a>
          <a href="/ebooks/24230.txt.utf-8">Plain Text (accessible)</a>
          <a href="/ebooks/24230.epub.images">EPUB (older e-readers)</a>
          <a href="/ebooks/24230.kf8.images">Kindle</a>
          <a href="/cache/epub/24230/pg24230-h.zip">Download HTML (zip)</a>
        </div>
      </body></html>`,
    }));

    const result = await ingestSource({
      seedUrl: bookUrl,
      mode: "chromium",
      maxDepth: 0,
      maxDocuments: 1,
    }, {
      capture,
      lookup: publicLookup(),
      now: () => FIXED_NOW,
    });

    expect(result.pages[0].feedItems).toBeUndefined();
    expect(result.pages[0].links?.length).toBeGreaterThan(3);
    expect(result.pages[0].links?.[0]).toEqual({
      title: "Read online now",
      canonicalUrl: onlineUrl,
    });
    expect(JSON.stringify(result.pages[0].links)).not.toMatch(
      /Go to the Main page|Start a new search/u,
    );
  });

  it("keeps a full 48-item feed and a separate safe nine-item primary navigation", async () => {
    const menu = [
      ["首页", "/"],
      ["问答", "/qa"],
      ["树洞", "/treehole"],
      ["女装", "/beauty"],
      ["随手拍", "/ooxx"],
      ["无聊图", "/pic"],
      ["鱼塘", "/new/forum"],
      ["热榜", "/top"],
      ["大吐槽", "/tucao"],
    ].map(([title, href]) => `<li><a href="${href}">${title}</a></li>`).join("");
    const cards = Array.from({ length: 48 }, (_, index) => `
      <article class="story-card">
        <h2><a href="/p/${index + 1}/">第 ${index + 1} 条新鲜事</a></h2>
        <p class="story-excerpt">第 ${index + 1} 条摘要。</p>
        <img class="featured-photo" src="/images/${index + 1}.jpg" width="640" height="360" alt="第 ${index + 1} 张图" />
      </article>
    `).join("");
    const fetcher = vi.fn(async () => htmlResponse(`
      <!doctype html><html lang="zh-CN"><head><title>煎蛋</title></head><body>
        <nav id="nav"><ul class="main-nav">
          ${menu}
          <li><a href="/">首页</a></li>
          <li><a href="javascript:"><i class="menu-icon"></i></a></li>
          <li><a href="/new/member">用户中心</a></li>
          <li><a href="mailto:hello@example.com">联系我们</a></li>
          <li><a href="https://other.example/elsewhere">站外</a></li>
        </ul></nav>
        <nav aria-label="breadcrumb"><a href="/topic">专题面包屑</a></nav>
        <main><h1>新鲜事</h1><div class="article-feed">${cards}</div></main>
        <footer><nav><a href="/legal">法律条款</a><a href="/privacy">隐私</a></nav></footer>
      </body></html>
    `));

    const result = await ingestSource({
      seedUrl: "https://jandan.net/",
      maxDepth: 0,
      maxDocuments: 1,
    }, {
      fetch: fetcher,
      lookup: publicLookup(),
      now: () => FIXED_NOW,
    });

    expect(result.pages[0].feedItems).toHaveLength(48);
    expect(result.pages[0].navigation).toEqual([
      { title: "首页", canonicalUrl: "https://jandan.net/" },
      { title: "问答", canonicalUrl: "https://jandan.net/qa" },
      { title: "树洞", canonicalUrl: "https://jandan.net/treehole" },
      { title: "女装", canonicalUrl: "https://jandan.net/beauty" },
      { title: "随手拍", canonicalUrl: "https://jandan.net/ooxx" },
      { title: "无聊图", canonicalUrl: "https://jandan.net/pic" },
      { title: "鱼塘", canonicalUrl: "https://jandan.net/new/forum" },
      { title: "热榜", canonicalUrl: "https://jandan.net/top" },
      { title: "大吐槽", canonicalUrl: "https://jandan.net/tucao" },
    ]);
    expect(JSON.stringify(result.pages[0].navigation)).not.toMatch(
      /(?:breadcrumb|member|mailto|legal|privacy|other\.example|javascript)/iu,
    );
  });

  it("keeps an ordinary article as semantic detail content", async () => {
    const fetcher = vi.fn(async () => htmlResponse(`
      <!doctype html><html><head><title>Long read</title></head><body>
        <main><article><h1>Long read</h1><p>This is one article, not a feed.</p></article></main>
      </body></html>
    `));
    const result = await ingestSource({
      seedUrl: "https://example.com/long-read",
      maxDepth: 0,
      maxDocuments: 1,
    }, {
      fetch: fetcher,
      lookup: publicLookup(),
      now: () => FIXED_NOW,
    });

    expect(result.pages[0].feedItems).toBeUndefined();
    expect(result.pages[0].blocks).toContainEqual({
      type: "paragraph",
      text: "This is one article, not a feed.",
    });
  });

  it("converts a post-JavaScript Chromium DOM through Markdown before semantic extraction", async () => {
    const capture = vi.fn(async () => ({
      requestedUrl: "https://example.com/app",
      finalUrl: "https://example.com/app",
      status: 200,
      title: "Rendered application",
      locale: "zh-CN",
      partial: false,
      warnings: [],
      timings: {
        browserAcquireMs: 12,
        navigateMs: 210,
        domSettleMs: 320,
        captureMs: 18,
        totalMs: 560,
      },
      html: `<!doctype html><html lang="zh-CN"><head>
        <title>Rendered application</title><link rel="canonical" href="/app" />
      </head><body>
        <nav id="nav" class="main-nav"><a href="/latest">最新</a><a href="/archive">归档</a></nav>
        <main><h1>JS 渲染后的文章</h1>
          <p>这段正文只会在客户端脚本执行后出现，并且包含足够长的真实内容供墨水屏阅读。</p>
          <p><a href="/article/42">继续阅读完整文章</a></p>
          <img data-current-src="https://cdn.example.com/final.jpg" src="/placeholder.gif" alt="最终图片" />
        </main>
      </body></html>`,
    }));

    const result = await ingestSource({
      seedUrl: "https://example.com/app",
      mode: "chromium",
      maxDepth: 0,
      maxDocuments: 1,
    }, {
      capture,
      lookup: publicLookup(),
      now: () => FIXED_NOW,
    });

    expect(capture).toHaveBeenCalledTimes(1);
    expect(result.pages[0].blocks).toContainEqual({
      type: "paragraph",
      text: "这段正文只会在客户端脚本执行后出现，并且包含足够长的真实内容供墨水屏阅读。",
    });
    expect(result.pages[0].blocks).toContainEqual({
      type: "image",
      image: { url: "https://cdn.example.com/final.jpg", alt: "最终图片" },
    });
    expect(result.pages[0].navigation).toEqual([
      { title: "最新", canonicalUrl: "https://example.com/latest" },
      { title: "归档", canonicalUrl: "https://example.com/archive" },
    ]);
    expect(result.pages[0].links).toContainEqual({
      title: "继续阅读完整文章",
      canonicalUrl: "https://example.com/article/42",
    });
    expect(result.pages[0].revision?.id).toMatch(/^dom-sha256:[a-f0-9]{64}$/u);
    expect(result.timings).toMatchObject({
      chromium_total_ms: 560,
      navigate_ms: 210,
    });
  });

  it("excludes breadcrumb blocks from article content without suppressing their discovered links", async () => {
    const requestedPaths: string[] = [];
    const fetcher = vi.fn(async (input: string | URL) => {
      const url = actionUrl(input);
      requestedPaths.push(url.pathname);
      if (url.pathname === "/topic") {
        return htmlResponse(`
          <!doctype html><html><head><title>Topic</title></head><body>
            <main><h1>Topic</h1><p>Topic page.</p></main>
          </body></html>
        `);
      }
      return htmlResponse(`
        <!doctype html><html><head><title>Article</title></head><body><main>
          <nav aria-label="breadcrumb"><ol><li>Home</li><li><a href="/topic">Topic</a></li></ol></nav>
          <ol class="breadcrumb"><li>Home</li><li>Topic</li><li>Article body</li></ol>
          <h1>Article title</h1><p>Useful article text.</p>
        </main></body></html>
      `);
    });

    const result = await ingestSource({
      seedUrl: "https://example.com/article",
      maxDepth: 1,
      maxDocuments: 2,
    }, {
      fetch: fetcher,
      lookup: publicLookup(),
      now: () => FIXED_NOW,
    });

    expect(requestedPaths).toEqual(["/article", "/topic"]);
    expect(result.pages[0].blocks).toEqual([
      { type: "heading", level: 1, text: "Article title" },
      { type: "paragraph", text: "Useful article text." },
    ]);
    expect(result.pages[0].childLinks).toEqual([{ title: "Topic", canonicalUrl: "https://example.com/topic" }]);
  });

  it("reports EXTRACTION_EMPTY when a page has no semantic content", async () => {
    const fetcher = vi.fn(async () => htmlResponse(`
      <!doctype html><html><head><title>Empty</title></head><body>
        <main><script>document.write('not content')</script><div aria-hidden="true"></div></main>
      </body></html>
    `));

    let thrown: unknown;
    try {
      await ingestSource({ seedUrl: "https://example.com/empty", maxDepth: 0 }, {
        fetch: fetcher,
        lookup: publicLookup(),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SourceIngestionError);
    expect(thrown).toMatchObject({ code: "EXTRACTION_EMPTY", retryable: false });
  });
});
