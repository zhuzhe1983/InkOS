# Inkos Render Lab

Server-side semantic e-paper renderer and three-device simulator.

## Run locally

```bash
npm install
npm run dev
```

Open <http://127.0.0.1:3000>.

## Architecture

```text
ContentDocument v2 (pure semantic content)
                    +
DisplayMeta (request-level display preference)
                    +
ScreenProfile (trusted resolution + active panel size)
                    ↓
Device LayoutStrategy (PaperS3 / Xiaozhi / PaperColor)
                    ↓
internal coordinates, pagination and link hit areas
                    ↓
RasterStrategy (gray4 / mono1 / fixed Spectra 6)
                    ↓
PNG frame + FrameManifest v2
```

The content contract describes only meaning and reading order. Presentation data
such as `x`, `y`, `width`, `fontSize`, `color`, a design viewport or a device type
is rejected by the strict schema. A page may carry only a small semantic layout
intent. These are not pixel templates: they do not prescribe columns, sizes or
styling. Coordinates are allowed only in renderer-owned intermediate layout and
output interaction hit areas.

For a live website, the server uses an explicit rendered-content pipeline:

```text
HTTPS URL
    -> Chromium executes JavaScript
    -> bounded post-render semantic DOM
    -> Markdown
    -> inkos.content/v2 semantic JSON
    -> device ScreenProfile + renderer
    -> PNG frames, sidecars and a verified .ink package
```

Markdown is an intermediate representation, not a client payload or a visual
template. The final `inkos.content/v2` document still contains only reusable
content meaning. The PaperS3 client sends a URL to InkOS and never connects to,
executes, parses or proxies the source website itself.

## Merged layout catalog

The five reusable layout intents share the smallest possible content families:

| Intent | Content shape | Covers |
| --- | --- | --- |
| `grid` | `kind: "list"` | regular collections and calendar-like text cells |
| `reader` | `kind: "reader"` | title-free paragraphs, headings, lists and quotes |
| `list` | `kind: "list"` | menus and timeline-like linear entries |
| `postcard` | `kind: "detail"` | focus cards, passes and visual messages |
| `cardboard` | `kind: "list"` | multi-card status and dashboard summaries |

QR codes and ticket marks are ordinary `image` values. Dates, times, status and
metrics are ordinary text fields; the renderer does not introduce special QR,
calendar or metric primitives. Existing `feed`, `masonry`, `bookshelf`,
`article`, `image-story`, `contain` and `cover` intents remain supported for
backward compatibility.

Example detail document:

```json
{
  "schemaVersion": "inkos.content/v2",
  "id": "note-1",
  "revision": 1,
  "locale": "zh-CN",
  "page": {
    "kind": "detail",
    "title": "服务端语义渲染",
    "summary": "同一份内容适配不同墨水屏。",
    "content": [
      { "type": "paragraph", "text": "排版、分页和灰阶量化由渲染器决定。" },
      {
        "type": "link",
        "link": {
          "label": "阅读下一篇",
          "target": { "kind": "document", "documentId": "note-2" }
        }
      }
    ]
  }
}
```

Example list item:

```json
{
  "id": "article-1",
  "title": "PaperS3 排版策略",
  "summary": "标题、摘要和图片会按屏幕容量重新编排。",
  "image": {
    "source": { "kind": "asset", "assetId": "articles/paper-s3" },
    "alt": "PaperS3 上的文章页面"
  },
  "link": {
    "label": "打开文章",
    "target": { "kind": "document", "documentId": "article-1" }
  }
}
```

The full detail, list, reader and image examples are in
[`lib/rendering/sample-content.ts`](./lib/rendering/sample-content.ts).

Example full-screen image document:

```json
{
  "schemaVersion": "inkos.content/v2",
  "id": "photo-1",
  "revision": 1,
  "locale": "zh-CN",
  "page": {
    "kind": "image",
    "layout": "contain",
    "image": {
      "source": { "kind": "remote", "url": "https://picsum.photos/id/1025/1200/800" },
      "alt": "一只狗在自然环境中的横幅照片"
    }
  }
}
```

`contain` shows the complete image with a renderer-owned matte/frame;
`cover` fills the panel and crops overflow around the centre. Both preserve the
source aspect ratio and always produce one page. A full-screen image deliberately
rejects captions and titles; use `detail` with `image-story` when visible copy is
part of the content.

## Screen profiles

