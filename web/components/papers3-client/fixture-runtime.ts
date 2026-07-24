import {
  PAPER_S3_FRAME_SIZE,
  type InkClientRuntimeAdapter,
  type InkDisplayPreferences,
  type InkDocumentDescriptor,
  type InkLinkHitbox,
  type InkOpenRequest,
  type InkRuntimeView,
  type InkSourceDescriptor,
  type InkSourceMode,
} from "./runtime-adapter";

interface FixturePage {
  readonly folio: string;
  readonly heading: string;
  readonly deck?: string;
  readonly paragraphs: readonly string[];
  readonly pullQuote?: string;
  readonly links?: readonly InkLinkHitbox[];
}

interface FixtureDocument extends InkDocumentDescriptor {
  readonly pages: readonly FixturePage[];
}

const ROOT_UUID = "ink-demo:nook:index";

const documents: Readonly<Record<string, FixtureDocument>> = {
  [ROOT_UUID]: {
    uuid: ROOT_UUID,
    kind: "list",
    title: "Nook · 电子墨水屏系列",
    revision: 3,
    pages: [
      {
        folio: "离线样刊 · 目录",
        heading: "Nook\n电子墨水屏系列",
        deck: "从第一代 Nook 到 GlowLight，阅读一条电子阅读器产品线的演进。",
        paragraphs: [
          "2009 · 第一代 Nook",
          "双屏设计与早期数字书店体验",
          "2011 · Nook Simple Touch",
          "触控电子墨水屏成为主角",
          "2012—2023 · GlowLight 系列",
          "前光、尺寸与长时间阅读体验",
        ],
        links: [
          {
            id: "open-first-nook",
            label: "打开：第一代 Nook",
            targetUuid: "ink-demo:nook:first-generation",
            bounds: { x: 42, y: 390, width: 456, height: 118 },
          },
          {
            id: "open-simple-touch",
            label: "打开：Nook Simple Touch",
            targetUuid: "ink-demo:nook:simple-touch",
            bounds: { x: 42, y: 526, width: 456, height: 118 },
          },
          {
            id: "open-glowlight",
            label: "打开：Nook GlowLight 系列",
            targetUuid: "ink-demo:nook:glowlight",
            bounds: { x: 42, y: 662, width: 456, height: 118 },
          },
        ],
      },
    ],
  },
  "ink-demo:nook:first-generation": {
    uuid: "ink-demo:nook:first-generation",
    parentUuid: ROOT_UUID,
    kind: "detail",
    title: "第一代 Nook",
    revision: 2,
    pages: [
      {
        folio: "Nook 档案 · 01",
        heading: "第一代\nNook",
        deck: "一台在电子墨水屏之外，又保留彩色触控导航区的早期电子阅读器。",
        paragraphs: [
          "Barnes & Noble 在 2009 年推出 Nook。它把主要阅读内容放在电子墨水屏上，另以较小的彩色触控屏承担封面浏览和导航。",
          "这种双屏方案带来了鲜明辨识度，也展示了早期电子阅读器在触控交互尚未成熟时的一种过渡思路。",
        ],
      },
      {
        folio: "Nook 档案 · 02",
        heading: "双屏之间",
        deck: "阅读保持克制，操作则被安排在另一块屏幕。",
        paragraphs: [
          "电子墨水区域适合持续阅读：静态画面无需不断刷新，阳光下依旧清晰。彩色区域则负责书店、键盘和封面列表。",
          "两块屏幕也意味着更复杂的功耗与界面分工。后来产品逐步将触控能力直接整合到电子墨水屏，交互结构随之简化。",
        ],
        pullQuote: "设备的限制，往往也会塑造内容的层级。",
      },
      {
        folio: "Nook 档案 · 03",
        heading: "走向纯粹",
        deck: "下一代产品把注意力重新交还给文字。",
        paragraphs: [
          "随着红外触控等方案成熟，Nook Simple Touch 取消了彩色副屏，以更轻、更直接的方式组织阅读。",
          "点击下方关联区域，可以继续查看这次产品转向。这个区域的位置来自渲染清单，而不是客户端重新排版。",
        ],
        links: [
          {
            id: "continue-simple-touch",
            label: "继续阅读：Nook Simple Touch",
            targetUuid: "ink-demo:nook:simple-touch",
            bounds: { x: 42, y: 704, width: 456, height: 112 },
          },
        ],
      },
    ],
  },
  "ink-demo:nook:simple-touch": {
    uuid: "ink-demo:nook:simple-touch",
    parentUuid: ROOT_UUID,
    kind: "detail",
    title: "Nook Simple Touch",
    revision: 1,
    pages: [
      {
        folio: "Nook 档案 · 04",
        heading: "Simple\nTouch",
        deck: "触控进入电子墨水屏，产品形态变得更安静。",
        paragraphs: [
          "2011 年的 Nook Simple Touch 采用触控电子墨水屏。页面、目录和选择操作都回到同一块显示区域，彩色副屏退出了产品。",
          "更少的视觉分区、更直接的手势，以及围绕长时间阅读建立的界面，成为后续产品的重要基础。",
        ],
      },
      {
        folio: "Nook 档案 · 05",
        heading: "一次减法",
        deck: "减少组件，也减少读者在界面之间切换的成本。",
        paragraphs: [
          "对阅读设备而言，快速刷新并不是唯一指标。字体、留白、翻页节奏和可预测的返回路径，都会影响连续阅读。",
          "InkOS 客户端沿用这种思路：渲染由服务端或离线包完成，设备只执行有限且一致的导航动作。",
        ],
      },
    ],
  },
  "ink-demo:nook:glowlight": {
    uuid: "ink-demo:nook:glowlight",
    parentUuid: ROOT_UUID,
    kind: "detail",
    title: "Nook GlowLight",
    revision: 4,
    pages: [
      {
        folio: "Nook 档案 · 06",
        heading: "GlowLight",
        deck: "前光让电子墨水阅读延伸到更暗的环境。",
        paragraphs: [
          "GlowLight 系列围绕照明、屏幕尺寸、存储和握持体验持续迭代。它不改变电子墨水的核心优势，而是扩大可舒适阅读的环境范围。",
          "在这一类设备上，离线内容包同样重要：网络不可用时，图片帧与跳转清单仍然可以由轻量客户端直接执行。",
        ],
        pullQuote: "内容可离线，交互规则仍保持一致。",
      },
    ],
  },
};

