#include "jpeg_frame_policy.h"

#include "ink_types.h"

#include <cstddef>

namespace inkos::idf {
namespace {

bool fail(std::string &error, const char *message) {
  error = message;
  return false;
}

uint16_t readBig16(const std::vector<uint8_t> &bytes, size_t offset) {
  return static_cast<uint16_t>(bytes[offset]) << 8 |
         static_cast<uint16_t>(bytes[offset + 1]);
}

bool isStartOfFrame(uint8_t marker) {
  return (marker >= 0xc0 && marker <= 0xc3) ||
         (marker >= 0xc5 && marker <= 0xc7) ||
         (marker >= 0xc9 && marker <= 0xcb) ||
         (marker >= 0xcd && marker <= 0xcf);
}

} // namespace

bool inspectSourceJpeg(const std::vector<uint8_t> &jpeg, JpegFrameInfo &info,
                       std::string &error) {
  info = {};
  if (jpeg.size() < 14 || jpeg.size() > kMaximumSourceImageBytes ||
      jpeg[0] != 0xff || jpeg[1] != 0xd8 ||
      jpeg[jpeg.size() - 2] != 0xff || jpeg.back() != 0xd9) {
    return fail(error, "Source image is not a complete JPEG");
  }

  bool foundBaselineFrame = false;
  bool foundScan = false;
  size_t cursor = 2;
  while (cursor < jpeg.size()) {
    if (jpeg[cursor] != 0xff) {
      return fail(error, "JPEG marker stream is malformed");
    }
    while (cursor < jpeg.size() && jpeg[cursor] == 0xff) ++cursor;
    if (cursor >= jpeg.size()) {
      return fail(error, "JPEG marker stream is truncated");
    }
    const uint8_t marker = jpeg[cursor++];
    if (marker == 0xd9) {
      return foundBaselineFrame && foundScan && cursor == jpeg.size() &&
                     info.width != 0 && info.height != 0
                 ? true
                 : fail(error, "JPEG ended before one complete baseline scan");
    }
    if (marker == 0xd8 || marker == 0x00 || marker == 0x01 ||
        (marker >= 0xd0 && marker <= 0xd7)) {
      return fail(error, "JPEG has an invalid marker outside scan data");
    }
    if (cursor + 2 > jpeg.size()) {
      return fail(error, "JPEG segment length is truncated");
    }
    const uint16_t segmentBytes = readBig16(jpeg, cursor);
    if (segmentBytes < 2 ||
        static_cast<size_t>(segmentBytes) > jpeg.size() - cursor) {
      return fail(error, "JPEG segment exceeds its payload");
    }
    const size_t payload = cursor + 2;
    const size_t end = cursor + segmentBytes;

    if (isStartOfFrame(marker)) {
      if (marker != 0xc0 || foundBaselineFrame || segmentBytes < 11) {
        return fail(error, "Source JPEG must use one baseline SOF0 frame");
      }
      const uint8_t precision = jpeg[payload];
      const uint16_t encodedHeight = readBig16(jpeg, payload + 1);
      const uint16_t encodedWidth = readBig16(jpeg, payload + 3);
      const uint8_t components = jpeg[payload + 5];
      const uint16_t expectedSegmentBytes =
          static_cast<uint16_t>(8U + 3U * components);
      if (precision != 8 || (components != 1 && components != 3) ||
          segmentBytes != expectedSegmentBytes ||
          encodedWidth == 0 || encodedWidth > 4096 || encodedHeight == 0 ||
          encodedHeight > 4096 ||
          static_cast<uint64_t>(encodedWidth) * encodedHeight >
              12000000ULL) {
        return fail(error,
                    "Source JPEG format or dimensions exceed device limits");
      }
      foundBaselineFrame = true;
      info.width = encodedWidth;
      info.height = encodedHeight;
    }

    if (marker != 0xda) {
      cursor = end;
      continue;
    }
    if (!foundBaselineFrame || foundScan || segmentBytes < 8) {
      return fail(error, "Source JPEG has an unsupported scan structure");
    }
    foundScan = true;
    cursor = end;
    // In the baseline subset accepted here the entropy-coded scan may only
    // contain byte stuffing and restart markers before the final EOI. This
    // rejects progressive and multi-scan inputs that TJpgDec cannot decode.
    while (cursor < jpeg.size()) {
      if (jpeg[cursor++] != 0xff) continue;
      while (cursor < jpeg.size() && jpeg[cursor] == 0xff) ++cursor;
      if (cursor >= jpeg.size()) {
        return fail(error, "JPEG entropy stream is truncated");
      }
      const uint8_t scanMarker = jpeg[cursor++];
      if (scanMarker == 0x00 ||
          (scanMarker >= 0xd0 && scanMarker <= 0xd7)) {
        continue;
      }
      if (scanMarker == 0xd9 && cursor == jpeg.size()) return true;
      return fail(error, "Source JPEG must contain one baseline scan");
    }
  }
  return fail(error, "JPEG has no end marker");
}

bool validateSourceJpeg(const std::vector<uint8_t> &jpeg, uint16_t width,
                        uint16_t height, std::string &error) {
  JpegFrameInfo info;
  if (!inspectSourceJpeg(jpeg, info, error)) return false;
  if (width == 0 || height == 0 || info.width != width ||
      info.height != height) {
    return fail(error,
                "Source JPEG dimensions differ from its manifest metadata");
  }
  return true;
}

} // namespace inkos::idf
