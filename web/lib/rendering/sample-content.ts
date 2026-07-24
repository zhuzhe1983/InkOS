/**
 * Device-independent content examples.
 *
 * These documents intentionally describe only information and navigation. The
 * renderer owns every presentation decision, including layout, typography,
 * pagination, colour reduction and pixel encoding for the selected screen.
 */
export const DETAIL_SAMPLE_CONTENT = {
  schemaVersion: "inkos.content/v2",
  id: "field-notes-epaper",
  revision: 3,
  locale: "zh-CN",
  updatedAt: "2026-07-14T09:30:00+08:00",
  page: {
    kind: "detail",
    eyebrow: "产品手记",
    title: "为不同尺寸的墨水屏组织同一份内容",
    summary:
      "内容只表达文章、列表、图片和链接的含义；屏幕分辨率、灰度能力与刷新方式由服务端渲染器负责。",
    byline: "InkOS 团队",
    publishedAt: "2026-07-14",
    heroImage: {
      source: { kind: "asset", assetId: "articles/semantic-rendering/cover" },
      alt: "两块不同尺寸的墨水屏展示同一篇文章",
      caption: "相同语义内容可以针对不同屏幕重新排版。",
    },
    content: [
      {
        type: "paragraph",
        text: "服务端收到内容后，会读取目标设备的屏幕档案，再决定每行文字的长度、标题层级、图片占比和分页位置。设备只接收已经适配好的帧，不需要理解页面结构。",
      },
      {
        type: "heading",
        level: 2,
        text: "内容层应该保留什么",
      },
      {
        type: "paragraph",
        text: "内容层保留标题、摘要、正文、图片语义、列表项目与跳转目标。这些信息可以在 PaperS3、Xiaozhi Card Kit 或未来的设备之间复用。",
      },
      {
        type: "list",
        ordered: false,
        items: [
          "detail 页面包含标题、摘要和正文块",
          "list 页面包含可选图片、摘要、元信息和链接",
          "图片使用受控资源标识，远程地址需要经过资源解析器",
          "链接描述导航意图，最终交互区域由渲染结果提供",
        ],
      },
      {
        type: "quote",
        text: "同一份内容不是被整体缩小，而是在每块屏幕上重新编排。",
        attribution: "渲染原则",
      },
      {
        type: "heading",
        level: 3,
        text: "小屏幕如何处理",
      },
      {
        type: "paragraph",
        text: "在较小的黑白屏幕上，渲染器会使用更紧凑的阅读密度，把长内容拆成多页，并将灰度图形转换为清晰的黑白层次。在较大的十六级灰度屏幕上，则可以保留更丰富的层级与留白。",
      },
      {
        type: "image",
        image: {
          source: { kind: "asset", assetId: "articles/semantic-rendering/reflow-example" },
          alt: "文章内容在大屏与小屏上的分页对比",
          caption: "资源由服务端解析；内容文档不携带像素位置。",
        },
      },
      {
        type: "link",
        link: {
          label: "查看设备支持说明",
          target: { kind: "url", url: "https://docs.m5stack.com/" },
          description: "了解目标设备的显示能力。",
        },
      },
      {
        type: "paragraph",
        text: "当屏幕档案或渲染策略升级时，内容数据不需要迁移。服务端可以重新生成帧，并通过清单中的页码、校验值和像素格式交给设备端可靠消费。",
      },
    ],
    links: [
      {
        label: "返回渲染示例列表",
        target: { kind: "document", documentId: "rendering-examples" },
      },
    ],
  },
} as const;

