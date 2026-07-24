#pragma once

#include "ink_types.h"

#include <string>

namespace inkos::idf {

// Dynamic/on-demand frames fail closed when the optional manifest hint is
// absent. LegacyUnspecified is assigned only by static package loaders.
FrameRefreshHint dynamicFrameRefreshHint(const std::string &manifestHint);

// The HTTP advisory header and the decoded manifest field are redundant by
// design. A mismatch rejects the transaction rather than silently widening
// refresh permission.
bool refreshHintHeaderMatchesManifest(const std::string &headerHint,
                                      const std::string &manifestHint);

} // namespace inkos::idf
