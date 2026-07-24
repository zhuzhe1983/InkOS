# InkOS website service API v1

Base path: `/api/ink/v1`  
OpenAPI document: `/api/ink/v1/openapi.json`  
Protocol: [`inkos.client/v1`](./client-protocol.md)

The website exposes the renderer and `.ink` generator as reusable services. The
web generator UI and PaperS3 web client consume the same endpoints available to
other systems.

## 1. Online rendering

### `POST /render`

Input:

```json
{
  "document": {
    "schemaVersion": "inkos.document/v1",
    "uuid": "...",
    "parentUuid": "...",
    "source": { "title": "..." },
    "content": { "schemaVersion": "inkos.content/v2", "id": "...", "revision": 1, "page": {} }
  },
  "profileId": "m5stack-paper-s3-portrait",
  "displayMeta": {
    "orientation": "portrait",
    "invert": false,
    "fontLevel": 0,
    "outputTuning": {
      "gamma": 0.94,
      "contrast": 1.12,
      "blackPoint": 8,
      "whitePoint": 247,
      "sharpen": 0.34,
      "photoContrast": 1.2,
      "quantization": "photo-ordered-16",
      "supersampling": 2
    }
  },
  "pageIndex": 0,
  "packageId": "optional UUID"
}
```

Response body is `image/png`. Headers include:

- `X-Ink-Sidecar`: base64url `inkos.frame-sidecar/v1` JSON;
- `X-Ink-Frame-Manifest`: base64url renderer frame manifest;
- `ETag`: frame SHA-256;
- `X-Ink-Warnings`: base64url JSON warning array.
- `X-Ink-Refresh-Hint: binary-text`: optional advisory PaperS3 fast-refresh
  classification, mirrored as `refreshHint` in the frame manifest.

`binary-text` is fail-closed. The server emits it only for the PaperS3 gray4
profile after both checks pass: the semantic document contains no image
occurrence, and the final encoded PNG uses InkOS's stable 16-gray palette with
at least 92% of pixels in the terminal black/white buckets. The remaining at
most 8% accommodates rasterized glyph edges and thin rules; a material gray
area, a different/malformed PNG, a partial-size payload, any semantic image, or
an unknown renderer gets no hint. The check inspects the encoded payload rather
than trusting `detail`, `list` or `reader`.

The hint is optional and advisory. A client that does not understand it uses
quality refresh. A supporting PaperS3 client MAY select its bounded binary fast
waveform only after normal frame length/hash/manifest validation and its own
state checks (same orientation, compatible previous frame and periodic quality
cleanup). Missing or unknown values MUST be treated as quality refresh.

Validation failures use `application/problem+json`. Existing `/api/render` remains
available for `inkos.content/v2` callers but is not the public client protocol.

`displayMeta.outputTuning` is optional, renderer-owned and currently supported
only by `eink-gray4-png-v1` PaperS3 profiles. Omission selects the profile
default; for PaperS3 that default is the value shown above. Individual
fields may be supplied without repeating the rest. `gamma > 1` lightens
midtones, `contrast` is centered on middle gray, and `blackPoint`/`whitePoint`
select the input range mapped to panel black/white. `sharpen` is a bounded
unsharp mask after SVG downsampling. `photoContrast` and ordered quantization
apply only to renderer-marked editorial-image regions, never to text, borders or
UI fills. `quantization` is either `uniform-16` or `photo-ordered-16`; both emit
the same fixed 16-entry `8,24,...248` bucket-centered gray palette instead of
an adaptive per-frame palette. These values compensate for M5GFX's final
8-bit-to-4-bit conversion so each server gray4 index reaches PaperS3 unchanged,
without a second ordered-dither pass. `supersampling` is `1` or `2`.

`displayMeta.invert` remains present for v1 wire compatibility but only `false`
is valid. Supplying `true` returns `400 INVALID_REQUEST`; the renderer has no
negative-pixel path. A custom tuning tuple is part of display variant identity
and frame-cache identity; it can never reuse bytes generated with a different
tuple.

## 2. Package catalog/runtime

