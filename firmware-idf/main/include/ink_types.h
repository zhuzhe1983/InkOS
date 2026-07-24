#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace inkos::idf {

inline constexpr const char *kClientVersion = "1.0.0";
inline constexpr const char *kProfileId = "m5stack-paper-s3-portrait";
inline constexpr uint32_t kProfileVersion = 2;
inline constexpr size_t kMaximumManifestBytes = 2U * 1024U * 1024U;
inline constexpr size_t kMaximumDocumentBytes = 2U * 1024U * 1024U;
inline constexpr size_t kMaximumFrameBytes = 8U * 1024U * 1024U;
inline constexpr size_t kMaximumSourceImageBytes = 2U * 1024U * 1024U;
inline constexpr size_t kMaximumSidecarBytes = 512U * 1024U;
inline constexpr size_t kMaximumHttpResponseHeaderBytes = 2U * 1024U * 1024U;

enum class Orientation : uint8_t { Portrait, Landscape };
enum class OrientationMode : uint8_t { Manual, Automatic };
// Refresh permission is deliberately fail-closed for runtime-generated
// frames. LegacyUnspecified is reserved for already packaged static .ink
// frames that predate refreshHint; it still requires device pixel validation.
enum class FrameRefreshHint : uint8_t {
  LegacyUnspecified,
  BinaryText,
  QualityRequired
};
// A verified producer contract for server-side raster preparation. Device
// waveform selection is independent: every semantic image uses the
// slideshow-derived three-pass PaperS3 sequence.
enum class FrameRenderProfile : uint8_t {
  Generic,
  PaperS3PhotoGray16
};

struct DisplayMeta {
  Orientation orientation = Orientation::Portrait;
  int8_t fontLevel = 0;
  bool invert = false;
};

struct DeviceSettings {
  std::string wifiSsid;
  std::string wifiPassword;
  std::string serverBaseUrl;
  OrientationMode orientationMode = OrientationMode::Manual;
  Orientation manualOrientation = Orientation::Portrait;
  int8_t fontLevel = 0;
};

struct Bounds {
  int32_t x = 0;
  int32_t y = 0;
  int32_t width = 0;
  int32_t height = 0;

  bool contains(int32_t pointX, int32_t pointY) const {
    return pointX >= x && pointX < x + width && pointY >= y &&
           pointY < y + height;
  }
  int64_t area() const { return static_cast<int64_t>(width) * height; }
};

struct DisplayVariant {
  std::string id;
  std::string profileId;
  uint32_t profileVersion = 0;
  DisplayMeta meta;
  uint16_t width = 0;
  uint16_t height = 0;
  uint16_t rotation = 0;
  std::string pixelFormat;
  std::string codec;
};

struct SourceImageRef {
  bool present = false;
  std::string path;
  uint32_t bytes = 0;
  std::string sha256;
  std::string mediaType;
  uint16_t width = 0;
  uint16_t height = 0;
  std::string fit;

  bool operator==(const SourceImageRef &other) const {
    return present == other.present && path == other.path &&
           bytes == other.bytes && sha256 == other.sha256 &&
           mediaType == other.mediaType && width == other.width &&
           height == other.height && fit == other.fit;
  }
};

struct PageRef {
  uint16_t index = 0;
  std::string imagePath;
  uint32_t imageBytes = 0;
  std::string imageSha256;
  // Optional original-tone JPEG decoded by the device. The image fields above
  // remain the mandatory indexed-gray4 fallback for older clients.
  SourceImageRef sourceImage;
  std::string sidecarPath;
  uint32_t sidecarBytes = 0;
  std::string sidecarSha256;
};

struct VariantPages {
  std::string variantId;
  std::vector<PageRef> pages;
};

struct DocumentRef {
  std::string uuid;
  std::string parentUuid;
  std::string title;
  std::string kind;
  std::string documentPath;
  uint32_t documentBytes = 0;
  std::string documentSha256;
  std::vector<VariantPages> variants;
};

struct Manifest {
  std::string packageId;
  std::string entryUuid;
  std::string title;
  uint32_t revision = 0;
  std::string sha256;
  std::string strongEtag;
  std::vector<DisplayVariant> variants;
  std::vector<DocumentRef> documents;
};

struct Interaction {
  std::string id;
  std::string contentPath;
  std::string label;
  Bounds bounds;
  std::string targetUuid;
  std::string targetUrl;
  std::string fallbackUrl;
};

enum class TextAlign : uint8_t { Left, Center, Right };
enum class VerticalAlign : uint8_t { Top, Middle, Bottom };

struct ClockStyle {
  uint16_t fontSize = 24;
  uint16_t fontWeight = 400;
  TextAlign textAlign = TextAlign::Center;
  VerticalAlign verticalAlign = VerticalAlign::Middle;
  bool foregroundWhite = false;
  bool backgroundWhite = true;
};

struct ClockRegion {
  std::string id;
  Bounds bounds;
  uint32_t refreshMs = 1000;
  uint16_t fullRefreshEvery = 60;
  ClockStyle style;
};

struct Sidecar {
  std::string packageId;
  std::string documentUuid;
  std::string parentUuid;
  std::string variantId;
  uint16_t pageIndex = 0;
  uint16_t pageCount = 0;
  uint16_t width = 0;
  uint16_t height = 0;
  std::string imagePath;
  std::string imageSha256;
  SourceImageRef sourceImage;
  std::vector<Interaction> interactions;
  std::vector<ClockRegion> dynamicRegions;
};

struct OnDemandFrame {
  std::string documentId;
  // inkos.content/v2 revisions are JavaScript-safe integers. Web-generated
  // documents commonly use millisecond timestamps, which exceed uint32_t.
  uint64_t documentRevision = 0;
  std::string contentType;
  uint32_t profileVersion = 0;
  uint16_t nativeWidth = 0;
  uint16_t nativeHeight = 0;
  uint16_t width = 0;
  uint16_t height = 0;
  uint16_t rotation = 0;
  DisplayMeta meta;
  uint16_t pageIndex = 0;
  uint16_t pageCount = 0;
  bool hasPrevious = false;
  bool hasNext = false;
  uint32_t payloadBytes = 0;
  std::string sha256;
  // Empty means the optional field was absent. The parser accepts no value
  // other than "binary-text".
  std::string refreshHint;
  Bounds updateRegion;
  std::vector<Interaction> interactions;
  std::vector<std::string> warnings;
};

struct FrameTransaction {
  Manifest manifest;
  std::string documentJson;
  std::vector<uint8_t> png;
  Sidecar sidecar;
  // Verified semantic type from the document manifest/on-demand frame.
  // It selects the device waveform family: every image uses the complete
  // clear/body/endpoint sequence, while text still requires pixel validation.
  std::string contentType;
  // The independently verified render profile describes server-side pixel
  // preparation. It does not bypass the common PaperS3 image refresh sequence.
  FrameRenderProfile renderProfile = FrameRenderProfile::Generic;
  // Default is fail-closed. Static package loaders explicitly opt into the
  // legacy heuristic; dynamic renderers must explicitly declare binary-text.
  FrameRefreshHint refreshHint = FrameRefreshHint::QualityRequired;
  bool embedded = false;
  bool stored = false;
};

struct Location {
  std::string packageId;
  std::string documentUuid;
  uint16_t pageIndex = 0;
  bool embedded = false;
  bool stored = false;
};

const char *orientationName(Orientation value);
bool parseOrientation(const char *value, Orientation &result);
std::string sha256Hex(const uint8_t *data, size_t size);
bool isLowerHexSha256(const std::string &value);
bool isUuid(const std::string &value);

} // namespace inkos::idf
