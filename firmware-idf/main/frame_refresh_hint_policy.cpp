#include "frame_refresh_hint_policy.h"

namespace inkos::idf {

FrameRefreshHint dynamicFrameRefreshHint(const std::string &manifestHint) {
  return manifestHint == "binary-text" ? FrameRefreshHint::BinaryText
                                       : FrameRefreshHint::QualityRequired;
}

bool refreshHintHeaderMatchesManifest(const std::string &headerHint,
                                      const std::string &manifestHint) {
  return headerHint == manifestHint;
}

} // namespace inkos::idf