```text
GET /packages
GET /packages/{packageId}/manifest
GET /packages/{packageId}/documents/{uuid}
POST /packages/{packageId}/render
GET /packages/{packageId}/frames/{variantId}/{uuid}/{pageIndex}
GET /packages/{packageId}/frames/{variantId}/{uuid}/{pageIndex}/sidecar
GET /packages/{packageId}/download
```

The PNG/sidecar returned online MUST be byte-equivalent to a generated package
artifact when the same package revision is addressed. Version 1 package URLs
resolve the latest revision in a package lineage, so every response uses a strong
ETag and revalidation caching rather than claiming the URL is immutable. A future
revision-qualified resource URL MAY use long-lived immutable caching.

Every manifest-derived `document`, packaged `frame` and `sidecar` GET MUST send
the verified manifest's strong ETag in `If-Match`. Missing preconditions return
`428 MANIFEST_PRECONDITION_REQUIRED`; if a newer revision now owns the same
`packageId`, the service returns `412 PACKAGE_REVISION_CHANGED` before looking up
the requested resource. This ordering is intentional: a UUID/frame removed by a
new revision is a revision change, not a trustworthy `404` against the old
manifest. Successful artifact responses include `X-Ink-Manifest-SHA256` so the
revision boundary is observable alongside the artifact SHA-256.

Clients must treat document, frame and sidecar reads as one transaction. After a
`412` they may bypass cache, reload the same package manifest and retry the whole
transaction once. A second `412` or any integrity failure leaves the previously
committed package/frame active; byte-length and SHA-256 checks are never relaxed.

`GET /packages` returns an explicit default instead of making clients infer it
from array order:

```json
{
  "schemaVersion": "inkos.package-catalog/v1",
  "defaultPackageId": "7f12227f-be7f-5092-a73f-6dc57e85af61",
  "defaultEntryUuid": "f67a9105-45db-5a99-af84-f07d1ba1ebce",
  "packages": []
}
```

The default is the standard PaperS3 application-home `.ink` lineage. Its entry
is a single-page, two-column semantic grid with Network Reader, RSS Reader, Old
Almanac, Image Viewer, Baidu Map, display tests, guide and clock. The archive
also contains the current six-week old-almanac grid, date details and a native
540×960 portrait calibration target. The package is rebuilt as an
`Asia/Shanghai` daily revision so “today” is
stable within a day and changes at local midnight. It carries the two base
PaperS3 orientation variants at font level 0; other online font tuples use the
package render endpoint below. Clients MUST use
`defaultPackageId` and `defaultEntryUuid`; `packages[0]` is not an identity
contract.

### `GET /time`

Returns a cache-disabled server time sample for browser clients:

```json
{
  "schemaVersion": "inkos.time/v1",
  "serverUnixMs": 1784358000123,
  "timezone": "Asia/Shanghai",
  "serverIso": "2026-07-18T15:00:00.123+08:00"
}
```

The browser estimates its offset using the request/response midpoint and then
updates a verified clock `dynamicRegion` locally. Hardware clients SHOULD use
SNTP directly; this HTTP endpoint is not a device time daemon. Failure to obtain
a sample does not invalidate the static frame or package.

### `POST /packages/{packageId}/render`

Renders one packaged semantic document synchronously for PaperS3 when the exact
direction or font level was not pre-rendered:

```json
{
  "documentUuid": "...",
  "manifestSha256": "64 lowercase hexadecimal characters",
  "displayMeta": {
    "orientation": "landscape",
    "fontLevel": 1,
    "invert": false,
    "outputTuning": { "contrast": 1.2, "photoContrast": 1.35 }
  },
  "pageIndex": 4
}
```

`manifestSha256` binds the request to the exact manifest already verified by
the client. A client MAY instead send that manifest's strong ETag in
`If-Match`. Omitting both returns `428`; if the revision-floating package
changed after the manifest read, the service returns `412` and the client must
reload the manifest.

The PaperS3 web client reloads that same package lineage and retries the same
UUID/page/display transaction at most once. It never resolves a different
catalog package during recovery, and it keeps the previous verified frame if
the refreshed revision removed the UUID, fails validation or changes again.