export const LIST_SAMPLE_CONTENT = {
  schemaVersion: "inkos.content/v2",
  id: "rendering-examples",
  revision: 2,
  locale: "zh-CN",
  updatedAt: "2026-07-14T09:30:00+08:00",
  page: {
    kind: "list",
    title: "今日阅读",
    description: "同一组条目会根据目标屏幕自动调整密度、图片表现和分页。",
    items: [
      {
        id: "semantic-rendering",
        eyebrow: "架构",
        title: "语义内容与设备渲染彻底分离",
        summary: "内容描述要展示什么，屏幕档案与渲染策略决定怎样展示。",
        image: {
          source: { kind: "asset", assetId: "reading/semantic-rendering" },
          alt: "语义内容进入多种屏幕渲染器",
        },
        link: {
          label: "阅读详情",
          target: { kind: "document", documentId: "field-notes-epaper" },
        },
        metadata: [
          { label: "栏目", value: "产品手记" },
          { label: "时长", value: "6 分钟" },
        ],
      },
      {
        id: "paper-s3-profile",
        eyebrow: "设备",
        title: "PaperS3 的十六级灰度如何保留阅读层次",
        summary: "较大的画布适合更宽松的正文、图片与引用组合。",
        link: {
          label: "打开文章",
          target: { kind: "document", documentId: "paper-s3-profile" },
        },
      },
      {
        id: "xiaozhi-profile",
        eyebrow: "设备",
        title: "Xiaozhi Card Kit 的黑白小屏排版策略",
        summary: "紧凑的行距、短摘要和稳定分页让小屏内容保持清晰。",
        image: {
          source: { kind: "asset", assetId: "reading/xiaozhi-profile" },
          alt: "黑白卡片屏幕上的文章列表",
        },
        link: {
          label: "打开文章",
          target: { kind: "document", documentId: "xiaozhi-profile" },
        },
      },
      {
        id: "pagination",
        eyebrow: "协议",
        title: "服务端分页与 pageIndex",
        summary: "设备按页请求或接收帧，清单说明当前页以及前后页状态。",
        metadata: [{ label: "状态", value: "已验证" }],
      },
      {
        id: "image-assets",
        eyebrow: "安全",
        title: "图片资源通过受控解析器进入渲染流水线",
        summary: "内容可以引用资源标识，但渲染器不会任意抓取未知远程地址。",
      },
      {
        id: "frame-integrity",
        eyebrow: "传输",
        title: "帧清单提供尺寸、像素格式与完整性校验",
        summary: "设备无需重新布局，只需校验并显示服务端生成的图像。",
      },
      {
        id: "partial-refresh",
        eyebrow: "刷新",
        title: "局部刷新区域遵循设备的像素对齐约束",
        summary: "不符合边界或对齐规则的请求会在渲染前被拒绝。",
      },
      {
        id: "future-device",
        eyebrow: "扩展",
        title: "增加新设备时复用已有内容文档",
        summary: "新增屏幕档案与对应策略即可，不需要在内容中增加设备分支。",
        link: {
          label: "查看方案",
          target: { kind: "url", url: "https://example.com/inkos/device-profiles" },
        },
      },
    ],
    sourcePageInfo: {
      totalItems: 8,
      nextCursor: "reading-page-2",
    },
  },
} as const;

/**
 * An image-heavy collection. `layout: "masonry"` is only a high-level content
 * intent; it does not choose a template or expose columns, sizes or coordinates.
 * The device adapter still owns all geometry after resolving the images.
 */