function sourceDescriptor(mode: InkOpenRequest["sourceMode"]): InkSourceDescriptor {
  if (mode === "offline") {
    return {
      mode,
      label: "离线包",
      detail: "nook-demo.ink · 清单已校验",
      packageFilename: "nook-demo.ink",
      verified: true,
    };
  }

  return {
    mode,
    label: "在线实时",
    detail: "InkOS Render API · revision latest",
    verified: true,
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function multilineText(
  lines: readonly string[],
  x: number,
  y: number,
  lineHeight: number,
  className: string,
): string {
  return `<text x="${x}" y="${y}" class="${className}">${lines
    .map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`)
    .join("")}</text>`;
}

function renderFixtureSvg(
  document: FixtureDocument,
  page: FixturePage,
  pageIndex: number,
  display: InkDisplayPreferences,
): string {
  const paper = "#f5f2e9";
  const ink = "#171717";
  const muted = "#585858";
  const rule = "#aaaaa2";
  const bodySize = 24 + display.fontLevel * 2;
  const bodyLineHeight = bodySize * 1.62;
  const headingSize = 58 + display.fontLevel * 3;
  const headingLines = page.heading.split("\n");
  const isIndex = document.kind === "list";

  const paragraphMarkup = isIndex
    ? page.paragraphs
        .reduce<string[]>((markup, line, index) => {
          if (index % 2 === 0) {
            const top = 421 + Math.floor(index / 2) * 136;
            markup.push(`<text x="68" y="${top}" class="cardTitle">${escapeXml(line)}</text>`);
          } else {
            const top = 461 + Math.floor(index / 2) * 136;
            markup.push(`<text x="68" y="${top}" class="cardBody">${escapeXml(line)}</text>`);
          }
          return markup;
        }, [])
        .join("")
    : page.paragraphs
        .map((paragraph, index) => {
          const lines = paragraph.length > 52
            ? [paragraph.slice(0, 26), paragraph.slice(26, 52), paragraph.slice(52)]
            : paragraph.length > 26
              ? [paragraph.slice(0, 26), paragraph.slice(26)]
              : [paragraph];
          return multilineText(lines.filter(Boolean), 52, 474 + index * 175, bodyLineHeight, "body");
        })
        .join("");

  const cards = isIndex
    ? [390, 526, 662]
        .map((top, index) => `<rect x="42" y="${top}" width="456" height="118" rx="2" class="card"/>
          <text x="462" y="${top + 64}" class="cardNumber">0${index + 1}</text>`)
        .join("")
    : "";

  const pullQuote = page.pullQuote
    ? `<line x1="52" y1="802" x2="488" y2="802" class="rule"/>
       <text x="52" y="844" class="quote">${escapeXml(page.pullQuote)}</text>`
    : "";

  const relatedLink = page.links && document.kind !== "list"
    ? `<rect x="42" y="704" width="456" height="112" rx="2" class="related"/>
       <text x="68" y="748" class="relatedLabel">关联阅读</text>
       <text x="68" y="784" class="relatedTitle">Nook Simple Touch</text>
       <path d="M446 754h20m-8-8 8 8-8 8" class="arrow"/>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="540" height="960" viewBox="0 0 540 960" role="img" aria-label="${escapeXml(document.title)}">
    <style>
      .folio,.pageNo,.deck,.cardBody,.cardNumber,.relatedLabel{font-family:Arial,'Noto Sans CJK SC',sans-serif}
      .heading,.body,.quote,.cardTitle,.relatedTitle{font-family:Georgia,'Noto Serif CJK SC','Songti SC',serif}
      .folio{font-size:14px;font-weight:700;letter-spacing:2px;fill:${muted}}
      .pageNo{font-size:13px;font-weight:700;fill:${muted}}
      .heading{font-size:${headingSize}px;font-weight:700;letter-spacing:-1.5px;fill:${ink}}
      .deck{font-size:20px;font-weight:400;fill:${muted}}
      .body{font-size:${bodySize}px;font-weight:400;fill:${ink}}
      .quote{font-size:20px;font-style:italic;fill:${ink}}
      .rule{stroke:${rule};stroke-width:1}
      .card{fill:none;stroke:${ink};stroke-width:1.5}
      .cardTitle{font-size:${22 + display.fontLevel}px;font-weight:700;fill:${ink}}
      .cardBody{font-size:16px;fill:${muted}}
      .cardNumber{font-size:13px;font-weight:700;fill:${muted};text-anchor:end}
      .related{fill:none;stroke:${ink};stroke-width:1.5}
      .relatedLabel{font-size:13px;font-weight:700;letter-spacing:2px;fill:${muted}}
      .relatedTitle{font-size:24px;font-weight:700;fill:${ink}}
      .arrow{fill:none;stroke:${ink};stroke-width:2}
    </style>
    <rect width="540" height="960" fill="${paper}"/>
    <text x="42" y="54" class="folio">${escapeXml(page.folio.toUpperCase())}</text>
    <text x="498" y="54" class="pageNo" text-anchor="end">${String(pageIndex + 1).padStart(2, "0")} / ${String(document.pages.length).padStart(2, "0")}</text>
    <line x1="42" y1="76" x2="498" y2="76" class="rule"/>
    ${multilineText(headingLines, 42, 154, headingSize * 0.98, "heading")}
    ${page.deck ? multilineText([page.deck.slice(0, 34), page.deck.slice(34)].filter(Boolean), 44, isIndex ? 326 : 350, 31, "deck") : ""}
    ${cards}
    ${paragraphMarkup}
    ${pullQuote}
    ${relatedLink}
    <line x1="42" y1="904" x2="498" y2="904" class="rule"/>
    <text x="42" y="934" class="pageNo">INKOS / PAPERS3</text>
    <text x="498" y="934" class="pageNo" text-anchor="end">${escapeXml(document.uuid)}</text>
  </svg>`;
}

function toDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export class FixtureInkRuntimeAdapter implements InkClientRuntimeAdapter {
  readonly adapterId = "papers3-local-fixture/v1";

  getRootUuid(sourceMode: InkSourceMode): string {
    // The fixture mirrors one root in both stores; real adapters may expose
    // different roots for a live account and an opened offline archive.
    void sourceMode;
    return ROOT_UUID;
  }

  async open(request: InkOpenRequest): Promise<InkRuntimeView> {
    const document = documents[request.uuid];
    if (!document) {
      throw new Error(`内容 ${request.uuid} 不存在或尚未下载。`);
    }

    const pageIndex = Math.max(0, Math.min(request.pageIndex, document.pages.length - 1));
    const fixturePage = document.pages[pageIndex];
    const imageUrl = toDataUrl(renderFixtureSvg(document, fixturePage, pageIndex, request.display));

    return {
      document: {
        uuid: document.uuid,
        parentUuid: document.parentUuid,
        kind: document.kind,
        title: document.title,
        revision: document.revision,
      },
      page: {
        index: pageIndex,
        count: document.pages.length,
        pixelSize: PAPER_S3_FRAME_SIZE,
        imageUrl,
        imageAlt: `${document.title}，第 ${pageIndex + 1} 页，共 ${document.pages.length} 页`,
        linkHitboxes: fixturePage.links ?? [],
      },
      source: sourceDescriptor(request.sourceMode),
    };
  }
}

export const fixtureInkRuntime = new FixtureInkRuntimeAdapter();