The response is `image/png` with `Cache-Control: no-store`. Base64url JSON is
returned in `X-Ink-Frame-Manifest`, `X-Ink-Sidecar` and `X-Ink-Warnings`.
`X-Ink-SHA256`, `X-Ink-Manifest-SHA256`, package identity, and requested/actual
page indexes are also returned. Eligible frames also return the optional
`X-Ink-Refresh-Hint: binary-text`, mirrored in the decoded frame manifest.
Pagination is recalculated for the exact display
settings; an out-of-range page is clamped to the last page. The service rebuilds
image navigation only to UUIDs already present in the verified package graph
and uses bounded process-local renderer/frame caches. It does not start a
background multi-variant job.

### `POST /apps/execute`

Executes one exact server-owned PaperS3 application. It is deliberately not a
generic URI dispatcher. The request accepts only `inkos://app/random-image` or
`inkos://app/baidu-map`, a client-generated nonce/timestamp, exact display
metadata and a page index. Random-image requests may include up to 16 ordered
device image entries:

```json
{
  "action": "inkos://app/random-image",
  "nonce": "0123456789abcdef",
  "requestedAtUnixMs": 1784352000123,
  "pageIndex": 1,
  "images": [
    { "id": "fixed", "label": "固定照片", "url": "https://images.example/photo.jpg" },
    { "id": "random", "label": "随机图片", "url": "https://picsum.photos/540/960?random=1" }
  ],
  "displayMeta": { "orientation": "portrait", "fontLevel": 0 }
}
```

Each image entry is one full-screen page. HTTPS URLs are fetched unchanged by
the server under the renderer's redirect, byte, pixel, DNS and SSRF controls.
For the exact editable default
`https://picsum.photos/540/960?random=1`, the server substitutes the client
nonce so retries and display-setting changes keep the same image. The client
reuses the nonce/timestamp while paging or changing display settings. The
service also recognizes the exact former grayscale default and retired exact
`inkos://app/random-image` row as compatibility aliases; those become the same
orientation-sized non-grayscale Picsum request. It does not rewrite any other
user-authored URL, including a custom grayscale URL.

The map action has only page zero. The server resolves its public-IP location
through Baidu's BD-09 API and renders a high-DPI `staticimage/v2` result using
`contain`. Public-IP location is approximate, not device GPS. `mapStyle` may be
`eink` (default), `balanced`, or `detail`; it remains part of request identity
for diagnostic comparisons but does not alter pixels while the map's raw-colour
mode is active. The static map keeps its required `contain` geometry and large
black location marker.
`INKOS_BAIDU_MAP_AK` is required in the server process; the service never reads
the key from client input and never returns or logs a secret-bearing upstream
URL.

Success is a no-store `image/png` with the normal frame/sidecar/warning and
SHA-256 headers plus exact `X-Ink-App-Action`, `X-Ink-App-Nonce`,
`X-Ink-App-Requested-At` and `X-Ink-App-Page-Index` echoes.
`X-Ink-App-Image-Mode` is action-specific:
`photo-papers3-slideshow-gray16-rgb-png-v3` labels Image Viewer photos, while
`diagnostic-raw-colour-png-v1` labels pixel-preserving maps. Both PNGs use
8-bit RGB/RGBA (IHDR colour type 2 or 6) and have no palette. After required
`cover` geometry, the photo path uses the slideshow algorithm: grayscale,
0.5% two-ended autocontrast, contrast 1.08, unsharp mask radius 1 / 65% /
threshold 3, and serpentine Floyd-Steinberg diffusion against the sixteen
levels `0, 17, …, 255`. The selected indices are encoded as stable centres
`8, 24, …, 248`, so the PaperS3 driver's 4×4 Bayer threshold maps each pixel to
exactly one native level instead of mixing two adjacent levels. The map path
retains only decode/orientation and required
`contain` geometry, with output pixels unchanged. PaperS3 still displays either
result through a 16-gray framebuffer; these modes are not a colour-display
claim. Standard `.ink` package PNGs stay strict indexed gray4. Invalid actions
or pages return `400`; unavailable upstreams return sanitized `502`; an
unconfigured map returns `503`.

## 3. URL content resolution

### `POST /sources/resolve`

