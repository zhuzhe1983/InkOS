# InkOS PaperS3 client

This directory contains the real M5Stack PaperS3 target. It is an Arduino C++
application built with PlatformIO, M5Unified and M5GFX; it is no longer the old
320x240 LVGL/devkit placeholder.

The device is intentionally a rendered-artifact client. It never lays out
semantic JSON. It verifies an `inkos.package/v1` archive, selects an exact
PaperS3 variant, decodes its PNG and executes the paired
`inkos.frame-sidecar/v1` navigation metadata.

## Why Arduino C++ rather than a shared Rust runtime

M5Stack's supported PaperS3 path is M5Unified/M5GFX in C++ and its official
examples cover the ED047TC1 panel, GT911 touch controller, PSRAM and microSD.
Rust can target ESP32-S3 through the esp-rs Xtensa toolchain and can also compile
to WebAssembly, but it does not remove the need to bind the current PaperS3 C++
display/touch stack. For the first hardware client that adds toolchain and driver
risk without reducing protocol risk. Browser and device therefore use their
native languages and share versioned JSON, sidecars and conformance vectors.

Official references used for this target:

- <https://docs.m5stack.com/en/core/PaperS3>
- <https://docs.m5stack.com/en/arduino/m5papers3/program>
- <https://docs.m5stack.com/en/arduino/m5papers3/touch>
- <https://docs.m5stack.com/en/arduino/m5papers3/sdcard>
- <https://github.com/m5stack/M5Unified>
- <https://github.com/m5stack/M5GFX>

## Runtime behavior

The pure `inkos_navigation` library implements the protocol transitions:

| Input | Result |
| --- | --- |
| left swipe | canonical `parentUuid`, restoring the immediately visited parent page when available |
| up swipe | next page; final page is a no-op |
| down swipe | previous page; page zero opens the canonical parent |
| tap | smallest containing half-open hitbox wins; opens `targetUuid` at page zero |
| right swipe | reserved no-op |
| long press | open/close device settings |

Swipe recognition uses the protocol defaults: at least 48 logical pixels or 8%
of the shorter edge, with a 1.25 dominant-axis ratio. Tap movement is limited to
16 pixels.

The settings screen exposes `fontLevel` (-2 through +2), pre-rendered inversion,
and strict offline mode. Font and inversion changes are accepted only when the
exact package variant exists; the device does not resize or invert a bitmap as a
substitute. Settings and the last successfully displayed package/document/page
are persisted in NVS.

The checked-in target selects the profile's native reading orientation
(`portrait`, 540x960). Orientation is still part of the exact variant and can be
changed at build time with `-DINKOS_ORIENTATION=\"landscape\"`; it is not silently
substituted at runtime.

### Server-owned local clock regions

A frame sidecar may optionally declare up to eight `dynamicRegions`. The current
device capability accepts only a server-laid-out clock region; the client does
not choose its coordinates, font or refresh cadence:

```json
{
  "dynamicRegions": [{
    "id": "clock-main",
    "kind": "clock",
    "bounds": { "x": 56, "y": 236, "width": 428, "height": 132 },
    "format": "HH:mm:ss",
    "timezone": "Asia/Shanghai",
    "refreshMs": 1000,
    "fullRefreshEvery": 60,
    "style": {
      "fontFamily": "monospace",
      "fontSize": 72,
      "fontWeight": 700,
      "textAlign": "center",
      "verticalAlign": "middle",
      "foreground": "black",
      "background": "white"
    }
  }]
}
```

IDs must be unique, bounds must fit the logical frame, and a dynamic region may
not overlap an interaction. The parser rejects unknown clock fields, unsupported
formats/timezones, same foreground/background colors, refresh intervals outside
1--60 seconds and cleanup counts outside 1--3600. Sidecars without
`dynamicRegions` remain valid.

