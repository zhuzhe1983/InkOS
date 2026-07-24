#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace inkos::idf {

inline constexpr size_t kClockTextLength = 8;
// PaperS3's fast EPD path is intentionally 1-bit. Binarize the antialiased
// clock sprite ourselves so the panel driver never turns grey edge samples
// into a visible Bayer mesh. A slightly raised threshold keeps the regular
// DejaVu face from becoming too thin on the 227-DPI panel.
inline constexpr uint8_t kClockBinaryThreshold = 160;

constexpr uint8_t clockBinaryLevel(uint8_t value) {
  return value < kClockBinaryThreshold ? 0 : 255;
}

struct ClockGlyphChanges {
  bool fullText = false;
  uint8_t count = 0;
  std::array<uint8_t, kClockTextLength> indices{};
};

constexpr bool validClockText(std::string_view value) {
  if (value.size() != kClockTextLength || value[2] != ':' ||
      value[5] != ':') {
    return false;
  }
  for (size_t index = 0; index < value.size(); ++index) {
    if (index == 2 || index == 5) continue;
    if (value[index] < '0' || value[index] > '9') return false;
  }
  return true;
}

constexpr ClockGlyphChanges changedClockGlyphs(std::string_view previous,
                                                std::string_view next) {
  ClockGlyphChanges result;
  if (!validClockText(next)) return result;
  if (previous.empty()) {
    result.fullText = true;
    return result;
  }
  if (!validClockText(previous)) return result;
  for (size_t index = 0; index < next.size(); ++index) {
    if (previous[index] != next[index]) {
      result.indices[result.count++] = static_cast<uint8_t>(index);
    }
  }
  return result;
}

// These compile with the firmware and keep the most important dirty-region
// cases from silently regressing.
inline constexpr ClockGlyphChanges kFirstClockPaint =
    changedClockGlyphs({}, "12:34:56");
inline constexpr ClockGlyphChanges kSingleSecondChange =
    changedClockGlyphs("12:34:56", "12:34:57");
inline constexpr ClockGlyphChanges kSecondRollover =
    changedClockGlyphs("12:34:59", "12:35:00");
static_assert(kFirstClockPaint.fullText && kFirstClockPaint.count == 0);
static_assert(!kSingleSecondChange.fullText &&
              kSingleSecondChange.count == 1 &&
              kSingleSecondChange.indices[0] == 7);
static_assert(!kSecondRollover.fullText && kSecondRollover.count == 3 &&
              kSecondRollover.indices[0] == 4 &&
              kSecondRollover.indices[1] == 6 &&
              kSecondRollover.indices[2] == 7);
static_assert(clockBinaryLevel(0) == 0);
static_assert(clockBinaryLevel(kClockBinaryThreshold - 1) == 0);
static_assert(clockBinaryLevel(kClockBinaryThreshold) == 255);
static_assert(clockBinaryLevel(255) == 255);

} // namespace inkos::idf