- `m5stack-paper-s3-portrait`: 540×960 logical portrait, 960×540 native panel,
  103.68×58.32 mm active area (~235 PPI), 16 gray levels,
  `paper-s3-semantic-v1` layout and 4-bit indexed PNG output.
- `m5stack-xiaozhi-card`: 176×264 native portrait, 2 color levels,
  38.192×57.288 mm active area (~117 PPI), `xiaozhi-card-semantic-v1`
  layout and 1-bit indexed PNG output.
- `m5stack-paper-color`: 400×600 native portrait, fixed Spectra 6 palette,
  56.4×84.6 mm active area (~180 PPI), `paper-color-semantic-v1` layout and
  4-bit indexed PNG output. Its default
  `eink-spectra6-photo-dither-png-v2` raster strategy uses perceptual OKLab
  palette matching plus serpentine Floyd–Steinberg error diffusion inside
  renderer-owned photo regions. Text, rules and other UI pixels remain hard
  quantized so they stay crisp. The legacy no-dither v1 strategy remains
  readable for compatibility and A/B tests.

All adapters receive the same semantic document. They may change line wrapping,
density, image treatment and page count, but preserve content order and link
meaning. They never scale one device's full canvas to another device.

`physicalSizeMm` is the display's active pixel area in native panel orientation,
not the enclosure size. The renderer derives PPI from it and converts its
160-PPI design units into pixels before pagination. The same density conversion
drives typography, rules/borders, padding/gaps, corner radii and icon sizes. On
touch profiles, interaction bounds are expanded and clipped to a minimum 7 mm
target. `fontLevel` is then applied only to the density-aware type metrics.
Rotation changes the logical canvas but not the native active-area metadata or
the derived physical scale.

These values are trusted profile metadata. They never appear in
`inkos.content/v2`, so a document stays reusable and coordinate/device-free.
Regular `grid` column count is also selected from the current logical physical
width: PaperS3's 58.32 mm portrait width uses two columns, while its 103.68 mm
landscape width uses four. The content still requests only `layout: "grid"`.

## APIs

### `POST /api/render`

```json
{
  "profileId": "m5stack-xiaozhi-card",
  "pageIndex": 0,
  "displayMeta": {
    "invert": false,
    "fontLevel": 1,
    "orientation": "landscape"
  },
  "document": {
    "schemaVersion": "inkos.content/v2",
    "id": "note-1",
    "revision": 1,
    "page": {
      "kind": "detail",
      "title": "服务端语义渲染",
      "content": [{ "type": "paragraph", "text": "内容会按目标屏幕重新排版。" }]
    }
  }
}
```

`displayMeta` belongs to the render request, not to the reusable content
document:

- `invert` is retained for wire compatibility, defaults to `false`, and only
  accepts `false`; inverse requests are rejected.
- `fontLevel` is one of `-2`, `-1`, `0`, `1`, `2` and defaults to `0`. It is a
  device-relative step, not a pixel size. Text is reflowed and repaginated using
  that device's typography theme; the canvas and images are not scaled.
- `orientation` is `portrait` or `landscape` and defaults to `portrait`. It
  derives a request-scoped logical screen, safe area, refresh alignment and
  display rotation from the trusted device profile, then performs a full layout
  and pagination pass.