export const GALLERY_SAMPLE_CONTENT = {
  schemaVersion: "inkos.content/v2",
  id: "weekend-photo-stream",
  revision: 1,
  locale: "zh-CN",
  updatedAt: "2026-07-14T14:20:00+08:00",
  page: {
    kind: "list",
    layout: "masonry",
    title: "周末影像",
    description: "一组关于海岸、山林和城市光影的旅行照片。",
    items: [
      {
        id: "sea-cliff",
        title: "海风经过悬崖",
        image: {
          source: { kind: "remote", url: "https://picsum.photos/id/1015/800/1100" },
          alt: "晨光中的海岸悬崖与白色浪花",
        },
        link: {
          label: "查看照片",
          target: { kind: "document", documentId: "photo-sea-cliff" },
        },
        metadata: [{ label: "地点", value: "东海岸" }],
      },
      {
        id: "mountain-clouds",
        title: "云停在山腰",
        image: {
          source: { kind: "remote", url: "https://picsum.photos/id/1016/900/600" },
          alt: "层叠山峰之间的低云和雾气",
        },
        link: {
          label: "查看照片",
          target: { kind: "document", documentId: "photo-mountain-clouds" },
        },
      },
      {
        id: "old-window",
        title: "午后的旧窗",
        image: {
          source: { kind: "remote", url: "https://picsum.photos/id/1060/700/1000" },
          alt: "阳光穿过木格旧窗投在墙面上",
        },
        link: {
          label: "查看照片",
          target: { kind: "document", documentId: "photo-old-window" },
        },
      },
      {
        id: "forest-path",
        title: "通往森林深处",
        image: {
          source: { kind: "remote", url: "https://picsum.photos/id/1043/700/1100" },
          alt: "高大树林间蜿蜒向前的小路",
        },
        link: {
          label: "查看照片",
          target: { kind: "document", documentId: "photo-forest-path" },
        },
        metadata: [{ label: "天气", value: "薄雾" }],
      },
      {
        id: "city-rain",
        title: "雨夜路口",
        image: {
          source: { kind: "remote", url: "https://picsum.photos/id/1033/900/600" },
          alt: "雨夜城市路口被车灯照亮的倒影",
        },
        link: {
          label: "查看照片",
          target: { kind: "document", documentId: "photo-city-rain" },
        },
      },
      {
        id: "desert-lines",
        title: "风写下的线条",
        image: {
          source: { kind: "remote", url: "https://picsum.photos/id/1002/700/1000" },
          alt: "沙丘表面由风形成的明暗纹理",
        },
        link: {
          label: "查看照片",
          target: { kind: "document", documentId: "photo-desert-lines" },
        },
      },
      {
        id: "harbor-morning",
        title: "港口醒来之前",
        image: {
          source: { kind: "remote", url: "https://picsum.photos/id/1011/900/650" },
          alt: "清晨平静港湾里的小船和远山",
        },
        link: {
          label: "查看照片",
          target: { kind: "document", documentId: "photo-harbor-morning" },
        },
        metadata: [{ label: "时间", value: "06:10" }],
      },
      {
        id: "stone-stairs",
        title: "青苔石阶",
        image: {
          source: { kind: "remote", url: "https://picsum.photos/id/1040/700/900" },
          alt: "雨后长着青苔的古老石阶",
        },
        link: {
          label: "查看照片",
          target: { kind: "document", documentId: "photo-stone-stairs" },
        },
      },
    ],
    sourcePageInfo: { totalItems: 8 },
  },
} as const;

export const IMAGE_DETAIL_SAMPLE_CONTENT = {
  schemaVersion: "inkos.content/v2",
  id: "photo-quiet-morning",
  revision: 1,
  locale: "zh-CN",
  updatedAt: "2026-07-14T14:20:00+08:00",
  page: {
    kind: "detail",
    layout: "image-story",
    eyebrow: "影像故事",
    title: "安静早晨里的一束光",
    summary: "清晨六点，第一束光穿过窗帘，让房间里的寻常物件有了新的轮廓。",
    byline: "林渡",
    publishedAt: "2026-07-12",
    heroImage: {
      source: { kind: "remote", url: "https://picsum.photos/id/1067/1200/800" },
      alt: "清晨阳光穿过窗帘照进安静的房间",
      caption: "光线抵达房间的第一个瞬间。",
    },
    content: [
      {
        type: "paragraph",
        text: "城市还没有完全醒来，街道的声音隔着玻璃显得很远。窗边的书、杯子和植物被光慢慢勾出边缘，我在原地等了几分钟，直到明暗关系变得刚刚好。",
      },
      {
        type: "image",
        image: {
          source: { kind: "remote", url: "https://picsum.photos/id/1068/900/1200" },
          alt: "窗帘和植物在墙面留下的细长影子",
          caption: "风让墙上的影子有了轻微的移动。",
        },
      },
      {
        type: "heading",
        level: 2,
        text: "留下真实的灰度",
      },
      {
        type: "paragraph",
        text: "这组照片没有追求浓烈的颜色，而是记录光线从暗部过渡到亮部的层次。十六级灰度屏可以保留更多细节，黑白屏则会把轮廓和反差表达得更直接。",
      },
      {
        type: "image",
        image: {
          source: { kind: "remote", url: "https://picsum.photos/id/1080/1000/700" },
          alt: "木桌上的咖啡、合上的书和一片树叶",
          caption: "早晨结束前，桌面仍保持着安静的秩序。",
        },
      },
      {
        type: "quote",
        text: "摄影有时只是耐心等待一束光来到正确的位置。",
        attribution: "拍摄手记",
      },
      {
        type: "link",
        link: {
          label: "返回周末影像",
          target: { kind: "document", documentId: "weekend-photo-stream" },
        },
      },
    ],
  },
} as const;

