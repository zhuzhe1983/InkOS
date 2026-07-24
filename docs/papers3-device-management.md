# PaperS3 device management API

Status: local-device v1 contract  
Base URL after provisioning: `http://<PaperS3 station IPv4>/`  
Captive AP URL while provisioning: `http://192.168.4.1/`

The native PaperS3 firmware runs one HTTP server on all local interfaces. The
captive AP and DNS redirect may stop after station association, but the HTTP
manager remains available at the station address shown in the device settings.
This surface has no public authentication or TLS and MUST remain on a trusted
LAN/AP; routers MUST NOT expose it through WAN port forwarding.

All responses use `Cache-Control: no-store`. JSON mutations are committed to
NVS before a success response. The immutable home linked into the firmware can
never be overwritten through this API.

## Human-facing form

`GET /` returns a mobile-sized management form. It can:

- edit Wi-Fi SSID/password and the renderer root URL;
- edit the ordered RSS, network-reader website and image collections, one
  `label | url` per line; deleting or moving a line deletes or reorders it;
- upload one raw `.ink` archive and activate it after verification;
- delete the uploaded home and return to the embedded fallback.

The password field is never returned. Leaving it blank preserves the current
password.

## State and settings

`GET /api/state` returns `inkos.device-state/v1` with non-secret network state,
the complete collections value and the active uploaded-home identity. A client
MUST treat `uploadedHome.active=false` as “embedded fallback”, not as a missing
home.

`PUT /api/settings` accepts:

```json
{
  "ssid": "trusted-wifi",
  "password": "optional-new-password",
  "serverBaseUrl": "http://192.168.1.10:3000"
}
```

The renderer URL is a credential-free HTTP(S) origin with an optional port and
no path, query or fragment. A successful update schedules station reconnect
after the HTTP response has been sent.

## Persistent collections

`GET /api/collections` returns, and `PUT /api/collections` replaces:

```json
{
  "schemaVersion": "inkos.device-collections/v2",
  "revision": 4,
  "rss": [
    {
      "id": "rss-14bd2275f820a37e2881",
      "label": "Example feed",
      "url": "https://example.org/feed.xml"
    }
  ],
  "websites": [],
  "images": [
    {
      "id": "images-…",
      "label": "复古相机·金属与暗纹",
      "url": "https://picsum.photos/id/250/540/960?grayscale"
    },
    {
      "id": "images-…",
      "label": "黑色幼犬·暗部与眼部高光",
      "url": "https://picsum.photos/id/237/540/960?grayscale"
    }
  ]
}
```

RSS and images have at most 16 entries; websites has at most 32 so firmware can
migrate the former v1 `websites` and `other` lists without dropping data.
Labels are at most 96 UTF-8 bytes, URLs at most 1024 bytes, and the serialized
NVS blob is at most 48 KiB. RSS/websites URLs and normal image entries MUST use
HTTPS and contain no credentials. An omitted/null ID is deterministically
generated from collection kind plus URL; a supplied ID must match
`[a-z0-9][a-z0-9_-]{0,63}`. IDs are unique across all three lists, and array
order is display/page order.

On first boot, when the collections blob does not yet exist, firmware writes a
revision-1 Network Reader list containing 煎蛋、维基百科、人民日报、百度贴吧 and
Chiphell; RSS starts with 少数派、阮一峰的网络日志 and Solidot; images starts
with one editable `随机图片 | https://picsum.photos/540/960?random=1` row.
These are real persisted seeds, so later user edits are not silently re-added
after the user intentionally clears a list.

The HTML manager displays every image as `名称 | https://图片地址`; every row,
including the initial random row, can be modified, deleted, or extended, and
the order is the viewer's page order. Old v2 data containing the retired
`inkos://app/random-image` pseudo URL or the exact former grayscale default
(`https://picsum.photos/540/960?grayscale&random=1`) is rewritten in place to
the editable non-grayscale URL. Other custom grayscale URLs are preserved.

