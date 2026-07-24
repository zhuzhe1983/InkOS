# InkOS client protocol v1

Status: Draft for implementation and public review  
Protocol identifier: `inkos.client/v1`  
Package format: [`inkos.package/v1`](./ink-package-format.md)  
Service API: [`inkos.service/v1`](./service-api.md)

This document is the normative, language-neutral contract for implementing an
InkOS client. A conforming client can be a browser, an ESP32 device, a phone, a
desktop application or another e-paper product. It does not need the InkOS
renderer source code.

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT,
RECOMMENDED, MAY and OPTIONAL are to be interpreted as described by RFC 2119
and RFC 8174 when they appear in uppercase.

## 1. Design boundary

InkOS separates three kinds of data:

1. **Semantic content** says what exists: a list, detail, reader or image page;
   text; ordinary images; content navigation; links to document UUIDs or HTTPS
   sources; and the exact reserved client actions defined below. It
   MUST NOT contain pixel coordinates, font names, screen
   sizes or device-specific branches.
2. **Screen/profile input** says what the target can display: resolution,
   active physical panel size, rotation, palette, safe area, refresh alignment
   and rendering strategy.
3. **Rendered artifacts** contain a PNG and a frame sidecar. Only this output
   layer may contain pixel hitboxes and pagination.

A client is deliberately simple. It selects an exact rendered variant, displays
one page image, executes the navigation state machine, and verifies content
before activation. It MUST NOT reinterpret semantic layout.

QR codes, barcodes and tickets are ordinary images. Dates, times, status and
metrics are ordinary text. No client may depend on special QR, calendar, clock
or metric primitives.

### 1.1 Physical rendering scale

The trusted profile's `physicalSizeMm` MUST describe the active pixel area in
the panel's native orientation, not the product enclosure. A renderer derives
horizontal and vertical PPI from `nativeSize` and `physicalSizeMm`; supported
square-pixel panels MUST reject materially inconsistent axes.

Layout values are physical design policy, not content. The reference InkOS
renderer converts 160-PPI design units to native pixels before line wrapping and
pagination, and uses that conversion for typography, strokes and dividers,
spacing and padding, corner radii, icons and image chrome. A touch-enabled
profile also expands and clips renderer-owned interaction bounds to at least
7 mm in each axis. A request's relative `fontLevel` is applied after density
conversion and does not shrink these non-type primitives.

Orientation changes the logical size, rotation, safe-area edges and refresh
axes. It MUST NOT rotate or rewrite `nativeSize` or `physicalSizeMm`, so the
physical scale remains stable. None of this metadata may be copied into
`inkos.content/v2`; semantic JSON remains coordinate- and device-free.

## 2. Conformance classes

Implementations declare one or more classes:

| Class | Required behavior |
| --- | --- |
| `render-client` | Display one server-rendered frame and execute its sidecar. |
| `package-client` | Verify, install and execute a local `.ink` package. |
| `online-client` | Resolve manifests/documents/frames through `inkos.service/v1`. |
| `generator-service` | Safely ingest a web source and build a verified `.ink`. |

Every client MUST publish:

- a semantic client version such as `1.0.0`;
- supported package format major versions;
- supported capability identifiers;
- supported screen profile IDs and versions;
- maximum archive and expanded sizes;
- supported image codecs and pixel formats.

Unknown REQUIRED capabilities make a package incompatible. Unknown optional
metadata MAY be ignored only where its schema permits additional fields.

## 3. Identity and information architecture

### 3.1 UUIDs

Every packaged document has a canonical RFC 9562 UUID encoded as a lowercase
hyphenated string. Source-derived generators SHOULD use UUID v5 with a stable
namespace and normalized canonical source URL so rebuilding the same source
preserves navigation identity.

The packaged document envelope is:

```json
{
  "schemaVersion": "inkos.document/v1",
  "uuid": "8b3d9199-814d-5f3f-86b8-c960fc14a2df",
  "parentUuid": "f9bf6ed8-47e1-5f3f-95de-5562a8f28bd2",
  "source": {
    "url": "https://example.org/article",
    "title": "Article",
    "retrievedAt": "2026-07-16T14:00:00+08:00"
  },
  "content": {
    "schemaVersion": "inkos.content/v2",
    "id": "8b3d9199-814d-5f3f-86b8-c960fc14a2df",
    "revision": 1,
    "locale": "en",
    "page": { "kind": "reader", "content": [] }
  }
}
```