export const EBOOK_HOME_SAMPLE_CONTENT = {
  schemaVersion: "inkos.content/v2",
  id: "ebook-library-home",
  revision: 1,
  locale: "zh-CN",
  updatedAt: "2026-07-14T14:20:00+08:00",
  page: {
    kind: "list",
    layout: "bookshelf",
    title: "我的图书馆",
    description: "最近阅读与已下载的电子书",
    items: [
      {
        id: "the-old-man-and-the-sea",
        eyebrow: "正在阅读",
        title: "老人与海",
        summary: "一个老人、一条大马林鱼，以及人与命运之间漫长而安静的较量。",
        image: {
          source: { kind: "remote", url: "https://covers.openlibrary.org/b/isbn/9780684801223-L.jpg?default=false" },
          alt: "老人与海电子书封面",
        },
        link: {
          label: "继续阅读",
          target: { kind: "document", documentId: "ebook-old-man-and-the-sea" },
        },
        metadata: [
          { label: "作者", value: "欧内斯特·海明威" },
          { label: "阅读进度", value: "68%" },
        ],
      },
      {
        id: "three-body",
        title: "三体",
        summary: "文明在宇宙尺度中的相遇、猜疑与选择。",
        image: {
          source: { kind: "remote", url: "https://covers.openlibrary.org/b/isbn/9780765377067-L.jpg?default=false" },
          alt: "三体电子书封面",
        },
        link: {
          label: "打开图书",
          target: { kind: "document", documentId: "ebook-three-body" },
        },
        metadata: [
          { label: "作者", value: "刘慈欣" },
          { label: "阅读进度", value: "21%" },
        ],
      },
      {
        id: "meditations",
        title: "沉思录",
        summary: "关于自律、判断和内在秩序的私人笔记。",
        image: {
          source: { kind: "remote", url: "https://covers.openlibrary.org/b/isbn/9780140449334-L.jpg?default=false" },
          alt: "沉思录电子书封面",
        },
        link: {
          label: "打开图书",
          target: { kind: "document", documentId: "ebook-meditations" },
        },
        metadata: [
          { label: "作者", value: "马可·奥勒留" },
          { label: "状态", value: "已下载" },
        ],
      },
      {
        id: "the-little-prince",
        title: "小王子",
        summary: "一段写给大人的童话，也是关于爱与责任的寓言。",
        image: {
          source: { kind: "remote", url: "https://covers.openlibrary.org/b/isbn/9780156012195-L.jpg?default=false" },
          alt: "小王子电子书封面",
        },
        link: {
          label: "打开图书",
          target: { kind: "document", documentId: "ebook-the-little-prince" },
        },
        metadata: [
          { label: "作者", value: "安托万·德·圣埃克苏佩里" },
          { label: "阅读进度", value: "100%" },
        ],
      },
      {
        id: "art-of-war",
        title: "孙子兵法",
        summary: "从形势、谋略和行动中理解取胜的条件。",
        image: {
          source: { kind: "remote", url: "https://covers.openlibrary.org/b/isbn/9781599869773-L.jpg?default=false" },
          alt: "孙子兵法电子书封面",
        },
        link: {
          label: "打开图书",
          target: { kind: "document", documentId: "ebook-art-of-war" },
        },
        metadata: [
          { label: "作者", value: "孙武" },
          { label: "状态", value: "未开始" },
        ],
      },
      {
        id: "sapiens",
        title: "人类简史",
        summary: "从认知革命到现代社会的人类发展叙事。",
        image: {
          source: { kind: "remote", url: "https://covers.openlibrary.org/b/isbn/9780062316097-L.jpg?default=false" },
          alt: "人类简史电子书封面",
        },
        link: {
          label: "打开图书",
          target: { kind: "document", documentId: "ebook-sapiens" },
        },
        metadata: [
          { label: "作者", value: "尤瓦尔·赫拉利" },
          { label: "状态", value: "已下载" },
        ],
      },
    ],
    sourcePageInfo: { totalItems: 6 },
  },
} as const;