This is the browser/device entry point for an arbitrary web page or RSS/Atom
feed. The client submits the HTTPS source URL and current display settings to
InkOS; it MUST NOT fetch, parse or render the source itself.

```json
{
  "url": "https://jandan.net/",
  "displayMeta": { "orientation": "portrait", "fontLevel": 0, "invert": false }
}
```

The endpoint accepts an absolute, credential-free HTTPS URL on the default port.
The online source resolver always creates the following internal generator
request; these fields are service policy and are not accepted from this public
request body:

```json
{
  "sourceMode": "chromium",
  "deliveryMode": "realtime",
  "maxDepth": 0,
  "maxDocuments": 1
}
```

The server selects one of two inert semantic-ingestion branches:

```text
RSS 2.0 / Atom XML -> bounded XML feed parser ┐
                                              ├-> inkos.content/v2 JSON
                                              │   -> PaperS3 ScreenProfile rendering (gray4)
                                              │   -> frame sidecars and verified .ink
Chromium with JavaScript enabled              │
  -> bounded post-render semantic DOM         │
  -> Markdown ────────────────────────────────┘
```

For RSS 2.0 and Atom the server preserves the channel description and, when
present, each entry's title, author, teaser, normalized publication date and
editorial images. Feed-provided HTML is normalized by the same inert
HTML-to-Markdown-to-semantic pipeline used after Chromium; it is never sent to
the renderer as HTML. Atom authors follow RFC 4287 metadata inheritance:
entry author first, then `source/author`, then feed author. `published` is
preferred to `updated` regardless of XML child order; RSS similarly prefers
`pubDate` to `dc:date`.

RSS body precedence is explicit rather than XML-order dependent:
`content:encoded`, then `description`, then the linked Chromium page. Atom uses
`content`, then `summary`, then the linked Chromium page. A substantive
feed-provided body becomes a bounded packaged detail without another browser
capture. A teaser-only body keeps the fast list and lets the linked Chromium
page provide the detail; the teaser remains a safe fallback if that capture
fails.

The checked-in `rss-default.v1.json` controls only semantic presentation:
`list/feed`, `detail/article|image-story`, channel/author/date/image policies
and short labels. It is parsed once through a strict schema. It cannot contain
coordinates, sizes, CSS, selectors, URLs, regexes, scripts or expressions;
screen geometry remains owned by the selected `ScreenProfile` and semantic
layout engine.

Only credential-free HTTPS item/image links survive. A legacy cleartext item or
site permalink MAY be upgraded to HTTPS only when it names the exact same host
as the already-validated HTTPS feed; cleartext links to another host, non-default
ports and credentials are still discarded. DTD/entity declarations, scripts
and stylesheets are never executed, and malformed or unsafe entries are
omitted. The feed URL itself still passes the same HTTPS, redirect, DNS, byte
and SSRF checks as an ordinary page. Reserved `inkos://collection/...` actions
are rejected by this endpoint because they are local client navigation, not
source URLs.

Atom `content@src` is not fetched as executable or unbounded side content.
When it is a safe HTTPS URL it is retained as a semantic “查看订阅正文” fallback
link, and it can supply the entry destination when no safe alternate link
exists. Unsafe, credentialed or cross-host cleartext `src` values are discarded.

When a public HTML landing page deliberately serves a bot-verification response
to server browsers, a bounded first-party provider endpoint MAY supply the same
landing semantics. The current Baidu Tieba root adapter reads only its public
hot-topic JSON endpoint and applies the ordinary HTTPS, DNS, SSRF, byte and link
validation before producing feed items. Chromium advertises the installed
browser's real version with a normal Chrome product token instead of
`HeadlessChrome`; it does not add accounts, cookies, CAPTCHA solving or stealth
patches.

The Markdown stage preserves semantic headings, paragraphs, lists, quotes,
images and HTTPS links; it does not preserve source CSS, coordinates or device
layout. Relative feed links and images honor inherited feed → entry → content
→ nested XHTML element `xml:base`, then fall back to the canonical entry URL
and feed URL, with the same narrow same-host HTTPS upgrade.
Converting Markdown to `inkos.content/v2` is deterministic and local. No LLM
call blocks the realtime pipeline. Later display combinations use the
synchronous package render endpoint instead of regenerating the source package.
The captured DOM includes final rendered image dimensions. Hidden images,
tracking pixels, small UI chrome (including icons, badges, logos and avatars up
to 64 x 64), and thin decorative separators are removed before Markdown and do
not consume semantic-image or preview limits. Large editorial and QR images are
not classified as decoration merely because of their filename or format.

