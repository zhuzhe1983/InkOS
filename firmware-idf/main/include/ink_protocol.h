#pragma once

#include "ink_types.h"

#include <string>

namespace inkos::idf {

bool parseManifest(const std::string &json, const std::string &sha256,
                   const std::string &etag, Manifest &result,
                   std::string &error);
bool parseSidecar(const std::string &json, const std::string &packageId,
                  const std::string &documentUuid, uint16_t pageIndex,
                  const std::string &variantId, Sidecar &result,
                  std::string &error);
bool parseOnDemandFrame(const std::string &json, OnDemandFrame &result,
                        std::string &error);
bool parseWarningList(const std::string &json, std::vector<std::string> &result,
                      std::string &error);
bool validateDocumentEnvelope(const std::string &json,
                              const DocumentRef &reference,
                              std::string &error,
                              uint64_t *contentRevision = nullptr);
const DisplayVariant *selectVariant(const Manifest &manifest,
                                    const DisplayMeta &meta);
// Local .ink packages are required to carry the normal, font-0 variant for
// each supported orientation. Prefer an exact settings match, then fall back
// only within the requested orientation so saved font settings cannot break
// offline page navigation.
const DisplayVariant *selectVariantWithBaseFallback(
    const Manifest &manifest, const DisplayMeta &meta);
const DocumentRef *findDocument(const Manifest &manifest,
                                const std::string &uuid);
const PageRef *findPage(const DocumentRef &document,
                        const std::string &variantId, uint16_t pageIndex);
const Interaction *hitTest(const Sidecar &sidecar, int32_t x, int32_t y);

} // namespace inkos::idf