Firmware also accepts the former `inkos.device-collections/v1` value exactly
once during upgrade. It preserves RSS, merges `other` into `websites` in order,
skips duplicate URLs, adds the initial image row, increments the revision,
and atomically rewrites NVS as v2. v2 responses and writes never expose an
`other` field.

The built-in package opens the two reading collections through:

```text
inkos://collection/rss
inkos://collection/website
```

For old packages only, firmware still accepts the exact
`inkos://collection/other` alias and maps it to `website`; new packages MUST NOT
emit it. The firmware never sends those strings to the network. It converts the stored
entries to a coordinate-free `inkos.content/v2` list and asks the configured
renderer's `POST /api/ink/v1/render` for an exact PaperS3 PNG and sidecar. Only
an individual HTTPS entry is later submitted to `/sources/resolve`.

The home menu calls this application **图片查看器**.
`inkos://app/random-image` is dispatched locally. The runtime reads the
ordered `images` collection and asks the renderer for one full-screen page per
entry; the exact default Picsum HTTPS row receives the fresh app nonce on each
entry/refresh, while every other HTTPS image remains stable.
Image Viewer responses declare
`photo-papers3-slideshow-gray16-rgb-png-v3`: after required `cover` geometry,
the server follows the proven slideshow preprocessing sequence—grayscale,
0.5% two-ended autocontrast, contrast 1.08, unsharp radius 1 / 65% / threshold
3, and serpentine Floyd-Steinberg quantization to the sixteen indices. It emits
neutral RGB values at the stable PaperS3 bucket centres `8, 24, …, 248`.
Those centres map to one native gray level at every M5GFX 4×4 Bayer position,
avoiding a second spatial mix between adjacent levels.
All remote URL/SSRF/size/decode/integrity checks still apply. PaperS3 presents
the decoded 8-bit RGB PNG through its physical 16-gray panel. Only after the
client verifies that exact response mode does it assign the strongly typed
`PaperS3PhotoGray16` profile and run the three-pass white-clear, 16-gray body,
endpoint-reinforcement sequence. A semantic `contentType: "image"` by itself is
never sufficient.
`inkos://app/baidu-map` is a
separate built-in app action, is not stored in the image list, and retains the
pixel-preserving `diagnostic-raw-colour-png-v1` mode and generic quality
refresh.

## Atomic uploaded home

`PUT /api/home` accepts the raw archive body with `Content-Length` and one of:

```text
application/vnd.inkos.package+zip
application/zip
application/octet-stream
```

Maximum body size is `0x440000` bytes (4.25 MiB). Both A/B slots and their sizes
are 64-KiB aligned, but upload code deliberately uses cooperative 4-KiB sector
erases rather than a long 64-KiB block erase; the final 64 KiB of flash stays
reserved. Chunked transfer without a known length is rejected.

The request handler first receives the complete body into external PSRAM. It
allows at most 8 seconds without forward progress and at most 120 seconds total;
an incomplete or late request is rejected without touching either home slot.
Every 256 KiB it records received bytes in RTC no-init memory and emits one
bounded progress/resource log. This receive checkpoint performs no NVS or
partition write.
Insufficient staging memory returns `503`. Once the complete body is resident,
the device creates the worker task first, while the request is still pending,
then claims a 2-KiB bounce buffer linked into internal DRAM at build time. The
buffer never depends on the heavily fragmented runtime heap and is transferred
to the worker without allocation. Failure to create the worker stack or claim
the single-upload buffer returns `503` synchronously. Only after those
resources exist does the device queue the background job and respond:

```http
HTTP/1.1 202 Accepted
Location: /api/home/status
Retry-After: 1
```

```json
{
  "accepted": true,
  "jobId": 7,
  "statusUrl": "/api/home/status"
}
```

Only one receive/write/verify job may be active. Another `PUT /api/home`, or a
`DELETE /api/home` while that job is active, returns `409`.

`GET /api/home/status` is intentionally independent of the storage mutex, so it
remains queryable between flash chunks. It returns the latest in-memory job:

