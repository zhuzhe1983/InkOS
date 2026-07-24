#include "fast_text_pixel_policy.h"

#include <limits>

namespace inkos::idf {
namespace {

bool isIntermediate(uint8_t value) {
  // The renderer's stable gray4 centres are 8,24,...,248. The two darkest and
  // two lightest buckets are acceptable black/white edge coverage.
  return value > 32 && value < 224;
}

} // namespace

DecodedFastTextAnalysis analyzeFastTextPixels(const uint8_t *pixels,
                                              size_t bufferLength,
                                              int32_t width, int32_t height,
                                              size_t stride) {
  DecodedFastTextAnalysis result;
  if (!pixels || width <= 0 || height <= 0 ||
      stride < static_cast<size_t>(width) ||
      static_cast<uint64_t>(stride) * static_cast<uint32_t>(height) >
          bufferLength ||
      static_cast<uint64_t>(width) * static_cast<uint32_t>(height) >
          std::numeric_limits<uint32_t>::max()) {
    return result;
  }

  result.totalPixels =
      static_cast<uint32_t>(static_cast<uint64_t>(width) * height);
  for (int32_t y = 0; y < height; ++y) {
    const uint8_t *row = pixels + static_cast<size_t>(y) * stride;
    for (int32_t x = 0; x < width; ++x) {
      if (!isIntermediate(row[x])) continue;
      ++result.intermediatePixels;
      // Anti-aliased glyph/divider pixels touch a dark or light target.
      // Intermediate regions whose four-neighbourhood is also intermediate
      // indicate a photo, map, gradient, or grey-filled card.
      const bool touchesExtreme =
          (x > 0 && !isIntermediate(row[x - 1])) ||
          (x + 1 < width && !isIntermediate(row[x + 1])) ||
          (y > 0 &&
           !isIntermediate(
               pixels[static_cast<size_t>(y - 1) * stride + x])) ||
          (y + 1 < height &&
           !isIntermediate(
               pixels[static_cast<size_t>(y + 1) * stride + x]));
      if (!touchesExtreme) ++result.interiorIntermediatePixels;
    }
  }
  result.valid = true;
  return result;
}

bool decodedPixelsAreNativeSolidBlack(const uint8_t *pixels,
                                      size_t bufferLength, int32_t width,
                                      int32_t height, size_t stride) {
  if (!pixels || width <= 0 || height <= 0 ||
      stride < static_cast<size_t>(width) ||
      static_cast<uint64_t>(stride) * static_cast<uint32_t>(height) >
          bufferLength) {
    return false;
  }
  for (int32_t y = 0; y < height; ++y) {
    const uint8_t *row = pixels + static_cast<size_t>(y) * stride;
    for (int32_t x = 0; x < width; ++x) {
      if (row[x] > kNativeSolidBlackMaxGray) return false;
    }
  }
  return true;
}

} // namespace inkos::idf