/**
 * A full-screen image intent that preserves the entire source image. The
 * renderer decides the actual matte size and colour for each screen profile.
 */
export const FULLSCREEN_IMAGE_CONTAIN_SAMPLE_CONTENT = {
  schemaVersion: "inkos.content/v2",
  id: "fullscreen-photo-contain",
  revision: 1,
  locale: "zh-CN",
  updatedAt: "2026-07-16T10:00:00+08:00",
  page: {
    kind: "image",
    layout: "contain",
    image: {
      source: { kind: "remote", url: "https://picsum.photos/id/1025/1200/800" },
      alt: "一只狗在自然环境中的横幅照片",
    },
    link: {
      label: "查看原始图片",
      target: { kind: "url", url: "https://picsum.photos/id/1025/1200/800" },
    },
  },
} as const;

/**
 * The same source image with a fill-screen intent. Comparing both examples
 * makes the renderer-owned crop visible without putting geometry in content.
 */
export const FULLSCREEN_IMAGE_COVER_SAMPLE_CONTENT = {
  schemaVersion: "inkos.content/v2",
  id: "fullscreen-photo-cover",
  revision: 1,
  locale: "zh-CN",
  updatedAt: "2026-07-16T10:00:00+08:00",
  page: {
    kind: "image",
    layout: "cover",
    image: {
      source: { kind: "remote", url: "https://picsum.photos/id/1025/1200/800" },
      alt: "一只狗在自然环境中的横幅照片",
    },
    link: {
      label: "查看原始图片",
      target: { kind: "url", url: "https://picsum.photos/id/1025/1200/800" },
    },
  },
} as const;

const JULY_2026_MONTH_GRID = [
  ["2026-06-29", "29", "六月", ""],
  ["2026-06-30", "30", "六月", ""],
  ["2026-07-01", "1", "", ""],
  ["2026-07-02", "2", "", ""],
  ["2026-07-03", "3", "", ""],
  ["2026-07-04", "4", "", ""],
  ["2026-07-05", "5", "", ""],
  ["2026-07-06", "6", "", ""],
  ["2026-07-07", "7", "", ""],
  ["2026-07-08", "8", "", ""],
  ["2026-07-09", "9", "", ""],
  ["2026-07-10", "10", "", ""],
  ["2026-07-11", "11", "", ""],
  ["2026-07-12", "12", "", ""],
  ["2026-07-13", "13", "产品周会", "09:30"],
  ["2026-07-14", "14", "渲染评审", "14:00"],
  ["2026-07-15", "15", "设备联调", "10:30"],
  ["2026-07-16", "16", "横竖屏验收", "16:00"],
  ["2026-07-17", "17", "版本发布", "11:00"],
  ["2026-07-18", "18", "阅读整理", ""],
  ["2026-07-19", "19", "下周计划", "20:00"],
  ["2026-07-20", "20", "", ""],
  ["2026-07-21", "21", "", ""],
  ["2026-07-22", "22", "", ""],
  ["2026-07-23", "23", "", ""],
  ["2026-07-24", "24", "", ""],
  ["2026-07-25", "25", "", ""],
  ["2026-07-26", "26", "", ""],
  ["2026-07-27", "27", "", ""],
  ["2026-07-28", "28", "", ""],
  ["2026-07-29", "29", "", ""],
  ["2026-07-30", "30", "", ""],
  ["2026-07-31", "31", "月度复盘", "15:00"],
  ["2026-08-01", "1", "八月", ""],
  ["2026-08-02", "2", "八月", ""],
  ["2026-08-03", "3", "八月", ""],
  ["2026-08-04", "4", "八月", ""],
  ["2026-08-05", "5", "八月", ""],
  ["2026-08-06", "6", "八月", ""],
  ["2026-08-07", "7", "八月", ""],
  ["2026-08-08", "8", "八月", ""],
  ["2026-08-09", "9", "八月", ""],
] as const;