`content.id` MUST equal `uuid` inside a package. The existing field name
`documentId` in an `inkos.content/v2` link carries the target UUID string.
Optional page `navigation` is an ordered list of ordinary semantic links (for
example a site's main menu). It is independent of feed/crawl quotas and has no
coordinates; the renderer decides its device-specific placement and hitboxes.

### 3.2 Parent graph

- A package has exactly one `entryUuid`.
- The entry document MUST NOT have `parentUuid`.
- Every other bundled document MUST have exactly one `parentUuid`.
- The parent MUST exist in the same package for an offline-complete package.
- Parent relations MUST be acyclic and every chain MUST terminate at `entryUuid`.
- A link MAY target any bundled UUID. A link does not change canonical parentage.

`parentUuid` is the information architecture, not browser history. A client MAY
keep a short visit stack to restore a parent's prior page, but it MUST fall back
to the canonical parent at page zero when no matching visit is known.

## 4. Runtime state

The minimum durable state is:

```text
activePackageId
activeDocumentUuid
pageIndex
selectedProfileId
orientation
fontLevel       # -2, -1, 0, +1, +2
offline         # false or true
```

Visit history is transient. Inside one package it contains
`(documentUuid, pageIndex)` pairs; an online client that follows a lazy source
link retains `(packageId, documentUuid, pageIndex, sourceUrl?)` so parent
navigation can atomically restore the previous verified package and page.
Clients SHOULD persist the active document/page and settings after a successful
frame display. They MUST NOT persist a destination before the frame has passed
validation and is displayable.

## 5. Frame sidecar

Each PNG page has one JSON sidecar identified by
`inkos.frame-sidecar/v1`. It contains:

- package, document and optional parent UUID;
- exact display variant ID;
- `pageIndex` and `pageCount`;
- PNG path and SHA-256;
- logical width and height;
- zero or more renderer-generated interactions;
- optional renderer-owned local `dynamicRegions`.

An interaction is:

```json
{
  "id": "page.items[2].link",
  "contentPath": "page.items[2].link",
  "label": "阅读详情",
  "bounds": { "x": 28, "y": 402, "width": 484, "height": 116 },
  "targetUuid": "8b3d9199-814d-5f3f-86b8-c960fc14a2df"
}
```

When a semantic link names an HTTPS page that is not bundled, the interaction
also carries `targetUrl`. Its `targetUuid` is the current packaged document as a
safe v1 fallback. An online client gives `targetUrl` only to
`POST /sources/resolve`; it MUST NOT fetch the target site itself. It stages and
verifies the returned exact package before switching. An offline-only client
keeps the current frame.

A packaged RSS/Atom item may instead carry `fallbackUrl` alongside its real
packaged-detail `targetUuid`. `fallbackUrl` and `targetUrl` are mutually
exclusive. The recovery URL MUST be credential-free HTTPS on the default HTTPS
port. A supporting client MUST try `targetUuid` first and MUST NOT contact the
source while that packaged document can be verified and activated. On a
revision/precondition change it MUST fetch the replacement manifest and retry
the complete manifest-bound transaction before using `fallbackUrl`. A client
MAY also use `fallbackUrl` after a small bounded number of fresh-manifest
retries still ends in a missing UUID, lineage mismatch, or artifact-integrity
failure. The currently active frame remains committed until the replacement
source package is fully verified and painted. Offline clients and clients
without this optional recovery keep the current verified frame.

New packages MAY use exactly these client-only collection actions:

- `inkos://collection/rss`
- `inkos://collection/website`

They open the corresponding list stored by the device; they are not network
URLs. A client MUST compare the complete string against this allowlist, dispatch
it locally, and MUST NOT pass it to `/sources/resolve`, a browser navigation API
or a generic custom-scheme handler. A package or sidecar containing any other
`inkos:` URI, including a suffix, query, fragment or case variant, is invalid.
The fallback `targetUuid` remains the current packaged document so a client
without collection support safely keeps the current frame.

For backward compatibility, a client MAY accept the exact legacy action
`inkos://collection/other`, but it MUST dispatch it to the same stored
`websites` list as `inkos://collection/website`. Producers MUST NOT emit the
legacy alias in a new package. No generic `inkos://collection/*` namespace is
created by this exception.

Two additional exact actions are server-owned applications:

- `inkos://app/random-image`
- `inkos://app/baidu-map`

The client MUST dispatch these only to `POST /api/ink/v1/apps/execute`. It MUST
NOT pass them to `/sources/resolve`, navigate a browser to them, or fetch Picsum,
an image host, Baidu, or any other upstream itself. Suffixes, query strings,
fragments and case variants remain invalid. Each user entry generates a fresh
lowercase nonce and millisecond timestamp; orientation, font and page changes
reuse that identity so a random image does not change accidentally.

One exact action is device-local:

- `inkos://device/settings`

The client MUST open its native/browser settings surface directly. It MUST NOT
send this action to `/sources/resolve`, `/apps/execute`, or a browser navigation
API. New PaperS3 home packages expose it as the top-right settings gear.

Bounds use half-open logical coordinates:
`x <= point.x < x + width` and `y <= point.y < y + height`. They MUST fit
inside the sidecar logical size. Hardware touch coordinates and browser CSS
coordinates MUST be normalized into this logical coordinate system before hit
testing.

When hitboxes overlap, the client MUST choose the smallest area. A tie is broken
by sidecar array order. This lets an image link override a containing card while
remaining deterministic.

A clock `dynamicRegion` contains a unique ID, `HH:mm:ss`/`Asia/Shanghai`,
`refreshMs`, `fullRefreshEvery`, exact logical bounds and a restricted
monospace black/white text style. It MUST fit inside the logical screen and MUST
NOT overlap an interaction. The paired PNG is always complete and contains a
static fallback. Unsupported clients ignore the region; they do not reject an
otherwise compatible package or attempt to infer a new layout.

### 5.1 Capability-gated source JPEG

An `.ink` image page may pair its normal gray4 PNG with a `sourceImage` object
in both the manifest page and frame sidecar:

```json
{
  "path": "sources/8b3d9199-814d-5f3f-86b8-c960fc14a2df/0000.jpg",
  "bytes": 98139,
  "sha256": "c51e2a15d5765f152f07054bf1cc82629730702cc9f644bd3a26fca507e3235b",
  "mediaType": "image/jpeg",
  "pixelSize": { "width": 540, "height": 960 },
  "fit": "contain"
}
```

This requires `frame.source-image-jpeg-v1`. A conforming implementation accepts
only 8-bit baseline sequential SOF0 JPEG with one or three components, verifies
the independently declared bytes/hash/SOF dimensions, and verifies that the
sidecar object exactly equals the manifest object. The ordinary `imagePath` and
`imageSha256` continue to identify a complete gray4 PNG fallback.

A client declaring this capability MUST prefer the JPEG, decode it without a
source-specific tone curve, sharpening, dithering or grayscale quantization,
then preserve its aspect ratio and center it on opaque white using `contain`.
The final RGB-to-panel conversion remains the display driver's responsibility.
It MUST treat JPEG failure as package failure, not silently display the fallback
and report source-image success. A client without the capability rejects the
package at compatibility checking because the capability is required.

The source bytes may be losslessly rewritten from progressive to baseline JPEG
entropy coding, but their decoded pixels MUST be unchanged. The generator MUST
NOT resize or otherwise visually preprocess the source JPEG. This makes the
source-image path suitable for comparing device-side image conversion against
the independently rendered PNG path.

## 6. Gesture and navigation state machine

### 6.1 Recognizer

A touch client SHOULD use these interoperable defaults:

- swipe travel threshold: `max(48 logical px, 8% of the shorter edge)`;
- dominant axis ratio: at least `1.25`;
- tap movement tolerance: at most `16 logical px`;
- right swipe: reserved and currently a no-op.

Visible controls and keyboard alternatives are REQUIRED in the normal browser
simulator. A user-requested viewport-only/kiosk mode MAY hide all chrome and
use gestures plus renderer hitboxes; its hitboxes remain keyboard-focusable.
Recommended keys are Left/Backspace for parent, PageDown/ArrowUp for next page,
and PageUp/ArrowDown for previous page/parent-at-start.

### 6.2 Normative transitions

| Input | Precondition | Result |
| --- | --- | --- |
| left swipe | parent exists | open canonical parent; restore its visited page when known, else page 0 |
| left swipe | root | no state change; report `ROOT` |
| up swipe | `pageIndex + 1 < pageCount` | increment page index |
| up swipe | final page and a previous visit or parent exists | return to the previous visit; otherwise open the canonical parent |
| up swipe | final page at root with no previous visit | no state change; report `END` |
| down swipe | `pageIndex > 0` | decrement page index |
| down swipe | page 0 and parent exists | open parent using the same restoration rule |
| down swipe | page 0 at root | no state change; report `ROOT` |
| tap | point hits interaction | push current visit, open target UUID at page 0 |
| tap | no hit | no state change; report `NO_HIT` |

“Previous level” is the most recent successfully activated visit in the
client navigation stack. If that stack is empty, the active sidecar's
`parentUuid` is the fallback. A failed return MUST retain both the current
frame and the unconsumed history entry.

A client MUST reject a sidecar whose document UUID or page index does not match
the active state. This prevents late network responses from navigating the wrong
page.

### 6.3 Loading and commit

For every state change:

1. Resolve an exact display variant from one verified manifest.
2. Online: bind the document, sidecar and image GETs to that manifest's strong
   ETag using `If-Match` and bypass intermediary caches.
3. Load the document, sidecar and image as one transaction.
4. Verify schema, declared byte lengths and SHA-256.
5. Decode the image.
6. Display/refresh successfully.
7. Atomically commit the new navigation state.

If any step fails, the previous frame and state remain active. A browser SHOULD
show a retry affordance; an e-paper device SHOULD preserve the retained image.

## 7. Display settings

`fontLevel` is a render parameter, not a client-side decoration. Changing it
selects a different exact pre-rendered variant offline or calls the online
renderer. The client MUST NOT stretch text or otherwise pretend an unavailable
variant exists on hardware. `displayMeta.invert` remains in v1 payloads only as
a compatibility placeholder and MUST be `false`; clients MUST reject inverse
packages/frames and MUST NOT expose an inverse setting.

`displayMeta.outputTuning` is an optional server-raster parameter object for
`gamma`, `contrast`, `blackPoint`, `whitePoint`, `sharpen`, `photoContrast`,
`quantization` and `supersampling`. It is currently accepted only for gray4
PaperS3 rendering; omission selects the profile default. Clients MUST send only
validated fields and bounds from [the service API](./service-api.md#1-online-rendering)
and MUST NOT reinterpret these controls as device-side image filters.

Offline behavior:

- If the exact variant exists, activate it at the same UUID and clamp the page
  index to the new `pageCount - 1` only when necessary.
- If it is absent, keep the current setting/frame and report
  `VARIANT_UNAVAILABLE`; do not silently substitute another font value.

Online behavior requests the missing variant with
`POST /packages/{packageId}/render`, verifies the returned PNG/frame/sidecar and
then activates it. The request MUST bind to the exact verified manifest using
`manifestSha256` or `If-Match`; `412` means the client must reload the manifest
before retrying. The server recalculates pagination and may clamp the requested
page, so the returned frame/sidecar page index is authoritative. Orientation is
also part of a variant even if a device exposes only one orientation in its UI.

An on-demand PaperS3 response may contain `X-Ink-Refresh-Hint: binary-text` and
the same optional `refreshHint` in its decoded `inkos.frame/v2` manifest. This
does not mean that every `detail`, `list` or `reader` page is text-only: the
server derives it from semantic image absence plus the final stable-gray4 PNG
histogram. A missing hint is accepted but MUST map to quality refresh; an
unknown/non-string manifest value or a header/manifest mismatch MUST reject the
dynamic frame transaction. A supporting hardware client may use a binary fast
waveform only after all ordinary payload checks, a local decoded-pixel check and
local transition checks pass. Image/map frames, orientation changes, first
presentation and periodic cleanup remain quality-refresh cases. Legacy packed
`.ink` frames that predate the field may retain a separately identified local
heuristic for compatibility. Browser clients may safely ignore the hint.

PaperS3 clients default to manual portrait. `auto` orientation begins following
IMU/browser sensor changes only after the user selects it; an initial sensor
sample MUST NOT silently turn the default frame sideways. The hidden settings
entry is a continuous five-second press inside the top 20% of the logical
screen. Releasing, leaving or moving outside tap tolerance cancels it. Settings
are applied as one verified render transaction and persisted only after success.

A client MAY recover from `412 PACKAGE_REVISION_CHANGED` automatically once: it
re-fetches the manifest for the same `packageId` with cache bypass, repeats all
manifest/compatibility checks, and stages the same UUID/page/display request
against the new manifest. It MUST NOT consult the catalog or substitute another
package. The old package/frame remains active until the refreshed target has
passed document, frame, sidecar, hash and image-decode validation. A missing UUID,
invalid candidate or second `412` ends the attempt without changing active state.

`offline=true` is a strict content network policy: after activation, navigation
and settings MUST resolve only verified local artifacts. Telemetry MAY be queued
but MUST NOT block reading. `offline=false` uses the online service and MAY fall
back to an already verified local artifact while clearly reporting the source.

### 7.1 Local clock regions

After a clock-bearing frame is committed, a browser SHOULD sample `GET /time`
and estimate the server offset from the request/response midpoint. If that fails,
it MAY use local browser time without failing the page. A PaperS3 device SHOULD
use SNTP directly after Wi-Fi association. Both update only the verified region,
align updates to `refreshMs`, stop on page change/settings/touch priority, and
use `fullRefreshEvery` only when the device waveform can clean the region without
leaving it visibly in an intermediate state. A PaperS3 client MAY defer that
cleanup until the next full-page transition because its quality waveform is too
slow for a one-second clock. They MUST NOT reflow surrounding content or treat
the archive as executable code.

## 8. Online mode

Online clients use the versioned endpoints in [service-api.md](./service-api.md).
They SHOULD use `If-None-Match` only to revalidate the revision-floating manifest.
Every document, packaged frame and sidecar selected from that manifest MUST carry
its strong ETag in `If-Match`; missing bindings fail with `428`, and a changed
lineage fails with `412 PACKAGE_REVISION_CHANGED` before resource lookup. Clients
verify response hashes and cache only a fully verified document/page transaction.
A successful HTTP status alone is not proof that a frame is usable.

On `412`, a client MAY refetch the same package manifest with cache bypass and
retry the same UUID/page/display transaction once from the document read onward.
It MUST discard any document/frame/sidecar bytes produced by the failed attempt,
MUST retain the previous online package until the replacement frame decodes, and
MUST surface a second `412`. A length or SHA mismatch remains an integrity error;
it is never accepted as a revision-recovery shortcut.

The online renderer returns the same sidecar model used by an `.ink` package.
This is a core interoperability requirement: navigation behavior MUST not change
when switching between server and local package sources.

### 8.1 URL-driven content

An online client MAY accept a web URL as a content source, but it MUST send only
that URL and its current `displayMeta` in
`POST /api/ink/v1/sources/resolve`. The client MUST NOT fetch the
target page, follow its links, parse its HTML, proxy its images or derive
semantic content locally. Those operations belong to the server security and
rendering boundary:

```text
HTTPS source URL
      -> server-side Chromium executes JavaScript
      -> bounded post-render semantic DOM
      -> Markdown
      -> inkos.content/v2 semantic JSON
      -> first requested PaperS3 16-level gray rendering
      -> verified versioned .ink package cache
      -> later display tuples rendered on demand
      -> verified client activation
```

Markdown is a server-side intermediate form. It is not a package format and a
client MUST NOT render it or infer visual layout from source HTML/CSS. Only
`inkos.content/v2`, the trusted screen profile and the renderer determine the
frame. No source script, DOM or Markdown is delivered to or executed by the
client.

The server filters hidden and small decorative source images before semantic
JSON generation, using Chromium's rendered dimensions plus accessibility and UI
semantics. Such source chrome is therefore absent from the package and requires
no client heuristic. Clients MUST treat every image that remains in verified
`inkos.content/v2` as content.

The client handles source resolution as follows:

1. Submit `{ "url": "https://example.org/", "displayMeta": { ... } }` to
   `/sources/resolve`. The server's realtime request uses Chromium,
   `maxDepth=0` and `maxDocuments=1`; only the current URL and first display tuple
   are in the foreground critical path. This endpoint never requests the full
   display Cartesian product.
2. For `202 Accepted`, retain the current frame and use the returned `job`,
   `jobId`, `statusUrl` and optional `eventsUrl` to observe progress. Polling
   `statusUrl` is sufficient; SSE is optional.
3. On `failed` or `cancelled`, keep the current package/frame active and report
   the server error.
4. On completion or an immediate cached `200 OK`, take the authoritative
   `packageId` from the completed service response/job. Do not guess from
   `expectedPackageId` and do not select an unrelated first catalog entry.
5. Resolve that exact package manifest, document, sidecar and frame; retain the
   manifest SHA-256 for on-demand rendering; verify
   compatibility, declared byte lengths and SHA-256 values; decode the frame;
   then atomically activate it under the loading-and-commit rules in section 6.3.

The current service publishes a valid realtime draft at revision 17, capped at
16 feed items or four detail blocks and six image-preview documents. It then builds
a revision 18 archive with a deeper bounded crawl and full bounded image-preview
expansion at low priority. A draft therefore guarantees image-fullscreen taps
only for its first six images; other images remain inline without a fullscreen
target, and the archive supplies all admitted previews. On a
later resolve or refresh, a client may receive the higher verified revision for
the same package ID. These numbers are service revision policy, not protocol
constants: clients MUST accept the authoritative package revision and MUST NOT
delay first-frame activation waiting for the archive upgrade.

A fresh verified source package returns synchronously. When the service marks a
response `stale: true`, it has returned the old verified package immediately and
started asynchronous revalidation; the client MAY activate that package under
the same verification rules. `X-InkOS-Source-Cache` (`hit`, `stale`, or `miss`)
is diagnostic only and never replaces package validation.

The PaperS3 browser client supports the source as a query parameter, including
in its viewport-only mode:

```text
/papers3-client?fullscreen=1&url=https%3A%2F%2Fjandan.net%2F
```

The query value MUST be percent-encoded. This is especially important for source
URLs containing `&` or `#`, which would otherwise be interpreted as part of the
outer client URL rather than the source URL. Receiving a query value never
changes the trust boundary: the browser still sends it to InkOS and never
requests the source site directly.

The browser keeps a copyable exact location in the address bar:

```text
/papers3-client?fullscreen=1&url=<encoded-source>&package=<package-uuid>&uuid=<document-uuid>&page=0
```

`package`, `uuid` and `page` identify the exact package lineage, document and
page. A recipient stages and verifies that exact location; a missing/mismatched
UUID is an error and MUST NOT fall back to the first catalog item. The `url`
parameter may be omitted when `package` is present.

### 8.2 Server-owned app actions

`POST /api/ink/v1/apps/execute` accepts only the two exact actions above. The
random-image action may also carry the device's ordered persistent `images`
collection (at most 16 entries) and a zero-based `pageIndex`. Each entry is an
HTTPS image URL, and each URL is one full-screen page; up/down gestures move
through the collection. The editable default is
`https://picsum.photos/540/960?random=1`. The server replaces only that exact
default's random value with the request nonce, so page/settings retries keep
the same subject. `inkos://app/random-image` remains only the client action
that opens the viewer; new clients MUST NOT store it as an image collection
URL. For upgrade compatibility the service still accepts the retired action
alias and exact former grayscale default
`https://picsum.photos/540/960?grayscale&random=1`; those legacy values are
also converted to a nonce-sized non-grayscale request. Other user-authored
URLs, including custom grayscale URLs, remain unchanged.

The map action has one page. The server obtains a BD-09 location from the
requesting server's public IP and requests a matching Baidu static map. Its
credential is server configuration and MUST NOT appear in a package, request,
device setting, browser state, log, response body or upstream URL exposed to a
client.

The response declares its concrete processing in `X-Ink-App-Image-Mode`.
Image Viewer photos use
`photo-papers3-slideshow-gray16-rgb-png-v3`: after `cover` geometry, the server
matches the proven PaperS3 slideshow preparation: grayscale, 0.5% cutoff at
both autocontrast ends, contrast 1.08, unsharp mask radius 1 / 65% / threshold
3, then serpentine Floyd-Steinberg diffusion against the sixteen mathematical
levels `0, 17, …, 255`. It encodes the selected indices as stable RGB centres
`8, 24, …, 248`. Each value therefore maps to one native PaperS3 level at every
driver Bayer position rather than being spatially mixed with an adjacent level.
Maps use
`diagnostic-raw-colour-png-v1`: after `contain` geometry, their decoded RGB
pixels remain unchanged. Both no-store PNGs have an 8-bit RGB or RGBA IHDR
(colour type 2 or 6) and no `PLTE`; the photo's RGB bytes contain only stable
native-gray centres, while map RGB remains unmodified. PaperS3 still converts
decoded RGB to its physical 16 gray levels, and ordinary `.ink` package frames
remain strict indexed gray4. Before activation the client verifies the echoed
action/nonce/timestamp/page, declared length, SHA-256/ETag, frame manifest,
sidecar, exact PaperS3 variant, pagination, PNG geometry and the
action-appropriate image mode. A failed request or decode leaves the previous
frame and app identity active. The native PaperS3 client maps only the exact
photo mode to its strongly typed `PaperS3PhotoGray16` display profile, which
uses a high-contrast white clear, full 16-gray quality body, and black/white
endpoint reinforcement. The exact map mode remains on generic quality refresh.
Clients MUST NOT infer the photo profile from `contentType: "image"` because
maps and ordinary package images share that semantic type.

### 8.3 Default application home

A client with no explicit URL/package/document request loads the catalog's
declared `defaultPackageId` and `defaultEntryUuid`; it MUST NOT infer the home
package from list order. The InkOS PaperS3 browser client downloads that package's
`.ink` artifact, runs the normal archive integrity checks, and installs it in the
offline slot as its no-parameter fallback. The same built-in archive is offered
as an explicit Demo beside the local-file picker. An explicit URL or package deep
link takes precedence and MUST NOT silently fall back to the home if validation
fails.

The InkOS PaperS3 default home is itself a normal `inkos.package/v1` archive: the
application grid, browser site list, month calendar and date almanac pages are
ordinary packaged documents connected by UUID links and canonical parents. A
client MUST NOT add a private “home screen” renderer or special app-navigation
opcode.

Following a home-package `targetUrl`, including one reached from the offline
fallback, uses the server-owned URL flow in section 8.1 and pushes the current
source mode plus document/page visit. Returning restores the verified offline
home frame without downloading the target website in the client. A package-only
share/deep link MUST omit any URL left in an input field or previous visit;
otherwise the receiver could resolve one source while asserting another package
identity.

The current catalog home declares the portrait and landscape base tuples at
font level 0. It intentionally does not enumerate all font combinations. Online
clients use the manifest-bound package renderer for any absent tuple. Offline
clients keep the strict `VARIANT_UNAVAILABLE`
behavior from section 7.

In `fullscreen=1`, PaperS3 displays only the rendered frame and transparent
hitboxes. The first user gesture may request the browser Fullscreen API with
navigation UI hidden. An installed PWA can launch without browser chrome;
installation/service workers require a secure context (HTTPS, except browser
localhost exemptions).

## 9. Content OTA

In this protocol “content OTA” means installing a `.ink` data package. It is not
firmware OTA and MUST NOT execute package-provided code.

Clients implement two logical slots:

```text
active slot  -> currently trusted package
staging slot -> incomplete or newly downloaded package
```

Installation sequence:

1. Download/copy to staging using a temporary filename.
2. Enforce compressed and expanded size limits.
3. Validate normalized archive paths and reject duplicate entries.
4. Parse manifest and check format/client/capability/profile compatibility.
5. Verify every declared length and SHA-256, including optional source images.
6. Validate UUID uniqueness, parent graph, interaction targets and exact
   manifest/sidecar source-image equality.
7. Validate all PNG dimensions and any baseline JPEG SOF dimensions/profile.
8. Decode the preferred entry artifact for the current settings.
9. Flush staging data, then atomically switch the active pointer.
10. Keep the previous slot until the new entry frame displays successfully.

Power loss or validation failure leaves the prior active package intact. Clients
SHOULD expose package ID, revision, source and verification result in diagnostics.

## 10. Errors

Shared symbolic errors:

| Code | Meaning |
| --- | --- |
| `ROOT` | Parent navigation requested at package root. |
| `END` | Next page requested at the final page. |
| `NO_HIT` | Tap did not hit an interaction. |
| `STALE_FRAME` | Sidecar does not match active navigation state. |
| `UUID_NOT_FOUND` | Requested target is unavailable. |
| `VARIANT_UNAVAILABLE` | Exact display setting/profile variant is absent. |
| `PACKAGE_INCOMPATIBLE` | Version, capability or profile check failed. |
| `PACKAGE_CORRUPT` | Schema, size, hash, path or graph validation failed. |
| `SOURCE_OFFLINE` | Network use was requested while strict offline mode is active. |
| `RENDER_FAILED` | Online rendering did not produce a verified frame. |

No-op navigation (`ROOT`, `END`, `NO_HIT`) is not a fatal error. Devices MAY use
a small visual/haptic cue, but e-paper clients SHOULD avoid a full refresh just
to report a no-op.

## 11. Security and privacy

- `.ink` v1 is data-only. Clients MUST ignore and SHOULD reject executable files,
  scripts, HTML event handlers and undeclared archive entries.
- Archive paths MUST be normalized relative UTF-8 paths with no `..`, `.`, empty
  segments, backslashes, NULs or absolute prefixes.
- Clients MUST enforce compressed file count, compressed size, expanded size and
  individual image decode limits before activation.
- Generators MUST defend against SSRF, validate every redirect and Chromium
  subresource, reject private or link-local destinations, cap response/DOM/output
  bytes and set hard timeouts.
- This deployment accepts `198.18.0.0/15` as a controlled local proxy/TUN
  Fake-IP egress range; it does not relax loopback, RFC1918, link-local, CGNAT or
  IPv6 ULA rejection.
- A generator MAY execute source JavaScript only inside its server-side capture
  boundary. The current service shares a Chromium process for latency but uses a
  fresh non-persistent context for each request, blocks service workers,
  downloads, WebSockets and popups, waits for `DOMContentLoaded` plus a short
  stability window (never `networkidle`), performs at most two bounded scrolls,
  and enforces a 10-second capture deadline. Only a bounded sanitized rendered
  DOM is converted to Markdown and then semantic JSON. Clients MUST NOT execute
  any of those source scripts.
- Packages SHOULD record source URL, retrieval time and content license. Client
  authors remain responsible for license/attribution presentation.

## 12. Conformance fixtures

The repository's `server/lib/ink/*.test.ts` fixtures are the initial executable
test vectors. Before a public v1 release, fixtures MUST be exported as plain JSON
and binary `.ink` files so any language can run the same cases without TypeScript.

At minimum a client test suite MUST cover:

- every row in the navigation table;
- stale sidecar rejection;
- overlapping and boundary hitboxes;
- parent history restore and canonical fallback;
- exact variant selection and unavailable-variant behavior;
- corrupted size/hash, unsafe path, duplicate path and undeclared file rejection;
- missing UUID, parent cycle and dangling interaction rejection;
- incompatible format, old client, missing capability and unsupported profile;
- source JPEG without its capability, non-image source attachment, progressive
  or unsupported JPEG, source size/hash/dimension mismatch, and unequal
  manifest/sidecar source metadata;
- interrupted staging install preserving the previous active package.

## 13. Extension policy

Backward-compatible additions use new optional fields or capability identifiers.
A breaking archive or state-machine change increments the schema major version.
Clients MUST NOT infer behavior from a field they do not understand. Experimental
capabilities use an `x-<vendor>.` prefix and MUST NOT appear in the core required
set of a generally distributed package.