- `outputTuning` is an optional, strictly validated server-raster override for
  gray4 PaperS3 output. Omitting it uses the trusted profile default; accepted
  controls and bounds are documented in
  [the service API](../docs/service-api.md#1-online-rendering).

Unknown display fields and out-of-range or fractional font levels are rejected.

The response body is the selected PNG page. `X-Inkos-Manifest` is a base64url
encoded `inkos.frame/v2` manifest containing profile and renderer versions,
logical/native sizes, normalized `displayMeta`, layout and raster strategies,
pagination, checksums, warnings and link hit areas. `X-Inkos-Warnings` exposes
the warning list separately for lightweight clients.

PaperS3 responses may also expose `X-Ink-Refresh-Hint: binary-text`, mirrored
as optional `refreshHint` manifest metadata. It is emitted only after the
semantic document is proven image-free and the final stable-gray4 PNG is
near-binary (at least 92% terminal black/white pixels). It is advisory:
unsupported clients and all responses without the hint use quality refresh.

An optional `region` requests aligned partial output. It controls the generated
device frame and is intentionally outside the content document.

### `GET /api/device-profiles`

Returns the trusted screen-profile registry used by the simulator and renderer.

### `GET /api/render/schema`

Returns JSON Schema representations of the content, screen and request contracts.

### Versioned client and generator service

`/api/ink/v1` is the public client-facing service. It exposes:

- `POST /render` for an `inkos.document/v1` envelope and a paired
  `inkos.frame-sidecar/v1` response;
- `POST /sources/resolve` for server-side URL ingestion and cached package
  resolution;
- `POST /packages/{packageId}/render` for high-priority, display-specific
  rendering from a verified semantic package;
- `POST /generator/jobs` plus persisted status and artifact resources;
- `GET /packages/**` for the verified online catalog, semantic documents,
  exact pre-rendered frames, sidecars and `.ink` downloads;
- `GET /openapi.json` for the machine-readable API contract.

The browser generator at `/ink-generator` consumes the same asynchronous API
that other systems can call. The PaperS3 browser client at `/papers3-client`
uses the same frame/sidecar model online and when a local `.ink` file is opened.
The normative contracts live in `../docs/client-protocol.md`,
`../docs/ink-package-format.md` and `../docs/service-api.md`.
Operational smoke checks are recorded in `../docs/health-checkpoints.md`.

### PaperS3 application home package

Opening `/papers3-client` without `url`, `package` or `uuid` downloads the
catalog's explicit application-home `.ink`, verifies it through the same archive
installer used for a user-selected file, and opens it in offline-package mode.
The offline source panel exposes the same built-in archive as an **Application
home Demo** choice alongside the local file picker. Explicit URL and package
deep links always take precedence and never silently fall back to the home.

That home is an ordinary, downloadable `.ink` archive, not a browser-only screen
or a special client command. Its entry document is a semantic `grid` containing
seven working applications: web browser, month calendar, today's almanac, reading
list, display reading test, user guide and the local clock. PaperS3 portrait uses
two cards per row; landscape derives four from its physical width. Page and app
names render as bold text while descriptions retain normal weight. The browser
list includes Jandan, Chinese Wikipedia, People's Daily, Baidu Tieba and
Chiphell. The six-week month
grid links every date to a packaged almanac detail document. An HTTPS link opened
from the offline home is still submitted to the InkOS server for URL resolution;
the browser never fetches the target site directly, and parent navigation restores
the previous offline-home document.

The clock child is a portrait-focused, footerless large-time page. Its complete
PNG fallback says “正在校时” instead of drawing fake digits; a verified
`dynamicRegion` replaces that one 97 px monospace title region with current
`HH:mm:ss`. Only the package date/weekday, `Asia/Shanghai`/UTC offset and 24-hour
notation remain around it—there is no rendering-implementation explanation.

The display-test app also links to two offline full-screen views of one bundled,
lossless 960 x 540 diagnostic image. It includes the 16 exact gray levels,
1/2/4-pixel patterns, a continuous gradient and half-step gray patches for
dither inspection. Landscape `contain` is a native 1:1 panel check; portrait
`contain` preserves the complete image with letterboxing, while `cover` fills
the screen and demonstrates centered cropping. No network image is required.

The built-in package has a stable package lineage and deterministic document
UUIDs. Its daily revision is generated in the `Asia/Shanghai` calendar so the
today entry changes at the correct local midnight. Lunar, sexagenary-cycle and
traditional almanac text is produced locally by the MIT-licensed
`lunar-javascript` library; no third-party almanac API is called at runtime.
The home archive stores only the two base PaperS3 orientations at normal font.
This lets the default offline home honor portrait/landscape switching without
enumerating every font Cartesian product. Other online
display tuples render only the requested document/page through the manifest-bound
package renderer. Offline use remains strict for tuples absent from its manifest.

When renderer density policy changes, regenerate both firmware assets together;
the exporter writes the archive and its byte/hash metadata atomically:

```sh
cd web
npm run export:papers3-home -- --output ../firmware-idf/main/assets
cd ../firmware-idf
python3 tools/verify_embedded_home.py
python3 -m unittest discover -s tools -p 'test_*.py' -v
idf.py build
```

The current output policy increments the renderer to `inkos-renderer/0.8.0`
and the built-in home generator to `1.5.0`. Existing server-catalog home data is
also rebuilt on its next ensure request because the persisted generator version
no longer matches. Export/build does not flash a device.

### URL content in the PaperS3 client

The regular PaperS3 page accepts an HTTPS source URL. Viewport-only mode can
also resolve it on initial load:

```text
/papers3-client?fullscreen=1&url=https%3A%2F%2Fjandan.net%2F
```

After a verified frame opens, the client also writes its exact shareable
location to the address bar:

```text
/papers3-client?fullscreen=1&url=<encoded>&package=<package-uuid>&uuid=<document-uuid>&page=0
```

The UUID location is authoritative: a mismatch or missing frame fails instead
of silently opening another catalog package. Viewport-only mode contains no
visible client controls or hints. It silently attempts the Fullscreen API on
the first gesture; the installable PWA launches without browser chrome when
served from a secure HTTPS context.

The browser sends `{ "url": "...", "displayMeta": { ... } }` only to
`POST /api/ink/v1/sources/resolve`; it never fetches the source website itself.
The server validates HTTPS, opens the page in Chromium, executes its JavaScript,
captures a bounded rendered DOM, converts it through Markdown to semantic
`inkos.content/v2`, and renders a versioned PaperS3 package with 16 gray levels.
Only the current display tuple is pre-rendered; later direction or font changes
use the manifest-bound package render endpoint.

RSS/Atom XML is parsed as inert bounded data. The file-backed, strictly
validated `lib/ink/generator/styles/rss-default.v1.json` selects semantic
`list/feed` and `detail/article|image-story` behavior without coordinates,
CSS, selectors or executable rules. Entry authors and channel descriptions are
preserved. RSS `content:encoded` and Atom `content` are normalized through the
same HTML → Markdown → semantic-block path as Chromium and take precedence
over short `description`/`summary` teasers; linked Chromium remains the bounded
fallback for teaser-only feeds. Atom author metadata inherits entry → source →
feed, and `published` wins over `updated` independently of XML child order.
Feed → entry → content → nested XHTML element `xml:base` inheritance applies
to links, images and safe `content@src` fallbacks. Legacy `http://` permalinks
and inherited base values are upgraded only when they name the exact host of
the validated HTTPS feed/entry; all other cleartext links remain filtered. For the
Baidu Tieba root page, whose HTML
landing deliberately returns a security-verification 403 to server browsers,
the resolver uses Tieba's public hot-topic JSON endpoint under the same
HTTPS/DNS/SSRF/byte limits. Chromium uses the installed browser's real version
with a normal Chrome product token so sites do not reject it solely because
Playwright's default token says `HeadlessChrome`; no cookies, accounts, CAPTCHA
solver or stealth patches are added.

Before Markdown conversion, Chromium records each image's final rendered
dimensions. Hidden images, tracking pixels, small icon/badge/logo/avatar chrome
(up to 64 x 64), and thin decorative separators are discarded before they can
consume content or fullscreen-preview budgets. Large editorial images and QR
images remain ordinary semantic images. Plain-HTTP ingestion applies the same
rule conservatively from declared dimensions and accessibility/UI semantics.

Very large books keep the global 2 MiB / 20,000-node hard limits. The capture
stage instead produces a smaller contiguous semantic prefix: it prefers
`main`/`article`, removes site and Gutenberg boilerplate, retains one chapter
directory plus safe links/images, promotes short chapter labels to headings and
trims only from the tail (or truncates one indivisible text leaf). The partial
capture warning remains attached to the job. This lets the realtime draft
paginate useful opening chapters within the existing 240,000-character Markdown
budget instead of failing the whole URL.

The foreground request is deliberately a fast, valid `.ink` draft at revision
17. Its internal generator request uses `sourceMode="chromium"`,
`deliveryMode="realtime"`, `maxDepth=0` and `maxDocuments=1`; it processes only
the current URL, retains at most 16 feed items or four detail blocks, and
materializes at most the first six image-preview documents. After the draft is
published, a low-priority revision 18 archive job expands the crawl to at least
depth 1 / four documents and materializes all bounded image previews. A later
resolve or refresh selects that higher revision after it has passed package
verification. Revision numbers describe the current service implementation;
clients follow the authoritative manifest and must not hard-code them.
Images beyond the draft preview cap still render inline; they simply have no
fullscreen hitbox until their preview child is present.

A new or reused pending generation returns `202` with `job`, `jobId`,
`statusUrl` and `eventsUrl`. The client polls the status resource (SSE is
optional) while preserving its current frame. A completed or cached response
returns the package identity. The client activates that exact `packageId` only
after manifest compatibility, byte-length, SHA-256 and frame-decode validation;
it never substitutes the first catalog entry or guesses the expected ID.

Because the v1 `packageId` URL advances from the realtime draft to later archive
revisions, every online document/frame/sidecar request carries the verified
manifest ETag in `If-Match`. The service returns `412 PACKAGE_REVISION_CHANGED`
before serving bytes from a different revision; the client reloads the same
manifest and retries the complete target transaction at most once while keeping
the previous package/frame active. Length and SHA-256 validation remain strict.

The nested query value must be percent-encoded. In particular, encode source URL
`&` and `#` characters so they are not consumed by the outer PaperS3 client URL.

Published source packages use a three-minute freshness TTL by default. A fresh
verified package returns immediately. A stale verified package also returns
immediately and is revalidated asynchronously, so Chromium capture does not
block the retained first frame. `X-InkOS-Source-Cache` reports `hit`, `stale` or
`miss`; detailed asynchronous stage durations are recorded in the generator
job's `timings` map.

Chromium reuses one browser process but creates and closes an isolated,
non-persistent browser context for every capture. It waits for
`DOMContentLoaded`, performs a short DOM-stability check and at most two bounded
scrolls, and never waits for `networkidle`. Capture has a 10-second hard
deadline. Initial URLs, redirects and subresources are restricted to public
credential-free HTTPS destinations; DNS results, private/link-local ranges,
resource types, DOM size and output size are bounded. No LLM is in the realtime
critical path.

For local Clash/Surge-style TUN deployments, `198.18.0.0/15` is accepted as a
controlled Fake-IP egress range. Loopback, RFC1918, link-local, CGNAT, IPv6 ULA
and documentation/metadata ranges remain blocked.

Runtime settings:

| Variable | Meaning |
| --- | --- |
| `INKOS_CHROMIUM_EXECUTABLE_PATH` | Optional explicit Chromium/Chrome executable. |
| `INKOS_CHROMIUM_USER_AGENT` | Optional explicit Chromium user agent; otherwise a normal Chrome token is derived from the installed browser version. |
| `INKOS_SOURCE_CACHE_TTL_MS` | Source freshness TTL; default 3 minutes, accepted range 10 seconds to 24 hours. |
| `INKOS_GENERATOR_CONCURRENCY` | Generator workers; default 2, accepted range 1 to 8. With the default, archive work uses at most one low-priority slot so a foreground slot remains available. |
| `INKOS_PAPERS3_HOME_ARCHIVE` | Optional absolute path to the release-pinned PaperS3 `home.ink`. When set, the catalog publishes this archive exactly and keeps its self-consistent revision/date across wall-clock days until a newer paired firmware archive is deployed. |

Development-machine sample, July 2026, using Jandan: Chromium capture through
Markdown and semantic JSON took about 3.0 seconds; the realtime draft `.ink`
was ready in 3.34 seconds and contained seven documents, with the entry document
rendered to three pages, at about 312 KB. This is a local diagnostic sample, not
an SLA.

The same machine resolved Project Gutenberg `pg24230-images.html` in 10.3
seconds after a cold start: the then-current foreground package contained 51
opening pages at about 2.70 MB. The reserved background queue then published the
608-page background archive without blocking another foreground slot.

## Image boundary

Content may reference a trusted `assetId` or a remote image, but the renderer does
not expose an arbitrary image proxy. Direct render requests use the default
`AssetResolver`, which accepts HTTPS images only from the sample providers
(Picsum and Open Library) and Wikimedia's dedicated upload host, plus narrowly
controlled redirect hosts. A `/sources/resolve` job may add only the exact public
HTTPS image hosts discovered in that job's validated semantic documents. Both
paths validate DNS and every redirect and enforce MIME, timeout, byte-size and
pixel-size limits. Accepted images are normalized before layout and deduplicated
through a resolver cache. Rejected or unavailable images become labelled
placeholders with explicit warnings instead of silently disappearing.

## Commands

```bash
npm run lint
npm test
npm run build
```

Tests cover all five merged layouts, legacy detail/list and image-led layouts
across all three devices in both orientations, strict semantic fields, all five
font levels, inverse-request rejection, full-screen `contain`/`cover`, deterministic
image resolution, content conservation, real PNG bit depth and dimensions,
fixed Spectra 6 pixels, pagination, page selection and partial-frame alignment.

A future "template JSON" should only be a versioned server-side preset that
provides defaults for already validated fields such as `displayMeta`. It must not
introduce coordinates, CSS, pixel sizes or unrestricted parameter bags.

PNG is currently the transport and debugging codec. A later panel-native encoder
can add packed `mono1`/`gray4` plus Deflate or RLE while preserving the same frame
manifest boundary.
