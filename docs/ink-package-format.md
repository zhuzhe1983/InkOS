# `.ink` package format v1

Media type: `application/vnd.inkos.package+zip`  
Extension: `.ink`  
Root manifest: `ink-manifest.json`  
Schema identifier: `inkos.package/v1`

This is the normative offline interchange format for InkOS clients. It is a ZIP
container with semantic JSON, pre-rendered images and one navigation sidecar per
image. An image-only page may additionally carry a verified source JPEG while
retaining its ordinary pre-rendered PNG fallback. The archive contains no
executable code.

## 1. Required tree

```text
example.ink
├── ink-manifest.json
├── documents/
│   ├── <uuid>.json
│   └── <uuid>.json
├── frames/
│   └── <variant-id>/
│       ├── <uuid>/
│       │   ├── 0000.png
│       │   ├── 0000.json
│       │   ├── 0001.png
│       │   └── 0001.json
│       └── <uuid>/
│           ├── 0000.png
│           └── 0000.json
└── sources/                         # optional source-image capability
    └── <uuid>/
        ├── 0000.jpg
        └── 0001.jpg
```

All paths are declared by the manifest. A client MUST reject undeclared files,
missing files, duplicate paths and any path not satisfying the normalized path
rules in the client protocol.

## 2. ZIP profile

Version 1 permits stored or Deflate entries. It does not permit encryption,
multi-disk archives, ZIP data descriptors, symbolic-link entries or
package-provided executable code. ZIP64 is not part of the v1 client profile; a
generator MUST keep the archive and every entry below 4 GiB. Clients MUST inspect
the central directory and enforce path, entry-count and total expanded-byte
limits before decompressing any entry.

For reproducible builds a generator SHOULD:

- sort paths lexicographically;
- encode JSON as UTF-8 with a final LF;
- use the fixed timezone-free DOS timestamp (`1980-01-01 00:00:00`);
- use stable Deflate settings;
- normalize source URLs before UUID v5 generation.

PNG and JPEG entries SHOULD use ZIP STORE because both are already compressed;
JSON entries SHOULD use stable Deflate settings. This avoids redundant
compression work and peak memory on constrained clients without changing
package semantics.

## 3. Manifest

The manifest contains:

```json
{
  "schemaVersion": "inkos.package/v1",
  "packageId": "0fcb175c-aec7-4d8b-a78d-cffe132b790c",
  "slug": "nook-eink-zh",
  "revision": 1,
  "title": "Nook 电子墨水屏系列",
  "entryUuid": "f9bf6ed8-47e1-5f3f-95de-5562a8f28bd2",
  "createdAt": "2026-07-16T14:00:00+08:00",
  "generator": { "name": "inkos-web-generator", "version": "1.0.0" },
  "compatibility": {
    "formatMajor": 1,
    "minimumClientVersions": { "web": "1.0.0", "paperS3": "1.0.0" },
    "requiredCapabilities": [
      "navigation.parent-v1",
      "navigation.hitbox-v1",
      "display.font-level-v1",
      "device.settings-v1",
      "content-ota.atomic-v1"
    ]
  },
  "provenance": {
    "seeds": [{
      "url": "https://zh.wikipedia.org/wiki/Nook#电子墨水屏系列",
      "title": "Nook",
      "retrievedAt": "2026-07-16T14:00:00+08:00",
      "license": "CC BY-SA 4.0"
    }],
    "crawl": { "maxDepth": 1, "maxDocuments": 8 }
  },
  "variants": [],
  "documents": []
}
```

`packageId` identifies one package lineage/revision stream. Rebuilding the same
logical collection SHOULD preserve it and increment `revision`; a fork gets a new
package ID.

## 4. Display variants

A variant is an exact render tuple:

```json
{
  "id": "m5stack-paper-s3-portrait.portrait.normal.font-p0",
  "profileId": "m5stack-paper-s3-portrait",
  "screenProfileVersion": 2,
  "displayMeta": {
    "orientation": "portrait",
    "invert": false,
    "fontLevel": 0
  },
  "logicalSize": { "width": 540, "height": 960 },
  "displayRotation": 90,
  "pixelFormat": "gray4",
  "codec": "png"
}
```

`gray4` means four bits per pixel, giving PaperS3 its 16 grayscale levels; it
does not mean four grayscale levels. The packaged PNG is therefore a 4-bit
indexed grayscale image with a 16-entry palette.

The tuple, not the human-readable ID, is authoritative. Each document MUST have
frames for every manifest variant in a complete v1 package. This simplifies
constrained clients and makes missing-setting behavior detectable at install time.

