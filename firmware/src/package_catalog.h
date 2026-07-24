#pragma once

#include <ArduinoJson.h>
#include <FS.h>
#include <InkClock.h>
#include <InkNavigation.h>

#include <cstdint>
#include <string>
#include <vector>

namespace inkos::paper {

inline constexpr const char *kClientVersion = "1.1.0";
inline constexpr const char *kProfileId = "m5stack-paper-s3-portrait";
inline constexpr uint32_t kProfileVersion = 2;

struct DisplaySettings {
  int8_t fontLevel = 0;
  bool invert = false;
  bool offline = true;
  std::string orientation = INKOS_ORIENTATION;
};

struct DisplayVariant {
  std::string id;
  std::string profileId;
  uint32_t screenProfileVersion = 0;
  int8_t fontLevel = 0;
  bool invert = false;
  std::string orientation;
  uint16_t width = 0;
  uint16_t height = 0;
  uint16_t displayRotation = 0;
  std::string pixelFormat;
};

struct FrameRef {
  uint16_t pageIndex = 0;
  std::string imagePath;
  uint32_t imageBytes = 0;
  std::string imageSha256;
  std::string sidecarPath;
  uint32_t sidecarBytes = 0;
  std::string sidecarSha256;
};

struct VariantFrames {
  std::string variantId;
  std::vector<FrameRef> pages;
};

struct DocumentRef {
  std::string uuid;
  std::string parentUuid;
  std::string title;
  std::string kind;
  std::string documentPath;
  uint32_t documentBytes = 0;
  std::string documentSha256;
  std::vector<VariantFrames> variants;
};

enum class ClockTextAlign : uint8_t {
  Left,
  Center,
  Right,
};

enum class ClockVerticalAlign : uint8_t {
  Top,
  Middle,
  Bottom,
};

struct ClockRegionStyle {
  uint16_t fontSize = 0;
  uint16_t fontWeight = 400;
  ClockTextAlign textAlign = ClockTextAlign::Left;
  ClockVerticalAlign verticalAlign = ClockVerticalAlign::Top;
  bool foregroundWhite = false;
  bool backgroundWhite = true;
};

struct ClockRegion {
  std::string id;
  inkos::ClockBounds bounds;
  uint32_t refreshMs = inkos::kClockTickIntervalMs;
  uint16_t fullRefreshEvery = inkos::kClockCleanRefreshInterval;
  ClockRegionStyle style;
};

struct FrameSidecar {
  std::string packageId;
  std::string documentUuid;
  std::string parentUuid;
  std::string variantId;
  uint16_t pageIndex = 0;
  uint16_t pageCount = 0;
  std::string imagePath;
  std::string imageSha256;
  uint16_t width = 0;
  uint16_t height = 0;
  std::vector<inkos::HitTarget> interactions;
  std::vector<ClockRegion> dynamicRegions;
};

class PackageCatalog final : public inkos::NavigationCatalog {
public:
  bool loadAndVerify(fs::FS &fs, const std::string &rootPath,
                     std::string &error);

  bool contains(const std::string &uuid) const override;
  std::string parentOf(const std::string &uuid) const override;
  uint16_t pageCount(const std::string &uuid) const override;

  bool selectExactVariant(const DisplaySettings &settings, std::string &error);
  const DisplayVariant *activeVariant() const;
  const DocumentRef *document(const std::string &uuid) const;
  const FrameRef *frame(const std::string &uuid, uint16_t pageIndex) const;
  bool loadActiveSidecar(const std::string &uuid, uint16_t pageIndex,
                         FrameSidecar &sidecar, std::string &error) const;

  const std::string &rootPath() const { return rootPath_; }
  const std::string &packageId() const { return packageId_; }
  const std::string &entryUuid() const { return entryUuid_; }
  const std::string &title() const { return title_; }
  uint32_t revision() const { return revision_; }

private:
  bool parseManifest(JsonObjectConst root, std::string &error);
  bool validateCompatibility(JsonObjectConst root, std::string &error) const;
  bool verifyDeclaredFiles(std::string &error) const;
  bool verifyDocuments(std::string &error) const;
  bool verifySidecar(const DocumentRef &document,
                     const DisplayVariant &variant,
                     const FrameRef &frame, FrameSidecar *result,
                     std::string &error) const;
  const VariantFrames *framesFor(const DocumentRef &document,
                                 const std::string &variantId) const;

  fs::FS *fs_ = nullptr;
  std::string rootPath_;
  std::string packageId_;
  std::string entryUuid_;
  std::string title_;
  uint32_t revision_ = 0;
  std::string activeVariantId_;
  std::vector<DisplayVariant> variants_;
  std::vector<DocumentRef> documents_;
  std::vector<std::string> declaredPaths_;
};

bool isNormalizedArchivePath(const std::string &path);
bool sha256File(fs::FS &fs, const std::string &path, std::string &digest,
                std::string &error);
std::string joinPath(const std::string &root, const std::string &relative);

} // namespace inkos::paper
