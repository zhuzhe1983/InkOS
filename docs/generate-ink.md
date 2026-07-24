# 生成与安装 `.ink` / Generate and install `.ink`

`.ink` 是 InkOS 的纯数据离线包格式。它是一个可验证的 ZIP 容器，包含语义文档、
预渲染页面、链接点击区域、导航关系和完整性清单，不包含可执行代码。

本指南介绍三种工作流：

1. 使用网页生成器把一个 HTTPS 网站生成 `.ink`；
2. 通过 API 集成自动化生成；
3. 修改结构化首页并上传为 PaperS3 应用首页。

## 中文

### 1. 启动 InkOS 服务

生成器需要 Node.js 和可用的 Chromium/Chrome：

```bash
cd web
npm install
npm run dev
```

然后打开 <http://127.0.0.1:3000/ink-generator>。

### 2. 用网页生成器创建 `.ink`

填写：

- **来源网址**：完整的 HTTPS 页面；JavaScript 页面默认由 Chromium 执行后提取。
- **离线包标题**：显示在包清单和客户端中。
- **抓取深度**：`0` 只处理当前页面，`1` 会继续处理允许的直接子页面。
- **最大文档数**：第一次测试建议设为 `1–3`，确认结构后再扩大。
- **设备**：PaperS3 使用 `m5stack-paper-s3-portrait`。
- **方向与字号**：每一种组合都是一个精确预渲染变体。只选“竖屏 + 0”生成最快；
  需要完全离线切换时再加入其他组合。

提交后，服务端依次执行：

```text
排队 → 抓取 → 提取语义内容 → 渲染页面 → 校验并打包
```

任务完成后点击“下载 `.ink`”。生成器返回的文件带有包 ID、字节长度和 SHA-256，
客户端会再次验证这些信息。

### 3. 通过 API 自动生成

创建异步任务：

```bash
curl -sS 'http://127.0.0.1:3000/api/ink/v1/generator/jobs' \
  -H 'Accept: application/json' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: replace-with-a-stable-unique-key' \
  --data-raw '{
    "seedUrl": "https://zh.wikipedia.org/wiki/Nook",
    "title": "Nook 阅读包",
    "sourceMode": "chromium",
    "deliveryMode": "archive",
    "maxDepth": 0,
    "maxDocuments": 1,
    "profileIds": ["m5stack-paper-s3-portrait"],
    "orientations": ["portrait"],
    "fontLevels": [0]
  }'
```

响应中的 `statusUrl` 是任务状态地址。轮询到 `status: "complete"` 后，使用返回的
`artifactUrl` 下载文件：

```bash
curl -fL -OJ \
  'http://127.0.0.1:3000/api/ink/v1/generator/jobs/<jobId>/artifact'
```

重复提交完全相同的请求时可以复用同一个 `Idempotency-Key`；同一个 key 对应不同
请求会返回 `409`，防止意外生成两个含义不同的任务。

完整字段、错误码和 SSE 事件流见
[网站服务 API](./service-api.md#4-generator-jobs)。

### 4. 上传到 PaperS3

1. 让电脑或手机与 PaperS3 连接到同一局域网。
2. 在设备设置页查看“管理后台”地址，例如 `http://192.168.199.61/`。
3. 浏览器打开该地址，找到“应用首页 `.ink`”。
4. 选择刚下载的文件，点击“校验并启用”。
5. 等待后台完成上传、ZIP 检查、清单解析、长度与 SHA-256 校验。

<p align="center">
  <img src="./assets/readme/device-manager.png" width="620" alt="PaperS3 局域网管理后台中的内容列表和 .ink 上传区域">
</p>

设备把新包写入非活动存储槽；只有完整验证通过后才切换当前首页。因此：

- 上传中断不会破坏正在使用的首页；
- 不兼容或损坏的包不会被激活；
- 可以随时点击“恢复内置首页”回到固件自带的安全 fallback。

### 5. 自定义 InkOS 应用首页

网站生成器适合把普通网页变成阅读型首页。若要制作带“RSS 阅读器、网络阅读器、
图片查看器、地图、设置”等本地入口的应用首页，可以修改结构化内置首页：

```text
web/lib/ink/builtin/papers3-home.ts
```

页面仍然只描述标题、说明、列表项和链接，不应写入像素坐标。客户端支持的精确动作
包括：

```text
inkos://collection/rss
inkos://collection/website
inkos://app/random-image
inkos://app/baidu-map
inkos://device/settings
```

这些是客户端动作，不是需要服务器抓取的网址。修改完成后生成首页包：

```bash
cd web
npm run export:papers3-home -- --output ../output/custom-home
```

输出目录包含：

```text
output/custom-home/
├── home.ink
└── home.version.json
```

将 `home.ink` 通过设备管理后台上传即可；只有制作固件内置 fallback 时，才需要把
它放入 `firmware-idf/main/assets/` 后重新构建固件。

### 6. 常见问题

#### 为什么生成很慢？

JavaScript 网站需要启动或复用 Chromium、等待主要 DOM 稳定、提取内容并下载受限
图片。变体数量等于：

```text
设备数 × 方向数 × 字号数
```

第一次调试尽量只选择一个变体。

#### `.ink` 会执行网页脚本吗？

不会。脚本只在服务端受控 Chromium 环境中执行；`.ink` 内只有数据和图片。

#### 上传后能修改 RSS、网站和图片列表吗？

能。这些列表属于设备持久配置，不需要重新生成首页或刷固件。首页中的应用入口和
设备中的内容列表是两层独立数据。

#### 为什么某个网站内容不完整？

InkOS 对 DOM 节点数、捕获字节、下载图片、跳转、抓取深度和任务时间都有硬上限。
复杂网站可能需要专门适配；服务不会为了“抓全”而取消安全与资源边界。

### 7. 格式与客户端实现

- [`.ink` package format v1](./ink-package-format.md)
- [客户端协议](./client-protocol.md)
- [PaperS3 设备管理](./papers3-device-management.md)
- [服务 API](./service-api.md)

---

## English

`.ink` is InkOS's data-only offline package. It is a verifiable ZIP container
with semantic documents, pre-rendered frames, interaction hitboxes, navigation,
and integrity metadata. It contains no executable package code.

### Generate from the website UI

Start the service:

```bash
cd web
npm install
npm run dev
```

Open <http://127.0.0.1:3000/ink-generator>, enter an HTTPS seed URL and title,
then select the crawl limits and exact device variants. Start with one
PaperS3 portrait/font-0 variant for the shortest feedback loop. Download the
artifact after the persisted job reaches `complete`.

### Generate through the API

Create a job with `POST /api/ink/v1/generator/jobs`, poll its returned
`statusUrl`, and download the completed `artifactUrl`. The JSON and `curl`
example in the Chinese section above use the complete public v1 contract.
Send a stable, unique `Idempotency-Key` so retrying the same request cannot
accidentally create another job.

### Install on PaperS3

Open the device's LAN manager, select the archive under “应用首页 `.ink`”, and
choose “校验并启用”. The device writes to the inactive slot and activates it
only after ZIP, manifest, compatibility, length, and SHA-256 validation. The
firmware-embedded home remains available through “恢复内置首页”.

### Build a custom application home

Edit the coordinate-free home documents in
`web/lib/ink/builtin/papers3-home.ts`, then run:

```bash
cd web
npm run export:papers3-home -- --output ../output/custom-home
```

Upload `output/custom-home/home.ink` through the device manager. Rebuilding
firmware is required only when changing the embedded fallback.

For the normative details, read the
[package format](./ink-package-format.md),
[client protocol](./client-protocol.md), and
[service API](./service-api.md).
