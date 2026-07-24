import { describe, expect, it } from "vitest";

import {
  MARKDOWN_CONVERSION_LIMITS,
  renderedHtmlFragmentToMarkdown,
  renderedHtmlToMarkdown,
} from "./markdown";

describe("renderedHtmlToMarkdown", () => {
  it("keeps a complete inert feed fragment instead of selecting a nested CMS root", () => {
    const result = renderedHtmlFragmentToMarkdown(`
      <header><p>条目导语仍属于订阅正文。</p></header>
      <article>
        <h2>章节</h2>
        <p>正文中的<a href="../read">安全链接</a>。</p>
      </article>
      <p hidden>隐藏内容</p>
      <p style="display: none">样式隐藏内容</p>
      <script>不能执行</script>
      <img src="../photo.jpg" alt="正文照片">
    `, "https://example.com/feed/entry/");

    expect(result.stats.rootSelector).toBe("body");
    expect(result.blocks).toEqual([
      { type: "paragraph", text: "条目导语仍属于订阅正文。" },
      { type: "heading", level: 2, text: "章节" },
      { type: "paragraph", text: "正文中的安全链接。" },
      {
        type: "image",
        image: {
          url: "https://example.com/feed/photo.jpg",
          alt: "正文照片",
        },
      },
    ]);
    expect(result.links).toEqual([{
      label: "安全链接",
      url: "https://example.com/feed/read",
    }]);
    expect(result.markdown).not.toMatch(/隐藏内容|不能执行/u);
  });

  it("preserves Chinese structure and inline links while removing executable noise", () => {
    const result = renderedHtmlToMarkdown(`
      <html>
        <head><style>.hidden { display: none }</style></head>
        <body>
          <nav><a href="/menu">菜单噪声</a></nav>
          <main>
            <h1>今日阅读</h1>
            <p>这是 <strong>墨水屏</strong> 的<a href="../article/42?from=home#正文">详细介绍</a>。</p>
            <script>document.write("不能出现")</script>
            <noscript>脚本占位内容</noscript>
            <form><p>表单噪声</p></form>
          </main>
        </body>
      </html>
    `, "https://example.com/section/index.html");

    expect(result.stats.rootSelector).toBe("main");
    expect(result.markdown).toContain("# 今日阅读");
    expect(result.markdown).not.toContain("不能出现");
    expect(result.markdown).not.toContain("表单噪声");
    expect(result.blocks).toEqual([
      { type: "heading", level: 1, text: "今日阅读" },
      { type: "paragraph", text: "这是 墨水屏 的详细介绍。" },
    ]);
    expect(result.links).toEqual([{
      label: "详细介绍",
      url: "https://example.com/article/42?from=home#%E6%AD%A3%E6%96%87",
    }]);
  });

  it("keeps h1/h2 hard breaks inside their original heading blocks", () => {
    const result = renderedHtmlToMarkdown(`
      <main>
        <h1>Project<br>Gutenberg</h1>
        <h2>Books in<br><span>Chinese</span></h2>
        <p>正文仍然是独立段落。</p>
      </main>
    `, "https://www.gutenberg.org/");

    expect(result.markdown).toContain("# Project Gutenberg");
    expect(result.markdown).toContain("## Books in Chinese");
    expect(result.blocks).toEqual([
      { type: "heading", level: 1, text: "Project Gutenberg" },
      { type: "heading", level: 2, text: "Books in Chinese" },
      { type: "paragraph", text: "正文仍然是独立段落。" },
    ]);
  });

  it("keeps double breaks and real paragraph boundaries without splitting soft source lines", () => {
    const result = renderedHtmlToMarkdown(`
      <main>
        <p>同一个段落的源码软换行
        仍然属于同一个段落。</p>
        <p>第一部分<br><br>第二部分</p>
        <p>真正的下一段。</p>
      </main>
    `, "https://example.com/article");

    expect(result.blocks).toEqual([
      { type: "paragraph", text: "同一个段落的源码软换行 仍然属于同一个段落。" },
      { type: "paragraph", text: "第一部分" },
      { type: "paragraph", text: "第二部分" },
      { type: "paragraph", text: "真正的下一段。" },
    ]);
  });

  it("keeps a Gutenberg-style block card as one valid linked image and label", () => {
    const result = renderedHtmlToMarkdown(`
      <main>
        <a class="link" href="/ebooks/25716">
          <div class="cover">
            <img src="/cache/epub/25716/pg25716.cover.small.jpg" alt="灵历集光封面">
          </div>
          <div class="content">
            <div class="title">灵历集光 (Chinese)</div>
            <div class="subtitle">Shangjie Song</div>
          </div>
        </a>
      </main>
    `, "https://www.gutenberg.org/ebooks/search/?query=l.zh");

    expect(result.markdown).toBe(
      "[![灵历集光封面](https://www.gutenberg.org/cache/epub/25716/pg25716.cover.small.jpg) 灵历集光 (Chinese) Shangjie Song](https://www.gutenberg.org/ebooks/25716)",
    );
    expect(result.blocks).toEqual([
      {
        type: "image",
        image: {
          url: "https://www.gutenberg.org/cache/epub/25716/pg25716.cover.small.jpg",
          alt: "灵历集光封面",
        },
      },
      {
        type: "link",
        link: {
          label: "灵历集光封面 灵历集光 (Chinese) Shangjie Song",
          url: "https://www.gutenberg.org/ebooks/25716",
        },
      },
    ]);
    expect(result.links).toEqual([{
      label: "灵历集光封面 灵历集光 (Chinese) Shangjie Song",
      url: "https://www.gutenberg.org/ebooks/25716",
    }]);
    expect(result.blocks).not.toContainEqual({ type: "paragraph", text: "[" });
    expect(result.blocks.some(
      (block) => block.type === "paragraph" && block.text.startsWith("](https://"),
    )).toBe(false);
  });

  it("prefers a visible Gutenberg action over an earlier cover link to the same URL", () => {
    const result = renderedHtmlToMarkdown(`
      <main>
        <h1>今古奇觀 by Baowenglaoren</h1>
        <a href="/cache/epub/24230/pg24230-images.html" title="Read now!">
          <img src="/cache/epub/24230/pg24230.cover.medium.jpg" alt="" title="Book Cover">
        </a>
        <p>A sufficiently descriptive introduction to this public-domain book.</p>
        <a class="link-button"
           href="/cache/epub/24230/pg24230-images.html"
           title="Read this book online now">Read online now</a>
      </main>
    `, "https://gutenberg.org/ebooks/24230");

    expect(result.markdown).toContain(
      "[Read online now](https://gutenberg.org/cache/epub/24230/pg24230-images.html",
    );
    expect(result.links).toEqual([{
      label: "Read online now",
      url: "https://gutenberg.org/cache/epub/24230/pg24230-images.html",
    }]);
  });

  it("uses the rendered currentSrc surrogate and keeps a figure caption on its image", () => {
    const result = renderedHtmlToMarkdown(`
      <article>
        <figure>
          <img src="/placeholder.gif"
               data-current-src="../media/photo 01.jpg"
               data-src="/late.jpg"
               alt="雨后的城市">
          <figcaption>上海，雨后清晨</figcaption>
        </figure>
        <img data-original="//cdn.example.com/cover.png" alt="封面">
      </article>
    `, new URL("https://example.com/news/today.html"));

    expect(result.stats.rootSelector).toBe("article");
    expect(result.blocks).toEqual([
      {
        type: "image",
        image: {
          url: "https://example.com/media/photo%2001.jpg",
          alt: "雨后的城市",
          caption: "上海，雨后清晨",
        },
      },
      {
        type: "image",
        image: {
          url: "https://cdn.example.com/cover.png",
          alt: "封面",
        },
      },
    ]);
    expect(result.stats.imageCount).toBe(2);
  });

  it("keeps standalone actions, table relationships, code lines, and responsive picture images", () => {
    const result = renderedHtmlFragmentToMarkdown(`
      <p><a href="./download">下载完整报告</a></p>
      <table>
        <thead><tr><th>项目</th><th>状态</th></tr></thead>
        <tbody>
          <tr><td>解析器</td><td><a href="./parser">已通过</a></td></tr>
          <tr><td>设备</td><td>待验收</td></tr>
        </tbody>
      </table>
      <pre><code class="language-ts">const value = 1;
if (value) {
  render(value);
}</code></pre>
      <picture>
        <source srcset="./photo-2x.jpg 2x, ./photo.jpg 1x">
        <img src="./transparent.gif" alt="正文响应式照片">
      </picture>
    `, "https://example.com/feed/item/");

    expect(result.blocks).toEqual([
      {
        type: "link",
        link: {
          label: "下载完整报告",
          url: "https://example.com/feed/item/download",
        },
      },
      {
        type: "list",
        ordered: false,
        items: [
          "项目：解析器；状态：已通过",
          "项目：设备；状态：待验收",
        ],
      },
      {
        type: "paragraph",
        text: "const value = 1;\nif (value) {\n  render(value);\n}",
      },
      {
        type: "image",
        image: {
          url: "https://example.com/feed/item/photo-2x.jpg",
          alt: "正文响应式照片",
        },
      },
    ]);
    expect(result.links).toEqual([
      {
        label: "下载完整报告",
        url: "https://example.com/feed/item/download",
      },
      {
        label: "已通过",
        url: "https://example.com/feed/item/parser",
      },
    ]);
  });

  it("prefers a substantive article-body container over author and recommendation chrome", () => {
    const result = renderedHtmlToMarkdown(`
      <article class="normal-article">
        <header>
          <p>2026年07月20日 · 9 分钟阅读</p>
          <h1>一个零门槛联机游戏平台</h1>
          <p>主作者</p>
          <img src="/avatar.jpg" alt="作者头像">
          <p>作者资料与关注按钮</p>
        </header>
        <div class="article-body">
          <p>利益相关声明：作者与文中产品有直接利益关系。</p>
          <div class="article__main__content">
            <p>Matrix 首页推荐</p>
            <p>文章代表作者个人观点，站点仅对标题和排版略作修改。</p>
            <hr>
            <p>这是应该出现在实时渲染首帧的正文第一段，长度足以成为明确的文章主体。</p>
            <p>这是正文第二段，继续解释产品如何在不部署中心服务器的情况下完成联机，并说明连接建立、房间发现和断线恢复的完整过程。</p>
            <p>这是正文第三段，补充浏览器兼容性、局域网发现与安全边界，让测试中的正文规模足以代表一篇真实的编辑文章，并覆盖失败重试、缓存更新和离线恢复等后续阅读场景。</p>
          </div>
        </div>
        <aside class="recommendations">
          <h2>相关推荐</h2>
          <p>另一篇与当前正文无关的推荐文章。</p>
        </aside>
      </article>
    `, "https://example.com/post/42");

    expect(result.stats.rootSelector).toBe(".article__main__content");
    expect(result.blocks).toEqual([
      { type: "paragraph", text: "这是应该出现在实时渲染首帧的正文第一段，长度足以成为明确的文章主体。" },
      { type: "paragraph", text: "这是正文第二段，继续解释产品如何在不部署中心服务器的情况下完成联机，并说明连接建立、房间发现和断线恢复的完整过程。" },
      { type: "paragraph", text: "这是正文第三段，补充浏览器兼容性、局域网发现与安全边界，让测试中的正文规模足以代表一篇真实的编辑文章，并覆盖失败重试、缓存更新和离线恢复等后续阅读场景。" },
    ]);
    expect(result.markdown).not.toContain("主作者");
    expect(result.markdown).not.toContain("利益相关声明");
    expect(result.markdown).not.toContain("Matrix 首页推荐");
    expect(result.markdown).not.toContain("文章代表作者个人观点");
    expect(result.markdown).not.toContain("相关推荐");
    expect(result.markdown).not.toContain("avatar.jpg");
  });

  it("drops small rendered decorations while retaining editorial images", () => {
    const result = renderedHtmlToMarkdown(`
      <main>
        <img class="site-logo" src="/logo.png"
             data-ink-rendered-width="48" data-ink-rendered-height="48" alt="站点标志">
        <img src="/tracking.gif"
             data-ink-rendered-width="1" data-ink-rendered-height="1" alt="">
        <img class="next-arrow" src="/next.png"
             data-ink-rendered-width="20" data-ink-rendered-height="80" alt="下一页">
        <figure>
          <img src="/article.jpg"
               data-ink-rendered-width="720" data-ink-rendered-height="480" alt="火星地表">
          <figcaption>探测器拍摄的正文图片</figcaption>
        </figure>
        <img class="tiny-icon" src="/qr.png"
             data-ink-rendered-width="48" data-ink-rendered-height="48" alt="扫码打开原文二维码">
        <img src="/meaningful-thumb.jpg"
             data-ink-rendered-width="64" data-ink-rendered-height="64" alt="正文中的芯片缩略图">
        <img src="/placeholder.gif" data-current-src="/placeholder.gif"
             data-src="/lazy-photo.jpg" width="1200" height="800"
             data-ink-rendered-width="0" data-ink-rendered-height="0"
             data-ink-rendered-hidden="false" alt="尚未滚入视口的正文照片">
        <img src="/hidden-photo.jpg" width="1200" height="800"
             data-ink-rendered-width="0" data-ink-rendered-height="0"
             data-ink-rendered-hidden="true" alt="隐藏轮播图片">
      </main>
    `, "https://example.com/story");

    expect(result.blocks).toEqual([
      {
        type: "image",
        image: {
          url: "https://example.com/article.jpg",
          alt: "火星地表",
          caption: "探测器拍摄的正文图片",
        },
      },
      {
        type: "image",
        image: { url: "https://example.com/qr.png", alt: "扫码打开原文二维码" },
      },
      {
        type: "image",
        image: { url: "https://example.com/meaningful-thumb.jpg", alt: "正文中的芯片缩略图" },
      },
      {
        type: "image",
        image: { url: "https://example.com/lazy-photo.jpg", alt: "尚未滚入视口的正文照片" },
      },
    ]);
    expect(result.stats.imageCount).toBe(4);
    expect(result.markdown).not.toContain("logo.png");
    expect(result.markdown).not.toContain("tracking.gif");
    expect(result.markdown).not.toContain("next.png");
    expect(result.markdown).not.toContain("hidden-photo.jpg");
    expect(result.markdown).not.toContain("placeholder.gif");
  });

  it("folds nested lists into their parent block without duplicating list blocks", () => {
    const result = renderedHtmlToMarkdown(`
      <main>
        <ul>
          <li>第一项<ul><li>嵌套说明不应成为第二个列表块</li></ul></li>
          <li>第二项</li>
        </ul>
        <blockquote>
          <p>设计不是装饰，而是信息的组织方式。</p>
          <footer>InkOS 团队</footer>
        </blockquote>
      </main>
    `, "https://inkos.example/docs/");

    expect(result.blocks).toEqual([
      {
        type: "list",
        ordered: false,
        items: ["第一项 嵌套说明不应成为第二个列表块", "第二项"],
      },
      {
        type: "quote",
        text: "设计不是装饰，而是信息的组织方式。",
        attribution: "InkOS 团队",
      },
    ]);
    expect(result.blocks.filter((block) => block.type === "list")).toHaveLength(1);
  });

  it("retains nested list values inside a blockquote", () => {
    const result = renderedHtmlToMarkdown(`
      <main>
        <blockquote>
          <p>下面是两者的单精度32位浮点数算力（FP32）。</p>
          <ul>
            <li>RTX 5090：104.8</li>
            <li>AMD Strix Halo：14.8</li>
          </ul>
        </blockquote>
      </main>
    `, "https://example.com/article");

    expect(result.blocks).toEqual([{
      type: "quote",
      text: "下面是两者的单精度32位浮点数算力（FP32）。 RTX 5090：104.8；AMD Strix Halo：14.8",
    }]);
  });

  it("prefers MediaWiki content and rejects non-http links and image URLs", () => {
    const result = renderedHtmlToMarkdown(`
      <body>
        <main><p>不应选择 main</p></main>
        <div class="mw-parser-output">
          <h2>百科正文</h2>
          <p><a href="/wiki/InkOS">InkOS</a> 与 <a href="javascript:alert(1)">危险链接</a></p>
          <img src="data:image/png;base64,AAAA" alt="内联图片">
          <canvas>绘图噪声</canvas>
        </div>
      </body>
    `, "https://zh.example.org/wiki/Home");

    expect(result.stats.rootSelector).toBe(".mw-parser-output");
    expect(result.blocks).toEqual([
      { type: "heading", level: 2, text: "百科正文" },
      { type: "paragraph", text: "InkOS 与 危险链接" },
    ]);
    expect(result.links).toEqual([{
      label: "InkOS",
      url: "https://zh.example.org/wiki/InkOS",
    }]);
    expect(result.markdown).not.toContain("内联图片");
    expect(result.markdown).not.toContain("绘图噪声");
  });

  it("enforces block, image, and total-text budgets deterministically", () => {
    const images = Array.from({ length: 30 }, (_, index) =>
      `<img src="/images/${index}.png" alt="图片 ${index}">`,
    ).join("");
    const paragraphs = Array.from({ length: 300 }, (_, index) =>
      `<p>${index}-${"字".repeat(1_000)}</p>`,
    ).join("");
    const result = renderedHtmlToMarkdown(
      `<main>${images}${paragraphs}</main>`,
      "https://example.com/base/",
    );

    expect(result.stats.blockCount).toBeLessThanOrEqual(MARKDOWN_CONVERSION_LIMITS.maxBlocks);
    expect(result.stats.imageCount).toBe(MARKDOWN_CONVERSION_LIMITS.maxImages);
    expect(result.stats.textCharacters).toBeLessThanOrEqual(MARKDOWN_CONVERSION_LIMITS.maxTextCharacters);
    expect(result.stats.truncated).toBe(true);
    expect(result.blocks.filter((block) => block.type === "image")).toHaveLength(24);
  });
});
