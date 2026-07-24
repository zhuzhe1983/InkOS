#include "ink_protocol.h"

#include <cassert>
#include <string>

using inkos::idf::Manifest;
using inkos::idf::DisplayMeta;
using inkos::idf::DisplayVariant;
using inkos::idf::Orientation;
using inkos::idf::Sidecar;
using inkos::idf::parseManifest;
using inkos::idf::parseSidecar;
using inkos::idf::selectVariantWithBaseFallback;

namespace {

constexpr const char *kPackage = "11111111-1111-4111-8111-111111111111";
constexpr const char *kDocument = "22222222-2222-4222-8222-222222222222";
const std::string kSha(64, '0');

std::string manifest(const std::string &capability,
                     const std::string &kind = "image",
                     const std::string &mediaType = "image/jpeg") {
  return std::string(R"JSON({
    "schemaVersion":"inkos.package/v1",
    "packageId":")JSON") + kPackage + R"JSON(",
    "entryUuid":")JSON" + kDocument + R"JSON(",
    "title":"source test",
    "revision":1,
    "compatibility":{
      "formatMajor":1,
      "minimumClientVersions":{"paperS3":"1.0.0"},
      "requiredCapabilities":[")JSON" + capability + R"JSON("]
    },
    "variants":[{
      "id":"portrait-p0",
      "profileId":"m5stack-paper-s3-portrait",
      "screenProfileVersion":2,
      "displayMeta":{"orientation":"portrait","fontLevel":0,"invert":false},
      "logicalSize":{"width":540,"height":960},
      "displayRotation":90,
      "pixelFormat":"gray4",
      "codec":"png"
    }],
    "documents":[{
      "uuid":")JSON" + kDocument + R"JSON(",
      "title":"photo",
      "kind":")JSON" + kind + R"JSON(",
      "documentPath":"documents/22222222-2222-4222-8222-222222222222.json",
      "documentBytes":2,
      "documentSha256":")JSON" + kSha + R"JSON(",
      "variants":[{
        "variantId":"portrait-p0",
        "pageCount":1,
        "pages":[{
          "pageIndex":0,
          "imagePath":"frames/portrait-p0/22222222-2222-4222-8222-222222222222/0000.png",
          "imageBytes":64,
          "imageSha256":")JSON" + kSha + R"JSON(",
          "sourceImage":{
            "path":"source-images/portrait-p0/22222222-2222-4222-8222-222222222222/0000.jpg",
            "bytes":1234,
            "sha256":")JSON" + kSha + R"JSON(",
            "mediaType":")JSON" + mediaType + R"JSON(",
            "pixelSize":{"width":1080,"height":1920},
            "fit":"contain"
          },
          "sidecarPath":"frames/portrait-p0/22222222-2222-4222-8222-222222222222/0000.json",
          "sidecarBytes":64,
          "sidecarSha256":")JSON" + kSha + R"JSON("
        }]
      }]
    }]
  })JSON";
}

std::string sidecar() {
  return std::string(R"JSON({
    "schemaVersion":"inkos.frame-sidecar/v1",
    "packageId":")JSON") + kPackage + R"JSON(",
    "documentUuid":")JSON" + kDocument + R"JSON(",
    "variantId":"portrait-p0",
    "pageIndex":0,
    "pageCount":1,
    "logicalSize":{"width":540,"height":960},
    "imagePath":"frames/portrait-p0/22222222-2222-4222-8222-222222222222/0000.png",
    "imageSha256":")JSON" + kSha + R"JSON(",
    "sourceImage":{
      "path":"source-images/portrait-p0/22222222-2222-4222-8222-222222222222/0000.jpg",
      "bytes":1234,
      "sha256":")JSON" + kSha + R"JSON(",
      "mediaType":"image/jpeg",
      "pixelSize":{"width":1080,"height":1920},
      "fit":"contain"
    },
    "interactions":[]
  })JSON";
}

bool parses(const std::string &json) {
  Manifest parsed;
  std::string error;
  return parseManifest(json, kSha, '"' + kSha + '"', parsed, error);
}

} // namespace

int main() {
  Manifest parsed;
  std::string error;
  const std::string valid =
      manifest("frame.source-image-jpeg-v1");
  assert(parseManifest(valid, kSha, '"' + kSha + '"', parsed, error));
  const auto &source =
      parsed.documents.front().variants.front().pages.front().sourceImage;
  assert(source.present);
  assert(source.path.find("source-images/") == 0);
  assert(source.width == 1080);
  assert(source.height == 1920);
  assert(source.fit == "contain");

  const DisplayVariant *exact = selectVariantWithBaseFallback(
      parsed, DisplayMeta{Orientation::Portrait, 0, false});
  assert(exact);
  assert(exact->id == "portrait-p0");
  const DisplayVariant *fontFallback = selectVariantWithBaseFallback(
      parsed, DisplayMeta{Orientation::Portrait, 2, false});
  assert(fontFallback);
  assert(fontFallback->id == "portrait-p0");
  const DisplayVariant *invertFallback = selectVariantWithBaseFallback(
      parsed, DisplayMeta{Orientation::Portrait, 0, true});
  assert(invertFallback);
  assert(invertFallback->id == "portrait-p0");
  assert(!selectVariantWithBaseFallback(
      parsed, DisplayMeta{Orientation::Landscape, 2, false}));

  Sidecar parsedSidecar;
  error.clear();
  assert(parseSidecar(sidecar(), kPackage, kDocument, 0, "portrait-p0",
                      parsedSidecar, error));
  assert(parsedSidecar.sourceImage == source);

  assert(!parses(manifest("navigation.parent-v1")));
  assert(!parses(manifest("frame.source-image-jpeg-v1", "detail")));
  assert(!parses(manifest("frame.source-image-jpeg-v1", "image",
                          "image/png")));
  return 0;
}