Physical panel dimensions and derived PPI are trusted renderer profile data;
they are not duplicated into the package variant or semantic document. Their
effect is already committed to each PNG, sidecar hitbox and page count. A render
policy change that alters packaged bytes requires fresh generator/package
revision metadata and fresh artifact hashes; an online frame cache additionally
includes the renderer version. Clients continue to validate the declared profile
ID/version, logical size, rotation and pixel format in the variant.

`displayMeta.invert` is retained for v1 wire compatibility but MUST be `false`.
New packages MUST NOT declare `display.invert-v1`; readers MAY accept that
historical capability token only when every variant remains normal polarity.
Any package or frame containing `invert: true` MUST be rejected.

A package is complete relative to the variants it declares; it does not have to
enumerate every possible orientation/font Cartesian product. For example,
the built-in application-home package declares only the portrait and landscape
base PaperS3 tuples at font level 0, and is a valid offline
archive for those tuples. An online service may render another tuple from the
verified packaged semantic documents without modifying the archive. An offline
client MUST still report `VARIANT_UNAVAILABLE` when the exact requested tuple is
not declared.

## 5. Document index

Each document index records UUID, optional parent, title/kind/source, semantic
document path/length/SHA-256, and one frame set per variant. Each frame set has a
contiguous page array starting at zero. Every page declares PNG and sidecar paths,
lengths and SHA-256 digests.

### 5.1 Optional source JPEG

An image document page MAY add `sourceImage` while keeping the normal PNG fields:

```json
{
  "pageIndex": 0,
  "imagePath": "frames/m5stack-paper-s3-portrait.portrait.normal.font-p0/8b3d9199-814d-5f3f-86b8-c960fc14a2df/0000.png",
  "imageBytes": 18421,
  "imageSha256": "3f4b09b2d11ca489c47ea325189c057b57c3c6c60af9d07933f8f47c66db68a8",
  "sourceImage": {
    "path": "sources/8b3d9199-814d-5f3f-86b8-c960fc14a2df/0000.jpg",
    "bytes": 98139,
    "sha256": "c51e2a15d5765f152f07054bf1cc82629730702cc9f644bd3a26fca507e3235b",
    "mediaType": "image/jpeg",
    "pixelSize": { "width": 540, "height": 960 },
    "fit": "contain"
  },
  "sidecarPath": "frames/m5stack-paper-s3-portrait.portrait.normal.font-p0/8b3d9199-814d-5f3f-86b8-c960fc14a2df/0000.json",
  "sidecarBytes": 712,
  "sidecarSha256": "a345368f9e774bf0992aebfbec8a975ec3aeb7afb9b9a9525e108f94c79f6226"
}
```

Such a package MUST declare the required capability
`frame.source-image-jpeg-v1`. `sourceImage` is allowed only when the indexed
document kind is `image`. Its canonical path ends in lowercase `.jpg`; its
declared byte count, SHA-256 and SOF dimensions MUST match the archive bytes.
Version 1 accepts an 8-bit baseline sequential JPEG (SOF0) with one or three
components. EXIF orientation MUST be absent or `upper-left`.

The source JPEG preserves source pixels; it is not a server-rendered screen
frame. A generator MAY losslessly change progressive JPEG entropy coding to
baseline (for example with `jpegtran -copy all -optimize`) but MUST NOT resize,
crop, tone-map, grayscale, sharpen, dither or quantize it. The mandatory PNG
remains the complete renderer-owned fallback and continues to match the
variant's logical size and gray4 rules.

A capable package client MUST prefer `sourceImage`, preserve aspect ratio and
center the result on an opaque white logical frame using `contain`. It MUST NOT
apply source-specific tone curves, sharpening, dithering or gray4 conversion
before passing decoded pixels to its normal panel/display path. When the source
is 540×960 on the portrait PaperS3 variant this operation is exactly 1:1; the
same source is scaled and letterboxed for a landscape variant. Failure to
verify or decode a required source image fails package activation; it MUST NOT
silently switch the test to the PNG fallback.

The manifest does not hash itself because that would be circular. A transport MAY
provide a signed or hashed manifest through HTTPS headers, object-store metadata or
a future package-signature extension. Every non-manifest artifact is hashed by the
manifest.

## 6. Document envelope

`documents/<uuid>.json` uses `inkos.document/v1` as specified in the client
protocol. The envelope UUID and parent MUST exactly match its manifest index.
Semantic `content.id` MUST equal the envelope UUID.

An envelope MAY contain up to eight declarative `localWidgets`. Version 1
defines only a `clock` widget: a stable ID, semantic `contentPath`, fixed
`HH:mm:ss` format, `Asia/Shanghai` timezone, refresh interval and periodic
cleanup interval. It contains no coordinates, styles, script or executable
expression. A client that does not implement it displays the ordinary static
semantic content.

