#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace inkos::idf {

struct JpegFrameInfo {
  uint16_t width = 0;
  uint16_t height = 0;
};

// Validates the deliberately small JPEG subset supported by M5GFX's TJpgDec
// decoder. Source-image package entries are decoded one-to-one into the
// PaperS3 canvas, so their encoded geometry must already match the selected
// display variant. Progressive, arithmetic and multi-scan JPEGs are rejected
// before entering the decoder.
bool validateSourceJpeg(const std::vector<uint8_t> &jpeg, uint16_t width,
                        uint16_t height, std::string &error);
bool inspectSourceJpeg(const std::vector<uint8_t> &jpeg, JpegFrameInfo &info,
                       std::string &error);

} // namespace inkos::idf
