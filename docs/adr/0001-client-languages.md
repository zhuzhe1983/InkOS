# ADR 0001: Client implementation languages

Status: Accepted for v1  
Date: 2026-07-16

## Decision

- The browser client and website services use TypeScript/React/Node.js.
- The PaperS3 device client uses C++ with Arduino/PlatformIO, M5Unified and M5GFX.
- Cross-client reuse happens at the protocol, JSON Schema, `.ink` fixtures and
  state-machine test-vector level, not by forcing one source language.
- Rust remains a viable later option for a small, pure shared state-machine core,
  but is not the v1 hardware delivery path.

## Evidence

M5Stack documents PaperS3 as an ESP32-S3R8 device with 8 MB PSRAM, 16 MB flash,
microSD, a 960×540 16-level grayscale panel and GT911 two-point touch. The official
page lists Arduino IDE, ESP-IDF and PlatformIO as supported development platforms:

- https://docs.m5stack.com/en/core/paperS3

M5Stack's official touch example requires board `M5PaperS3`, M5Stack Board Manager
`>=2.1.4`, M5Unified `>=0.2.5` and M5GFX `>=0.2.7`; it exposes rotated display and
touch through the same official library surface:

- https://docs.m5stack.com/en/arduino/m5papers3/touch
- https://github.com/m5stack/M5Unified
- https://github.com/m5stack/M5GFX

Rust can target ESP32-S3. Espressif publishes `esp-hal` for ESP32-S3 and Rust on
ESP documentation. However, ESP32-S3 is Xtensa; the Rust book states Xtensa is not
yet upstream-supported by the official Rust compiler and uses Espressif-maintained
LLVM/Rust forks. It also warns that portions of the embedded ecosystem remain
unstable:

- https://docs.espressif.com/projects/rust/book/
- https://docs.espressif.com/projects/rust/book/introduction/hardware-overview.html
- https://docs.espressif.com/projects/rust/esp-hal/latest/

Rust also compiles to WebAssembly for browsers, so a common language is technically
possible. It would not provide common display/touch/storage implementations: the
browser still needs DOM APIs while PaperS3 needs M5Stack-specific drivers. In v1 it
would add WASM glue, a custom Xtensa toolchain and new e-paper/touch integration
while bypassing the vendor's working examples.

## Consequences

The C++ firmware gets the shortest path to real hardware and official examples.
TypeScript keeps the web service and offline file import straightforward. Both must
pass the same exported JSON transition vectors and `.ink` conformance packages,
which prevents language divergence without coupling either client to the renderer.

If a later Rust experiment demonstrates smaller code, equal M5PaperS3 hardware
coverage and reliable CI, this ADR may be superseded. The package/client protocol
does not change with implementation language.