## 7. Frame sidecar

`frames/<variant>/<uuid>/<page>.json` uses `inkos.frame-sidecar/v1`. The sidecar:

- MUST match package/document/parent/variant/page values in the manifest;
- MUST reference the paired PNG path and SHA-256;
- MUST repeat the manifest page's complete `sourceImage` object when present;
- MUST use the variant logical size;
- MUST contain only target UUIDs present in the package;
- MUST contain only bounds inside the logical screen.

Interactions SHOULD include a human-readable `label`. A source link that is
not materialized in the package MAY include `targetUrl`; its packaged
`targetUuid` remains a valid safe fallback. Online clients resolve that URL
through the InkOS service, while offline package verification still depends
only on the packaged UUID graph.

An RSS/Atom list interaction whose detail is materialized in the package MAY
carry `fallbackUrl` instead of `targetUrl`. The packaged detail UUID remains
the primary destination. `fallbackUrl` is limited to credential-free HTTPS on
the default HTTPS port and is valid only as recovery after the client verifies
that a replacement manifest no longer contains the old detail UUID.
`targetUrl` and `fallbackUrl` MUST NOT appear together. This field does not
relax the package UUID-closure rule and never authorizes direct client-side
website fetching.

As a narrow exception to HTTP(S), new packages may set `targetUrl` to the exact
client-owned collection actions `inkos://collection/rss` or
`inkos://collection/website`, or the server-owned application actions
`inkos://app/random-image` and `inkos://app/baidu-map`. Readers and verifiers
MAY continue to accept the legacy exact string `inkos://collection/other` for
old packages, but MUST map it to `website`; producers MUST NOT emit it. Every
other custom URI is rejected. None is a source, image or archive path.
Collection actions are dispatched locally; app actions go only to the dedicated
service endpoint, which performs all external fetches server-side.

The sidecar is separate from the PNG/source JPEG so a device can parse
navigation and select the preferred artifact without decoding or modifying
image pixels.

The `photo-papers3-slideshow-gray16-rgb-png-v3` photo output and
`diagnostic-raw-colour-png-v1` map output from
`POST /api/ink/v1/apps/execute` are not package-format variants. Only that
transient application path may carry an 8-bit RGB/RGBA PNG. Uploaded and
embedded `.ink` fallback frames remain strict 4-bit indexed gray4 for PaperS3;
the only package exception is the independently declared, capability-gated
baseline JPEG described in section 5.1.
That declared source JPEG selects the same strongly typed PaperS3 photo display
profile as a verified transient Image Viewer photo. Ordinary package PNGs and
map PNGs remain generic; clients MUST NOT select a refresh profile merely from
the document's semantic `kind: "image"`.

A sidecar MAY contain up to eight renderer-owned `dynamicRegions`. A clock
region binds the semantic widget to exact logical bounds and a constrained text
style (`monospace`, font size/weight/alignment, black/white foreground and
background). Region IDs MUST be unique; bounds MUST fit inside `logicalSize` and
MUST NOT overlap interactions. Foreground and background MUST differ. Dynamic
regions are optional progressive enhancement, not package code: the paired PNG
MAY reserve a blank region instead of painting a placeholder. A client without
local-widget support still receives a valid static frame; it simply leaves that
optional region blank.

## 8. Verification order

Clients MUST verify in this order before activation:

1. archive byte limit and ZIP structure;
2. root manifest schema and compatibility;
3. declared/actual path equality;
4. inflate/read every referenced payload, validating its ZIP CRC, declared
   length and digest;
5. document envelopes and parent DAG;
6. sidecar cross-references, hitbox bounds and dynamic-region bounds/styles;
7. every PNG signature, dimensions and supported codec/pixel format;
8. every declared source JPEG signature/SOF profile, dimensions and duplicated
   page/sidecar metadata;
9. preferred entry artifact decode for selected settings.

Verifying in this order gives cheap failures first and prevents untrusted metadata
from driving device navigation.

## 9. Content OTA and rollback

An `.ink` download is written to an inactive slot. The active pointer changes only
after every referenced payload passes verification and entry-frame decode succeeds. The old slot remains until
the new entry frame has refreshed successfully. Details are normative in
[client-protocol.md](./client-protocol.md#9-content-ota).

## 10. Signatures

Package signatures are intentionally deferred from v1 rather than invented
implicitly. Public distribution SHOULD use authenticated HTTPS and trusted catalog
metadata. A future `inkos.package-signature/v1` capability can add detached Ed25519
signatures without changing the ZIP/data execution model.