```json
{
  "schemaVersion": "inkos.home-upload/v1",
  "jobId": 7,
  "phase": "writing",
  "active": true,
  "totalBytes": 3873131,
  "receivedBytes": 3873131,
  "writtenBytes": 1048576,
  "elapsedMs": 33840
}
```

`phase` is one of `idle`, `receiving`, `queued`, `writing`, `verifying`,
`succeeded` or `failed`. A failed result also has `error`; a successful result
has `activatedHome`. The in-memory job survives until the next upload or reboot,
while the activation record itself is durable. A best-effort RTC warm-reset
checkpoint is also included when available:

```json
{
  "recoveryCheckpoint": {
    "sequence": 8,
    "phase": "receiving",
    "totalBytes": 3798509,
    "writtenBytes": 2883584,
    "receivedBytes": 2883584,
    "detailOffset": 2883584
  }
}
```

This diagnostic survives watchdog/software resets (not a complete power loss)
and distinguishes upload `receiving`, `zip-directory`, `manifest-extract`,
`manifest-parse`, `references`, `entry-frames`, `payloads`, `commit`, and the
flash phases.
During `payloads`, serial progress reports completed document/page counts and
elapsed verification time. Clients should poll about once per second.

The background implementation:

1. reads the CRC-protected active-slot NVS record;
2. streams to the inactive raw partition in flash-safe internal-memory blocks,
   skipping exact-data retries and avoiding an erase for already-blank sectors;
3. memory-maps that slot and validates ZIP layout/path safety, expanded limits,
   manifest/client compatibility, PaperS3 portrait and landscape base variants,
   acyclic parent ancestry, and the canonical path/declared length closure of
   every document, sidecar and frame; before commit it then reads every payload
   and validates ZIP CRC, manifest byte count/SHA, document envelope, sidecar
   schema/lineage/targets, and gray4 PNG geometry for all documents and pages;
4. commits one CRC-protected NVS blob naming slot, size, archive SHA-256,
   package/entry UUID and revision;
5. signals the display task to map, recompute the complete archive SHA, parse
   its manifest and activate the new entry page. Because the NVS record was
   committed only after step 3 and names that exact SHA, the expensive complete
   reference walk does not need to run a second time.

The worker runs at low priority on CPU1 because the PaperS3 Wi-Fi task is pinned
to CPU0. It deliberately avoids a 64-KiB flash block-erase command: changed data
is erased one 4-KiB sector at a time, writes are capped at 2 KiB per flash API
call, and every erase/write call is followed by a 10-ms scheduler window. The
much faster read/compare pass yields once per 64 KiB. This bounds individual
cache-off intervals and lets Wi-Fi, lwIP and both idle tasks run often enough to
service the watchdog. Serial diagnostics are emitted every 256 KiB with stack
high-water, internal-heap and PSRAM free/largest-block values.

Read-only ZIP/JSON verification runs on a dedicated 32-KiB PSRAM stack pinned
to CPU1. The original internal-stack writer waits for it and retains exclusive
responsibility for flash unmapping and NVS mutation, so an external-stack task
never enters a cache-disabled write path. Standard `malloc/new` is configured
to prefer PSRAM (`CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL=0`): the 523-entry ZIP
index, cJSON manifest tree and C++ path containers cannot consume the small,
fragmented internal heap needed by Wi-Fi/lwIP. Stage logs and the RTC checkpoint
make every potentially expensive verification boundary observable.

The current 50-document/236-page package is verified incrementally with a
scheduler yield after every page; logs report both counters every 16 pages and
the total verification time. Runtime repeats CRC/SHA/JSON/sidecar/PNG checks
before displaying a page as defense in depth. Any failure before step 4 leaves
the prior slot active. A
boot-time validation failure uses the firmware-linked home. The upload HTTP
request is therefore bounded by network receive time rather than slow flash
programming; activation finishes asynchronously and is observable through the
status route. `DELETE /api/home` atomically removes only the uploaded-home
activation record and immediately restores the embedded fallback; it cannot
delete embedded bytes.