An oversized rendered book/article does not raise the global 2 MiB / 20,000-node
capture limits. Before Markdown conversion, the server selects the strongest
`main` / `article` / body root, removes obvious site or Project Gutenberg
boilerplate, drops non-chapter navigation, deduplicates repeated contents
directories, and retains a contiguous prefix within a smaller realtime semantic
budget. Compact labels such as `第十卷` or `Chapter IV` become semantic headings;
the first chapter directory, safe links and editorial images stay in source
order. Tail removal happens at element boundaries, with a bounded text-prefix
fallback only for one indivisible long leaf. The capture is marked partial and
the ordinary Markdown block/text budgets still apply, so render pagination sees
usable chapters instead of a generation failure.

#### Realtime draft and archive upgrade

The foreground job publishes revision 17 as a structurally valid `.ink`, not an
incomplete ZIP. It covers only the current URL and current PaperS3 display tuple,
retains at most 16 feed items or four detail blocks, and materializes at most the
first six image-preview documents. Consequently, image-to-fullscreen navigation
in the draft is guaranteed only for those first six images. Later images remain
visible inline and render normally; the absent preview child suppresses only
their fullscreen interaction and never invalidates the draft or its on-demand
frame.

After the draft is published, the service enqueues a revision 18 archive upgrade
with `deliveryMode="archive"`, `maxDepth >= 1` and `maxDocuments >= 4`. The
archive uses the same package lineage, performs the bounded child crawl and
materializes all image previews admitted by the package limits. It runs at low
priority. With the default generator concurrency of two, background archive work
uses at most one slot and the other remains available to a foreground request.
Catalog package URLs select the highest verified revision, so a subsequent
resolve or refresh can move from revision 17 to revision 18 without changing the
package ID. Clients MUST read the authoritative manifest and MUST NOT encode
revision 17 or 18 as protocol constants.

When generation is required, the response is `202 Accepted` and `Location`
points to `statusUrl`:

```json
{
  "schemaVersion": "inkos.source-resolution/v1",
  "normalizedUrl": "https://jandan.net/",
  "cached": false,
  "expectedEntryUuid": "...",
  "expectedPackageId": "...",
  "status": "queued",
  "job": { "schemaVersion": "inkos.generator-job/v1", "jobId": "..." },
  "jobId": "...",
  "statusUrl": "/api/ink/v1/generator/jobs/...",
  "eventsUrl": "/api/ink/v1/generator/jobs/.../events"
}
```

The client polls `statusUrl`; it MAY consume `eventsUrl` as an SSE progress
stream. It activates nothing while the job is pending. Equivalent normalized
URLs with the same initial display tuple share a persistent idempotency key and
may return an existing pending job. Once a current package exists, it is reused
for every tuple because missing frames are rendered on demand.

If a fresh published package is already cached, the endpoint responds `200 OK`
immediately. Source freshness defaults to three minutes. A verified stale package
also responds `200 OK` immediately with `stale: true` and
`revalidatingJobId`; the service starts revalidation asynchronously and the
client may continue to use the returned package. A completed response identifies
the exact artifact to activate:

```json
{
  "schemaVersion": "inkos.source-resolution/v1",
  "normalizedUrl": "https://jandan.net/",
  "cached": true,
  "expectedEntryUuid": "...",
  "expectedPackageId": "...",
  "status": "complete",
  "job": null,
  "packageId": "...",
  "entryUuid": "...",
  "revision": 9,
  "title": "新鲜事",
  "manifestUrl": "/api/ink/v1/packages/.../manifest",
  "downloadUrl": "/api/ink/v1/packages/.../download"
}
```

Every successful resolution response uses `Cache-Control: no-store` and includes:

- `X-InkOS-Source-Cache: hit` for a fresh verified package or a reused
  idempotent pending job;
