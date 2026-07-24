#include "png_frame_policy.h"

#include <cassert>
#include <cstdint>
#include <string>
#include <vector>

using inkos::idf::PngFramePolicy;
using inkos::idf::validatePngFrame;

namespace {

void appendBig32(std::vector<uint8_t> &png, uint32_t value) {
  png.push_back(static_cast<uint8_t>(value >> 24));
  png.push_back(static_cast<uint8_t>(value >> 16));
  png.push_back(static_cast<uint8_t>(value >> 8));
  png.push_back(static_cast<uint8_t>(value));
}

void appendChunk(std::vector<uint8_t> &png, const char type[5],
                 const std::vector<uint8_t> &payload) {
  appendBig32(png, static_cast<uint32_t>(payload.size()));
  png.insert(png.end(), type, type + 4);
  png.insert(png.end(), payload.begin(), payload.end());
  // The production call sites retain their existing SHA/integrity checks.
  // This bounded structural validator has never duplicated PNG chunk CRCs.
  appendBig32(png, 0);
}

std::vector<uint8_t> fixture(uint8_t bitDepth, uint8_t colorType,
                             bool palette) {
  std::vector<uint8_t> png{
      0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a};
  std::vector<uint8_t> ihdr;
  appendBig32(ihdr, 2);
  appendBig32(ihdr, 1);
  ihdr.insert(ihdr.end(), {bitDepth, colorType, 0, 0, 0});
  appendChunk(png, "IHDR", ihdr);
  if (palette) {
    std::vector<uint8_t> entries;
    for (uint8_t index = 0; index < 16; ++index) {
      const uint8_t gray = static_cast<uint8_t>(index * 17);
      entries.insert(entries.end(), {gray, gray, gray});
    }
    appendChunk(png, "PLTE", entries);
  }
  appendChunk(png, "IDAT", {0});
  appendChunk(png, "IEND", {});
  return png;
}

bool accepts(const std::vector<uint8_t> &png, PngFramePolicy policy) {
  std::string error;
  return validatePngFrame(png, 2, 1, policy, error);
}

} // namespace

int main() {
  const auto gray4 = fixture(4, 3, true);
  const auto rgb = fixture(8, 2, false);
  const auto rgba = fixture(8, 6, false);

  assert(accepts(gray4, PngFramePolicy::PackageGray4));
  assert(accepts(gray4, PngFramePolicy::AppDiagnosticTrueColour));
  assert(accepts(rgb, PngFramePolicy::AppDiagnosticTrueColour));
  assert(accepts(rgba, PngFramePolicy::AppDiagnosticTrueColour));
  assert(!accepts(rgb, PngFramePolicy::PackageGray4));
  assert(!accepts(rgba, PngFramePolicy::PackageGray4));
  assert(!accepts(fixture(8, 0, false),
                  PngFramePolicy::AppDiagnosticTrueColour));
  assert(!accepts(fixture(8, 2, true),
                  PngFramePolicy::AppDiagnosticTrueColour));
  return 0;
}