const WEEKDAY_TEXT = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"] as const;

/**
 * A real six-week month grid. Dates, weekday labels, times and events are still
 * ordinary strings; dense seven-column rendering is inferred from the repeated
 * seven-item grid rather than a calendar-specific content type.
 */
export const GRID_SAMPLE_CONTENT = {
  schemaVersion: "inkos.content/v2",
  id: "july-team-calendar-grid",
  revision: 1,
  locale: "zh-CN",
  updatedAt: "2026-07-16T14:00:00+08:00",
  page: {
    kind: "list",
    layout: "grid",
    title: "2026 年 7 月",
    description: "完整月历；日期、时间和事项都是普通文本。",
    items: JULY_2026_MONTH_GRID.map(([id, title, summary, time], index) => ({
      id: `calendar-${id}`,
      eyebrow: WEEKDAY_TEXT[index % 7],
      title,
      ...(summary ? { summary } : {}),
      ...(time ? { metadata: [{ label: "时间", value: time }] } : {}),
    })),
  },
} as const;

/**
 * Reader deliberately has no page title or media. Its first paragraph is
 * content, not a hidden title, and can flow directly across device pages.
 */
export const READER_SAMPLE_CONTENT = {
  schemaVersion: "inkos.content/v2",
  id: "reader-quiet-morning",
  revision: 1,
  locale: "zh-CN",
  updatedAt: "2026-07-16T14:00:00+08:00",
  page: {
    kind: "reader",
    content: [
      {
        type: "paragraph",
        text: "清晨的城市还没有完全醒来。窗外只有几辆很慢的车，树叶在微风里发出细小的声音。把屏幕切到纯阅读模式后，页面不再保留标题区域，正文从自然的起点开始排布。",
      },
      {
        type: "paragraph",
        text: "同一段文字进入不同设备时，渲染器会重新计算每行长度、段落间距和分页位置。横屏适合更长的行，竖屏则保留更连续的阅读节奏；内容本身不需要知道这些变化。",
      },
      {
        type: "heading",
        level: 2,
        text: "保持内容简单",
      },
      {
        type: "list",
        ordered: false,
        items: [
          "段落只保存正文",
          "小标题表达章节层次",
          "列表与引用保留原有语义",
          "字号变化会触发重新分页",
        ],
      },
      {
        type: "quote",
        text: "阅读页面不需要装饰自己，清楚地承载文字就够了。",
        attribution: "InkOS 阅读原则",
      },
      {
        type: "heading",
        level: 3,
        text: "从屏幕继续",
      },
      {
        type: "paragraph",
        text: "设备只需要接收当前页图像和帧清单。换一块屏幕、调整两档字号，或者从竖屏切到横屏，都由服务器再次生成符合目标设备能力的结果。",
      },
    ],
  },
} as const;

/**
 * Menu and timeline are both linear lists. Time is normal metadata and links
 * remain navigation intent rather than layout instructions.
 */
export const SEMANTIC_LIST_SAMPLE_CONTENT = {
  schemaVersion: "inkos.content/v2",
  id: "today-linear-list",
  revision: 1,
  locale: "zh-CN",
  updatedAt: "2026-07-16T14:00:00+08:00",
  page: {
    kind: "list",
    layout: "list",
    title: "今天",
    description: "时间线与菜单统一为线性条目，日期和状态仍是普通文本。",
    items: [
      {
        id: "morning-brief",
        eyebrow: "08:30",
        title: "查看晨间摘要",
        summary: "天气、未读消息与设备状态。",
        metadata: [{ label: "状态", value: "已完成" }],
        link: {
          label: "打开摘要",
          target: { kind: "document", documentId: "morning-brief" },
        },
      },
      {
        id: "render-review",
        eyebrow: "10:00",
        title: "评审五种语义布局",
        summary: "比较 PaperS3、Xiaozhi Card Kit 与 PaperColor 的输出。",
        metadata: [{ label: "参与者", value: "产品与研发" }],
        link: {
          label: "查看议程",
          target: { kind: "document", documentId: "render-review" },
        },
      },
      {
        id: "device-sync",
        eyebrow: "14:30",
        title: "同步设备",
        summary: "向测试设备推送最新渲染帧。",
        metadata: [{ label: "设备", value: "3 台" }],
        link: {
          label: "进入设备列表",
          target: { kind: "document", documentId: "devices" },
        },
      },
      {
        id: "reading-mode",
        eyebrow: "20:00",
        title: "继续阅读",
        summary: "从上一次分页位置打开纯文本 Reader。",
        metadata: [{ label: "进度", value: "42%" }],
        link: {
          label: "继续阅读",
          target: { kind: "document", documentId: "reader-quiet-morning" },
        },
      },
    ],
    sourcePageInfo: { totalItems: 4 },
  },
} as const;