The complete PNG is always decoded and displayed first, so its server-rendered
time remains a safe fallback. If the system clock is not usable, the client uses
the configured Wi-Fi credentials and SNTP; failure is logged without erasing or
replacing that static frame. Once time is valid, the device formats Shanghai
time locally, refreshes only the declared rectangle with the fast black/white
waveform, and uses the text cleanup waveform at `fullRefreshEvery`. Touch input
and the settings screen pause local refreshes.

Full package PNGs use `epd_quality`, preserving PaperS3's 16-level gray output.
The target is currently pinned to M5GFX 0.2.24, whose rotated region
`display(x,y,w,h)` path has a coordinate bug. Clock updates therefore push an
exact-size sprite inside one display transaction, letting Panel_EPD track the
actual dirty rectangle. M5GFX 0.2.25 fixes the rotated explicit-region path and
is the recommended baseline for a new native client, but the transaction path
remains valid there as well.

## Content OTA and SD layout

PaperS3 microSD uses the official SPI pins: CS 47, SCK 39, MOSI 38 and MISO 40.
Cards must be FAT32. To install an offline package, place files as follows and
restart:

```text
/inkos/inbox/update.ink
/inkos/inbox/update.ink.sha256   # recommended: one lowercase SHA-256 line
```

The application extracts into an isolated staging directory and rejects unsafe
or duplicate paths, encrypted/multi-disk/ZIP64 archives, unsupported compression,
symlinks, undeclared artifacts and size-limit violations. It then verifies the
manifest compatibility, every declared byte length and SHA-256, the parent DAG,
document envelopes, sidecar cross-references and bounds, PNG signature and
dimensions, and finally performs an entry-frame decode in PSRAM.

Only after all checks does it promote staging into the inactive A/B slot and
atomically change the NVS active-slot pointer. The old slot is retained. If the
new frame cannot refresh, the pointer is rolled back. A failed or interrupted
install never writes into the active slot.

Current hard limits are 128 MiB compressed, 512 MiB expanded, 32 MiB per entry
and 8192 entries. ZIP supports STORE and Deflate. A local package without the
optional digest still receives all internal checks, but the digest is needed to
authenticate the otherwise-unhashed manifest. Remote OTA always requires an
expected archive SHA-256.

## Optional online package OTA

With `offline=false`, the client can download a server-hosted `.ink` (for example
`GET /api/ink/v1/packages/{packageId}/download`) and activate it through the same
staging path. Configure values through private build flags, not source control:

```sh
export PLATFORMIO_BUILD_FLAGS='\
  -DINKOS_WIFI_SSID=\"your-ssid\" \
  -DINKOS_WIFI_PASSWORD=\"your-password\" \
  -DINKOS_PACKAGE_URL=\"http://192.168.1.10:3000/api/ink/v1/packages/ID/download\" \
  -DINKOS_PACKAGE_SHA256=\"0123456789abcdef...64-hex-characters...\"'
```

HTTPS is refused unless `INKOS_ROOT_CA` contains a trusted PEM root. The firmware
does not call `setInsecure()`. Navigation continues from verified local artifacts
after download, so a network outage does not blank the e-paper screen.

## Build and test

Use the maintained PlatformIO environment (Python 3.10 or newer):

```sh
cd firmware
~/.platformio/penv/bin/pio test -e native
~/.platformio/penv/bin/pio run -e papers3
```

The PaperS3 environment follows M5Stack's official settings: generic
`esp32-s3-devkitm-1`, 16 MiB flash, Octal PSRAM (`qio_opi`), Arduino,
M5Unified 0.2.17 and M5GFX 0.2.24. Upstream miniz 3.1.2 provides bounded ZIP
extraction; its unused Deflate encoder is disabled to avoid colliding with the
private compressor bundled by M5GFX.

The build proves a real ESP32-S3/PaperS3 cross-compile. It does not prove touch,
SD electrical behavior, e-paper refresh quality, power-loss timing or battery
life on physical hardware; those require flashing an actual unit.
