# Inkos frame boundary

The device receives an already-rendered page frame. It does not parse
`inkos.content/v2`, choose a layout, paginate text, load application fonts or
quantize colour.

## Frame manifest

`inkos.frame/v2` contains:

- renderer, screen-profile, layout-strategy and raster-strategy versions;
- document ID, revision and semantic page type;
- native/logical dimensions, rotation, pixel format and codec;
- the normalized request-level `displayMeta` used for the frame, including
  portrait/landscape orientation;
- rendered `pageIndex`, total `pageCount`, and previous/next state;
- full or partial update region;
- optional `refreshHint: "binary-text"`, derived from semantic image absence
  and the final PaperS3 gray4 payload rather than the semantic page kind;
- payload size, SHA-256, CRC32 and frame ID;
- render warnings;
- link actions and renderer-generated hit bounds for the selected page.

The HTTP API returns the base64url-encoded manifest in `X-Inkos-Manifest`, a
base64url warning list in `X-Inkos-Warnings`, and the PNG payload in the body.
Hit bounds use logical screen coordinates; they are output metadata, never part
of semantic input JSON. A direction change therefore changes logical bounds and
may change pagination; it is not a client-side bitmap rotation.

## Device application sequence

1. Resolve and verify the device profile and revision.
2. Request or receive the required rendered page.
3. Download the payload into a pending slot.
4. Verify length and CRC32 before decoding.
5. Decode PNG into the panel driver's supported representation.
6. Select the refresh waveform. A missing dynamic-frame hint, images,
   incompatible previous-frame state and cleanup intervals use quality
   refresh; an unknown/non-string hint or header/manifest mismatch rejects the
   dynamic transaction. Only a verified `binary-text` frame may continue to
   the device's decoded-pixel validator and bounded binary fast path. Legacy
   packaged frames that predate the field may use an explicitly separate
   compatibility heuristic.
7. Refresh the full screen or declared manifest region.
8. Atomically mark the frame active only after a successful refresh.
9. Register the selected page's interaction map when the device supports input.
10. Report `DISPLAYED(frameId)` and enter the device power policy.

## Production packed-frame extension

PNG is not a panel-native packed buffer. A later encoder can emit:

- `mono1-msb`: row-major, first pixel in bit 7, with declared polarity;
- `gray4-high`: row-major, first pixel in the high nibble, with declared polarity;
- raw or a precisely named codec such as zlib/Deflate or row RLE.

Packed output must also declare row stride and decoded byte length. The manifest
remains the transport boundary so HTTP, BLE and local storage can share the same
receiver and validation state machine.
