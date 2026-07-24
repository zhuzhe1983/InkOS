#include "jpeg_frame_policy.h"

#include <cassert>
#include <cstdint>
#include <string>
#include <vector>

using inkos::idf::JpegFrameInfo;
using inkos::idf::inspectSourceJpeg;
using inkos::idf::validateSourceJpeg;

namespace {

void append16(std::vector<uint8_t> &bytes, uint16_t value) {
  bytes.push_back(static_cast<uint8_t>(value >> 8));
  bytes.push_back(static_cast<uint8_t>(value));
}

std::vector<uint8_t> baseline(uint16_t width, uint16_t height,
                              uint8_t sofMarker = 0xc0) {
  std::vector<uint8_t> jpeg{0xff, 0xd8, 0xff, sofMarker};
  append16(jpeg, 11);
  jpeg.push_back(8);
  append16(jpeg, height);
  append16(jpeg, width);
  jpeg.insert(jpeg.end(), {1, 1, 0x11, 0});
  jpeg.insert(jpeg.end(),
              {0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0x2a, 0xff, 0});
  jpeg.insert(jpeg.end(), {0x19, 0xff, 0xd9});
  return jpeg;
}

bool valid(const std::vector<uint8_t> &jpeg, uint16_t width,
           uint16_t height) {
  std::string error;
  return validateSourceJpeg(jpeg, width, height, error);
}

} // namespace

int main() {
  const auto jpeg = baseline(540, 960);
  assert(valid(jpeg, 540, 960));
  assert(!valid(jpeg, 960, 540));

  JpegFrameInfo info;
  std::string error;
  assert(inspectSourceJpeg(jpeg, info, error));
  assert(info.width == 540);
  assert(info.height == 960);

  assert(!valid(baseline(540, 960, 0xc2), 540, 960));

  auto noEnd = jpeg;
  noEnd.pop_back();
  assert(!valid(noEnd, 540, 960));

  auto secondScan = jpeg;
  secondScan.erase(secondScan.end() - 2, secondScan.end());
  secondScan.insert(secondScan.end(), {0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0,
                                      0x22, 0xff, 0xd9});
  assert(!valid(secondScan, 540, 960));

  assert(!valid(baseline(4096, 4096), 4096, 4096));
  return 0;
}