- `X-InkOS-Source-Cache: stale` when a verified package was returned while
  revalidation was started;
- `X-InkOS-Source-Cache: miss` when no reusable package was available;
- `Server-Timing: source_resolve;dur=<milliseconds>` for the synchronous resolve
  operation. A `202` duration does not include the asynchronous Chromium job.

After a pending job completes, its status resource supplies the published
package identity. The actual `packageId` returned by the service is authoritative
(for example, after canonical redirects); clients MUST NOT guess it, select the
first catalog package, or activate `expectedPackageId` without a completed
response. They then apply the normal manifest/document/frame/sidecar length,
SHA-256, compatibility and image-decode checks before committing the package.

## 4. Generator jobs

### `POST /generator/jobs`

Creates a persisted generation job. The endpoint is suitable for the website UI
and server-to-server integration.

```json
{
  "seedUrl": "https://zh.wikipedia.org/wiki/Nook#电子墨水屏系列",
  "title": "Nook 电子墨水屏系列",
  "sourceMode": "chromium",
  "deliveryMode": "archive",
  "maxDepth": 1,
  "maxDocuments": 8,
  "profileIds": ["m5stack-paper-s3-portrait"],
  "orientations": ["portrait"],
  "fontLevels": [-2, -1, 0, 1, 2],
  "outputTuning": { "quantization": "photo-ordered-16", "supersampling": 2 }
}
```

`invertModes` has been removed. Generator requests are strict and reject that
field instead of producing inverse variants.

`outputTuning`, when present on a generator request, is shared by its bounded
orientation/font variant matrix. It is not an additional Cartesian
dimension. Source-resolution idempotency includes the normalized tuning tuple.

Response: `202 Accepted` with `jobId`, `statusUrl`, `eventsUrl` and `createdAt`.
The service MUST apply server-side caps regardless of larger client values.

### `GET /generator/jobs/{jobId}`

Returns `status` as one of `queued`, `running`, `complete`, `failed` or
`cancelled`, and `phase` as one of `queued`, `fetching`, `extracting`,
`rendering`, `packaging` or `complete`. It also returns deterministic progress
counts and a machine-readable error when failed.

The optional `timings` object records non-negative integer milliseconds by stage.
Current Chromium jobs may include `browser_acquire_ms`, `navigate_ms`,
`dom_settle_ms`, `dom_capture_ms`, `chromium_total_ms`, `markdown_ms`,
`ingest_ms`, `transform_ms`, `render_package_ms` and `total_ms`. Consumers MUST
treat keys as additive diagnostics rather than a fixed phase-state contract.

### `GET /generator/jobs/{jobId}/events`

Optional Server-Sent Events stream. Polling the job resource remains sufficient
for conformance.

### `GET /generator/jobs/{jobId}/artifact`

Available only when complete. Returns
`application/vnd.inkos.package+zip`, a content-disposition `.ink` filename,
content length, SHA-256/ETag and package ID/revision headers.

### `DELETE /generator/jobs/{jobId}`

Requests cancellation. A job already packaging MAY finish but MUST NOT publish an
artifact after cancellation wins the state transition.

## 5. Idempotency

Generation clients SHOULD send `Idempotency-Key`. The service stores the key with
a normalized request digest. Reusing the key with identical input returns the
existing job; reusing it with different input returns `409`.

Render requests need no idempotency key. Package render requests must carry the
verified manifest SHA-256 or its strong `If-Match` ETag.

## 6. Problem responses

```json
{
  "type": "https://inkos.dev/problems/source-unreachable",
  "title": "Source page could not be fetched",
  "status": 422,
  "code": "SOURCE_UNREACHABLE",
  "detail": "The source returned HTTP 404",
  "instance": "/api/ink/v1/generator/jobs/...",
  "retryable": false
}
```

Public codes include `INVALID_REQUEST`, `SOURCE_BLOCKED`, `SOURCE_UNREACHABLE`,
`SOURCE_TOO_LARGE`, `EXTRACTION_EMPTY`, `RENDER_FAILED`, `PACKAGE_INVALID`,
`JOB_NOT_FOUND`, `JOB_NOT_READY`, `IDEMPOTENCY_CONFLICT`,
`INVALID_APP_REQUEST`, `APP_NOT_CONFIGURED`, `APP_UPSTREAM_UNAVAILABLE`,
`APP_UPSTREAM_INVALID`, `APP_LOCATION_UNAVAILABLE`, `APP_IMAGE_UNAVAILABLE`
`APP_EXECUTION_FAILED` and `INTERNAL_ERROR`.

