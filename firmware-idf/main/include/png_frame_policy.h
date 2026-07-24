#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace inkos::idf {

/**
 * Standard package artifacts remain indexed gray4. Only the transient
 * apps/execute path uses the diagnostic policy, which additionally permits
 * lossless 8-bit RGB/RGBA PNGs for the temporary raw-colour baseline.
 */
enum class PngFramePolicy : uint8_t {
  PackageGray4,
  AppDiagnosticTrueColour,
};

bool validatePngFrame(const std::vector<uint8_t> &png, uint16_t width,
                      uint16_t height, PngFramePolicy policy,
                      std::string &error);

} // namespace inkos::idf
