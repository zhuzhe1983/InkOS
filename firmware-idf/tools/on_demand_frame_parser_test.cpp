#include "frame_refresh_hint_policy.h"
#include "ink_protocol.h"

#include <cassert>
#include <string>

using inkos::idf::OnDemandFrame;
using inkos::idf::FrameRefreshHint;
using inkos::idf::DocumentRef;
using inkos::idf::dynamicFrameRefreshHint;
using inkos::idf::parseOnDemandFrame;
using inkos::idf::refreshHintHeaderMatchesManifest;
using inkos::idf::validateDocumentEnvelope;

namespace {

std::string fixture(const std::string &optionalMember,
                    const std::string &documentRevision = "1") {
  std::string json = R"json({
    "schemaVersion":"inkos.frame/v2",
    "rendererVersion":"test-renderer",
    "frameId":"0123456789abcdef01234567",
    "documentId":"11111111-1111-4111-8111-111111111111",
    "documentRevision":)json";
  json += documentRevision;
  json += R"json(,
    "contentType":"detail",
    "screenProfileId":"m5stack-paper-s3-portrait",
    "screenProfileVersion":2,
    "nativeSize":{"width":960,"height":540},
    "logicalSize":{"width":540,"height":960},
    "displayRotation":90,
    "pixelFormat":"gray4",
    "layoutStrategy":"paper-s3-semantic-v1",
    "rasterStrategy":"eink-gray4-png-v1",
    "displayMeta":{"orientation":"portrait","fontLevel":0,"invert":false},
    "codec":"png",
    "pagination":{
      "pageIndex":0,
      "pageCount":1,
      "hasPrevious":false,
      "hasNext":false
    },
    "update":{
      "kind":"full",
      "region":{"x":0,"y":0,"width":540,"height":960}
    },)json";
  json += optionalMember;
  json += R"json(
    "payloadBytes":1,
    "sha256":"0000000000000000000000000000000000000000000000000000000000000000",
    "crc32":"00000000",
    "interactions":[],
    "warnings":[]
  })json";
  return json;
}

bool accepts(const std::string &member, OnDemandFrame &frame) {
  std::string error;
  return parseOnDemandFrame(fixture(member), frame, error);
}

bool acceptsRevision(const std::string &revision, OnDemandFrame &frame) {
  std::string error;
  return parseOnDemandFrame(fixture("", revision), frame, error);
}

} // namespace

int main() {
  OnDemandFrame missing;
  assert(accepts("", missing));
  assert(missing.refreshHint.empty());
  assert(dynamicFrameRefreshHint(missing.refreshHint) ==
         FrameRefreshHint::QualityRequired);
  assert(refreshHintHeaderMatchesManifest("", missing.refreshHint));
  assert(!refreshHintHeaderMatchesManifest("binary-text",
                                           missing.refreshHint));

  OnDemandFrame binary;
  assert(accepts(R"json("refreshHint":"binary-text",)json", binary));
  assert(binary.refreshHint == "binary-text");
  assert(dynamicFrameRefreshHint(binary.refreshHint) ==
         FrameRefreshHint::BinaryText);
  assert(refreshHintHeaderMatchesManifest("binary-text",
                                          binary.refreshHint));
  assert(!refreshHintHeaderMatchesManifest("", binary.refreshHint));
  assert(!refreshHintHeaderMatchesManifest("unknown", binary.refreshHint));

  OnDemandFrame millisecondRevision;
  assert(acceptsRevision("1784799501000", millisecondRevision));
  assert(millisecondRevision.documentRevision == 1784799501000ULL);

  for (const std::string &invalidRevision : {
           "-1",
           "1.5",
           "9007199254740992",
       }) {
    OnDemandFrame rejected;
    rejected.documentId = "unchanged";
    assert(!acceptsRevision(invalidRevision, rejected));
    assert(rejected.documentId == "unchanged");
  }

  DocumentRef reference;
  reference.uuid = "11111111-1111-4111-8111-111111111111";
  reference.parentUuid = "22222222-2222-4222-8222-222222222222";
  reference.kind = "detail";
  const std::string document = R"json({
    "schemaVersion":"inkos.document/v1",
    "uuid":"11111111-1111-4111-8111-111111111111",
    "parentUuid":"22222222-2222-4222-8222-222222222222",
    "source":{"title":"RSS article","retrievedAt":"2026-07-24T00:00:00.000Z"},
    "content":{
      "schemaVersion":"inkos.content/v2",
      "id":"11111111-1111-4111-8111-111111111111",
      "revision":1784799501000,
      "locale":"zh-CN",
      "updatedAt":"2026-07-24T00:00:00.000Z",
      "page":{"kind":"detail","title":"RSS article","blocks":[]}
    }
  })json";
  uint64_t contentRevision = 0;
  std::string documentError;
  assert(validateDocumentEnvelope(document, reference, documentError,
                                  &contentRevision));
  assert(contentRevision == 1784799501000ULL);

  for (const std::string &invalid : {
           R"json("refreshHint":"fast",)json",
           R"json("refreshHint":"",)json",
           R"json("refreshHint":true,)json",
           R"json("refreshHint":null,)json",
           R"json("refreshHint":123,)json",
       }) {
    OnDemandFrame rejected;
    rejected.documentId = "unchanged";
    assert(!accepts(invalid, rejected));
    assert(rejected.documentId == "unchanged");
  }
  return 0;
}