## 7. Service security

- `/sources/resolve` accepts only absolute, credential-free HTTPS URLs on the
  default port. Lower-level generator jobs still apply their configured source
  policy independently.
- DNS and every redirect are revalidated; private, loopback, link-local and cloud
  metadata destinations are rejected. Chromium applies the same public-HTTPS
  validation to subresources, not only to the main document.
- `198.18.0.0/15` is the intentional exception for trusted local
  Clash/Surge-style Fake-IP/TUN egress. Other reserved/private ranges remain
  blocked, and HTTPS hostname authentication is still required.
- `/apps/execute` compares the complete action string against a two-value
  allowlist. Image collection URLs remain subject to public HTTPS/DNS/redirect,
  byte and decode limits; the endpoint cannot proxy arbitrary schemes or return
  upstream response bodies.
- Map credentials are read only from server process configuration. Errors and
  observability MUST redact credentials and secret-bearing upstream URLs.
- Request time, redirects, response bytes, parsed nodes, depth, page count, image
  count, render variants and output bytes have independent hard caps.
- Chromium executes source JavaScript inside a fresh non-persistent browser
  context. The browser process is shared to avoid cold-start latency; downloads,
  service workers, WebSockets, popups and non-required resource types are
  disabled or closed, and the context is destroyed after capture. Only the
  bounded, sanitized post-render DOM crosses into Markdown conversion.
- Navigation waits for `DOMContentLoaded`, not `networkidle`, then performs a
  short DOM-stability check and at most two bounded lazy-load scrolls. The full
  capture operation has a 10-second hard deadline.
- A production deployment SHOULD use a durable queue/object store, per-tenant quotas,
  rate limiting and artifact retention policy. The local development adapter MAY
  use the filesystem while preserving the same job API.

## 8. Runtime configuration

| Variable | Default and bounds | Effect |
| --- | --- | --- |
| `INKOS_CHROMIUM_EXECUTABLE_PATH` | auto-detected | Explicit Chromium/Chrome executable path. An explicitly configured missing path fails capture. |
| `INKOS_CHROMIUM_USER_AGENT` | normal Chrome token derived from the installed Chromium version | Optional explicit browser user agent; CR/LF and values longer than 512 characters are rejected in favor of the derived default. |
| `INKOS_SOURCE_CACHE_TTL_MS` | `180000`; 10000 to 86400000 | Freshness window for a verified source package. Out-of-range values fall back to the default. |
| `INKOS_GENERATOR_CONCURRENCY` | `2`; 1 to 8 | Concurrent generator jobs. Foreground jobs drain before low-priority archive jobs. |
| `INKOS_BAIDU_MAP_AK` | unset | Server-only Baidu Web Service key for the map app. Required only for `inkos://app/baidu-map`; never expose it to clients or logs. |
| `INKOS_PAPERS3_HOME_ARCHIVE` | unset | Absolute path to the release-pinned PaperS3 `home.ink`. If configured, catalog publication requires its exact SHA, derives the release date from its validated manifest, and preserves that identity across midnight until a newer paired firmware archive is deployed. |

July 2026 development-machine sample using Jandan: Chromium capture through
Markdown and `inkos.content/v2` conversion took about 3.0 seconds. The realtime
realtime draft `.ink` completed in 3.34 seconds with seven documents; its entry
document rendered to three pages and the archive was about 312 KB. This
measurement is diagnostic data, not a latency SLA.

Cold Project Gutenberg `pg24230-images.html` validation on the same machine
completed the then-current foreground package in 10.3 seconds (51 opening pages,
about 2.70 MB). Its background archive later expanded it to 608
pages while the foreground queue remained available.

## 9. Versioning

Breaking request/response semantics get a new path major (`/v2`). Additive response
fields are allowed in v1. Artifact schemas are versioned independently and declared
inside every response/package.