/**
 * A single visual message. Codes, tickets or stamps can be supplied through
 * the same ordinary image fields; postcard does not define a QR data type.
 */
export const POSTCARD_SAMPLE_CONTENT = {
  schemaVersion: "inkos.content/v2",
  id: "postcard-coastline",
  revision: 1,
  locale: "zh-CN",
  updatedAt: "2026-07-16T14:00:00+08:00",
  page: {
    kind: "detail",
    layout: "postcard",
    title: "来自海边的问候",
    heroImage: {
      source: { kind: "remote", url: "https://picsum.photos/id/1011/1200/800" },
      alt: "清晨海湾中的小船和远山",
      caption: "海风很轻，港口刚刚醒来。",
    },
    content: [
      {
        type: "paragraph",
        text: "今天沿着海岸走了很久。把这片安静的蓝色寄给你，愿你也有一个从容的下午。",
      },
      {
        type: "quote",
        text: "下一次，我们一起看日落。",
        attribution: "林渡",
      },
    ],
  },
} as const;

/**
 * A compact multi-card dashboard. Each metric is still represented by the
 * same list-item text fields, with no chart coordinates or column count.
 */
export const CARDBOARD_SAMPLE_CONTENT = {
  schemaVersion: "inkos.content/v2",
  id: "home-status-cardboard",
  revision: 1,
  locale: "zh-CN",
  updatedAt: "2026-07-16T14:00:00+08:00",
  page: {
    kind: "list",
    layout: "cardboard",
    title: "家庭状态",
    description: "多个信息卡并列展示，列数和优先级由屏幕策略决定。",
    items: [
      {
        id: "weather",
        eyebrow: "天气",
        title: "26°C",
        summary: "多云，体感舒适",
        metadata: [
          { label: "湿度", value: "68%" },
          { label: "空气", value: "优" },
        ],
      },
      {
        id: "indoor",
        eyebrow: "室内",
        title: "24°C",
        summary: "客厅环境稳定",
        metadata: [{ label: "二氧化碳", value: "620 ppm" }],
      },
      {
        id: "energy",
        eyebrow: "今日用电",
        title: "8.4 kWh",
        summary: "比昨日减少 12%",
        metadata: [{ label: "当前功率", value: "460 W" }],
      },
      {
        id: "devices",
        eyebrow: "设备",
        title: "12 在线",
        summary: "1 台设备需要关注",
        metadata: [{ label: "低电量", value: "书房传感器" }],
        link: {
          label: "查看设备",
          target: { kind: "document", documentId: "devices" },
        },
      },
      {
        id: "next-event",
        eyebrow: "下一项",
        title: "18:30 晚餐",
        summary: "预计 4 人",
        metadata: [{ label: "提醒", value: "提前 20 分钟" }],
      },
      {
        id: "commute",
        eyebrow: "通勤",
        title: "32 分钟",
        summary: "道路通畅",
        metadata: [{ label: "建议出发", value: "17:48" }],
      },
    ],
    sourcePageInfo: { totalItems: 6 },
  },
} as const;

// Backwards-compatible import name for the default simulator example.
export const SAMPLE_CONTENT = DETAIL_SAMPLE_CONTENT;
