#pragma once

#include <cstddef>
#include <cstdint>

namespace inkos::idf {

struct DecodedFastTextAnalysis {
  uint32_t intermediatePixels = 0;
  uint32_t interiorIntermediatePixels = 0;
  uint32_t totalPixels = 0;
  bool valid = false;
};

// The renderer's darkest stable gray4 bucket is 8. Panel_EPD's quality
// quantizer maps every sample <= 8 to native level 0 for every Bayer phase;
// values above 8 can legitimately reach level 1 and must not be collapsed.
inline constexpr uint8_t kNativeSolidBlackMaxGray = 8;

// Analyze an 8-bit grayscale decoded frame. This function intentionally has no
// M5GFX dependency so the exact firmware classifier can be host-tested.
DecodedFastTextAnalysis analyzeFastTextPixels(const uint8_t *pixels,
                                              size_t bufferLength,
                                              int32_t width, int32_t height,
                                              size_t stride);

// True only when every visible decoded pixel is guaranteed to quantize to
// Panel_EPD native black. Row padding, when present, is intentionally ignored.
bool decodedPixelsAreNativeSolidBlack(const uint8_t *pixels,
                                      size_t bufferLength, int32_t width,
                                      int32_t height, size_t stride);

} // namespace inkos::idf
