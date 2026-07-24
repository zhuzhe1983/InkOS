#include "png_frame_policy.h"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstring>

namespace inkos::idf {
namespace {

bool fail(std::string &error, const char *message) {
  error = message;
  return false;
}

} // namespace

bool validatePngFrame(const std::vector<uint8_t> &png, uint16_t width,
                      uint16_t height, PngFramePolicy policy,
                      std::string &error) {
  static constexpr std::array<uint8_t, 8> kSignature{
      0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a};
  if (png.size() < 45 ||
      !std::equal(kSignature.begin(), kSignature.end(), png.begin())) {
    return fail(error, "Frame contains a truncated PNG");
  }
  const auto readBig32 = [&png](size_t offset) {
    return static_cast<uint32_t>(png[offset]) << 24 |
           static_cast<uint32_t>(png[offset + 1]) << 16 |
           static_cast<uint32_t>(png[offset + 2]) << 8 |
           static_cast<uint32_t>(png[offset + 3]);
  };
  if (readBig32(8) != 13 ||
      std::memcmp(png.data() + 12, "IHDR", 4) != 0 ||
      readBig32(16) != width || readBig32(20) != height ||
      png[26] != 0 || png[27] != 0 || png[28] != 0) {
    return fail(error, "PNG dimensions or IHDR fields are invalid");
  }

  const uint8_t bitDepth = png[24];
  const uint8_t colorType = png[25];
  const bool indexedGray4 = bitDepth == 4 && colorType == 3;
  const bool diagnosticTrueColour =
      bitDepth == 8 && (colorType == 2 || colorType == 6);
  if (policy == PngFramePolicy::PackageGray4 && !indexedGray4) {
    return fail(error, "Package PNG is not indexed gray4");
  }
  if (policy == PngFramePolicy::AppDiagnosticTrueColour &&
      !indexedGray4 && !diagnosticTrueColour) {
    return fail(
        error,
        "App PNG is neither indexed gray4 nor diagnostic 8-bit RGB/RGBA");
  }

  bool sawPalette = false;
  bool sawImageData = false;
  bool sawEnd = false;
  size_t offset = 33;
  while (offset + 12 <= png.size()) {
    const uint32_t length = readBig32(offset);
    if (length > png.size() - offset - 12) {
      return fail(error, "PNG has a truncated chunk");
    }
    const char *type =
        reinterpret_cast<const char *>(png.data() + offset + 4);
    const size_t payload = offset + 8;
    const size_t end = offset + 12 + length;
    if (std::memcmp(type, "PLTE", 4) == 0) {
      if (diagnosticTrueColour) {
        return fail(error,
                    "Diagnostic RGB/RGBA app PNG must not contain a palette");
      }
      if (sawPalette || sawImageData || length != 16 * 3) {
        return fail(error, "gray4 PNG must have one 16-entry palette");
      }
      std::array<bool, 256> levels{};
      for (size_t index = 0; index < length; index += 3) {
        const uint8_t red = png[payload + index];
        if (red != png[payload + index + 1] ||
            red != png[payload + index + 2] || levels[red]) {
          return fail(error,
                      "gray4 PNG palette is not 16 distinct grays");
        }
        levels[red] = true;
      }
      sawPalette = true;
    } else if (std::memcmp(type, "IDAT", 4) == 0) {
      if (indexedGray4 && !sawPalette) {
        return fail(error, "gray4 PNG is missing its palette");
      }
      sawImageData = true;
    } else if (std::memcmp(type, "IEND", 4) == 0) {
      if (length != 0 || end != png.size()) {
        return fail(error, "PNG has an invalid IEND");
      }
      sawEnd = true;
      break;
    }
    offset = end;
  }
  if (!sawImageData || !sawEnd || (indexedGray4 && !sawPalette)) {
    return fail(error, "PNG is missing palette, image data, or IEND");
  }
  return true;
}

} // namespace inkos::idf
