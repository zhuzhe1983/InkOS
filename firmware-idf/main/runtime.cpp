#include "runtime.h"

#include "device_storage.h"
#include "frame_refresh_hint_policy.h"
#include "jpeg_frame_policy.h"
#include "navigation_observability.h"
#include "png_frame_policy.h"
#include "settings.h"

#if defined(CONFIG_INKOS_RSS_SERIAL_HARNESS) && \
    CONFIG_INKOS_RSS_SERIAL_HARNESS
#include "rss_serial_harness_protocol.h"

#include <driver/usb_serial_jtag.h>
#include <driver/usb_serial_jtag_vfs.h>
#endif

#include <cJSON.h>
#include <esp_log.h>
#include <esp_netif_sntp.h>
#include <esp_random.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <mbedtls/base64.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <sys/time.h>
#include <memory>

namespace inkos::idf {
namespace {

constexpr const char *kTag = "inkos-runtime";
constexpr const char *kHomePackageId =
    "7f12227f-be7f-5092-a73f-6dc57e85af61";
constexpr const char *kApiBase = "/api/ink/v1";
constexpr const char *kOnlinePackageId =
    "00000000-0000-4000-8000-000000000000";
constexpr const char *kRandomImageAction = "inkos://app/random-image";
constexpr const char *kBaiduMapAction = "inkos://app/baidu-map";
constexpr const char *kSettingsAction = "inkos://device/settings";
constexpr const char *kRandomImageDocument =
    "50605ede-b09d-5de8-8615-a718d3a5605b";
constexpr const char *kBaiduMapDocument =
    "cdcdc6c5-5773-549a-b3c8-5b4363bf9a35";
constexpr const char *kPhotoPaperS3Gray16ImageMode =
    "photo-papers3-slideshow-gray16-rgb-png-v3";
constexpr const char *kDiagnosticRawColourImageMode =
    "diagnostic-raw-colour-png-v1";

#if defined(CONFIG_INKOS_RSS_SERIAL_HARNESS) && \
    CONFIG_INKOS_RSS_SERIAL_HARNESS
constexpr const char *kRssHarnessFeedUrl = "https://sspai.com/feed";
constexpr size_t kRssHarnessMaximumLineBytes = 95;

bool sameStoredHome(const StoredHomeInfo &left,
                    const StoredHomeInfo &right) {
  return left.active == right.active && left.slot == right.slot &&
         left.archiveBytes == right.archiveBytes &&
         left.revision == right.revision &&
         left.archiveSha256 == right.archiveSha256 &&
         left.packageId == right.packageId &&
         left.entryUuid == right.entryUuid;
}

bool sameSettings(const DeviceSettings &left, const DeviceSettings &right) {
  return left.wifiSsid == right.wifiSsid &&
         left.wifiPassword == right.wifiPassword &&
         left.serverBaseUrl == right.serverBaseUrl &&
         left.orientationMode == right.orientationMode &&
         left.manualOrientation == right.manualOrientation &&
         left.fontLevel == right.fontLevel;
}

bool sameLocation(const Location &left, const Location &right) {
  return left.packageId == right.packageId &&
         left.documentUuid == right.documentUuid &&
         left.pageIndex == right.pageIndex &&
         left.embedded == right.embedded && left.stored == right.stored;
}
#endif

void logMainTaskStackWatermark(const char *phase) {
  ESP_LOGI(kTag, "app_main stack minimum free after %s: %u bytes", phase,
           static_cast<unsigned>(uxTaskGetStackHighWaterMark(nullptr)));
}

extern const uint8_t embeddedHomeStart[]
    asm("_binary_home_ink_start");
extern const uint8_t embeddedHomeEnd[] asm("_binary_home_ink_end");
extern const char embeddedVersionStart[]
    asm("_binary_home_version_json_start");
extern const char embeddedVersionEnd[]
    asm("_binary_home_version_json_end");

using JsonPtr = std::unique_ptr<cJSON, decltype(&cJSON_Delete)>;

bool fail(std::string &error, const std::string &message) {
  error = message;
  return false;
}

JsonPtr parseJson(const std::string &json) {
  return {cJSON_ParseWithLength(json.data(), json.size()), cJSON_Delete};
}

const char *jsonString(const cJSON *object, const char *key) {
  const cJSON *value = cJSON_GetObjectItemCaseSensitive(object, key);
  return cJSON_IsString(value) && value->valuestring ? value->valuestring
                                                     : nullptr;
}

uint32_t nextTelemetrySequence(uint32_t &sequence) {
  ++sequence;
  if (sequence == 0) ++sequence;
  return sequence;
}

const char *inputKindName(InputKind kind) {
  switch (kind) {
  case InputKind::Tap: return "tap";
  case InputKind::SwipeLeft: return "swipe-left";
  case InputKind::SwipeRight: return "swipe-right";
  case InputKind::SwipeUp: return "swipe-up";
  case InputKind::SwipeDown: return "swipe-down";
  case InputKind::SettingsHold: return "settings-hold";
  case InputKind::None: return "none";
  }
  return "invalid";
}

std::string telemetryReference(const std::string &value) {
  if (value.empty()) return "-";
  const std::string digest = sha256Hex(
      reinterpret_cast<const uint8_t *>(value.data()), value.size());
  return digest.size() >= 12 ? digest.substr(0, 12) : "hash-error";
}

bool jsonUint32(const cJSON *object, const char *key, uint32_t &result) {
  const cJSON *value = cJSON_GetObjectItemCaseSensitive(object, key);
  if (!cJSON_IsNumber(value) || value->valuedouble < 0 ||
      value->valuedouble > UINT32_MAX ||
      value->valuedouble != static_cast<double>(value->valueint)) {
    return false;
  }
  result = static_cast<uint32_t>(value->valuedouble);
  return true;
}

bool bodyMatches(const std::vector<uint8_t> &body, uint32_t expectedBytes,
                 const std::string &expectedSha, std::string &error) {
  if (body.size() != expectedBytes) {
    return fail(error, "Artifact Content-Length differs from its manifest");
  }
  if (sha256Hex(body.data(), body.size()) != expectedSha) {
    return fail(error, "Artifact failed SHA-256 verification");
  }
  return true;
}

bool textMatches(const std::string &body, uint32_t expectedBytes,
                 const std::string &expectedSha, std::string &error) {
  return bodyMatches(
      std::vector<uint8_t>(reinterpret_cast<const uint8_t *>(body.data()),
                           reinterpret_cast<const uint8_t *>(body.data()) +
                               body.size()),
      expectedBytes, expectedSha, error);
}

bool decodeBase64Url(std::string encoded, std::string &decoded,
                     std::string &error) {
  std::replace(encoded.begin(), encoded.end(), '-', '+');
  std::replace(encoded.begin(), encoded.end(), '_', '/');
  while (encoded.size() % 4 != 0) encoded.push_back('=');
  size_t required = 0;
  const int probe = mbedtls_base64_decode(
      nullptr, 0, &required,
      reinterpret_cast<const uint8_t *>(encoded.data()), encoded.size());
  if (probe != MBEDTLS_ERR_BASE64_BUFFER_TOO_SMALL && probe != 0) {
    return fail(error, "Render sidecar header is not base64url");
  }
  std::vector<uint8_t> bytes(required + 1, 0);
  size_t written = 0;
  if (mbedtls_base64_decode(
          bytes.data(), bytes.size(), &written,
          reinterpret_cast<const uint8_t *>(encoded.data()), encoded.size()) !=
      0) {
    return fail(error, "Could not decode render sidecar header");
  }
  decoded.assign(reinterpret_cast<const char *>(bytes.data()), written);
  return true;
}

bool validPngGeometry(const std::vector<uint8_t> &png, uint16_t width,
                      uint16_t height, PngFramePolicy policy,
                      std::string &error) {
  return validatePngFrame(png, width, height, policy, error);
}

std::string artifactHeadersProblem(const HttpResponse &response,
                                   const Manifest &manifest,
                                   const std::string &artifactSha,
                                   uint32_t artifactBytes) {
  const std::string lineage = response.header("x-ink-manifest-sha256");
  if (response.header("content-length").empty() ||
      response.advertisedLength != artifactBytes) {
    return "Server artifact omitted or changed its Content-Length";
  }
  if (response.header("x-ink-package-id") != manifest.packageId ||
      response.header("x-ink-package-revision") !=
          std::to_string(manifest.revision) ||
      lineage != manifest.sha256) {
    return "Server artifact crossed a manifest revision boundary";
  }
  if (response.header("x-ink-sha256") != artifactSha ||
      response.header("etag") != '"' + artifactSha + '"') {
    return "Server artifact identity headers differ from the manifest";
  }
  return {};
}

std::map<std::string, std::string> manifestHeaders(const Manifest &manifest) {
  return {{"If-Match", manifest.strongEtag}, {"Cache-Control", "no-store"}};
}

DisplayVariant transientVariant(const DisplayMeta &meta,
                                const std::string &id) {
  DisplayVariant variant;
  variant.id = id;
  variant.profileId = kProfileId;
  variant.profileVersion = kProfileVersion;
  variant.meta = meta;
  variant.width = meta.orientation == Orientation::Portrait ? 540 : 960;
  variant.height = meta.orientation == Orientation::Portrait ? 960 : 540;
  variant.rotation = meta.orientation == Orientation::Portrait ? 90 : 0;
  variant.pixelFormat = "gray4";
  variant.codec = "png";
  return variant;
}

std::string expectedVariantId(const DisplayMeta &meta) {
  const std::string font = meta.fontLevel < 0
                               ? "m" + std::to_string(-meta.fontLevel)
                               : "p" + std::to_string(meta.fontLevel);
  return std::string(kProfileId) + "." + orientationName(meta.orientation) +
         "." + (meta.invert ? "negative" : "normal") + ".font-" + font;
}

const char *collectionDocumentUuid(CollectionKind kind) {
  switch (kind) {
  case CollectionKind::Rss:
    return "4d82bf43-df69-43a2-bf73-2b77ccfe1001";
  case CollectionKind::Website:
    return "4d82bf43-df69-43a2-bf73-2b77ccfe1002";
  case CollectionKind::Images:
    return kRandomImageDocument;
  }
  return "4d82bf43-df69-43a2-bf73-2b77ccfe1002";
}

bool appActionForDocument(const std::string &uuid, std::string &action) {
  if (uuid == kRandomImageDocument) {
    action = kRandomImageAction;
    return true;
  }
  if (uuid == kBaiduMapDocument) {
    action = kBaiduMapAction;
    return true;
  }
  return false;
}

bool appDocumentForAction(const std::string &action,
                          const char *&documentUuid, const char *&title,
                          const char *&slug) {
  if (action == kRandomImageAction) {
    documentUuid = kRandomImageDocument;
    title = "图片播放";
    slug = "random-image";
    return true;
  }
  if (action == kBaiduMapAction) {
    documentUuid = kBaiduMapDocument;
    title = "附近地图";
    slug = "baidu-map";
    return true;
  }
  return false;
}

std::string newAppNonce() {
  std::array<uint8_t, 16> bytes{};
  esp_fill_random(bytes.data(), bytes.size());
  static constexpr char hex[] = "0123456789abcdef";
  std::string nonce(bytes.size() * 2, '0');
  for (size_t index = 0; index < bytes.size(); ++index) {
    nonce[index * 2] = hex[bytes[index] >> 4];
    nonce[index * 2 + 1] = hex[bytes[index] & 0x0f];
  }
  return nonce;
}

uint64_t appRequestedAtMs() {
  timeval wall{};
  gettimeofday(&wall, nullptr);
  const uint64_t wallMs = static_cast<uint64_t>(std::max<time_t>(0, wall.tv_sec)) *
                              1000ULL +
                          static_cast<uint64_t>(std::max<suseconds_t>(0, wall.tv_usec)) /
                              1000ULL;
  if (wallMs <= 4'102'444'800'000ULL) return wallMs;
  return static_cast<uint64_t>(std::max<int64_t>(0, esp_timer_get_time())) /
         1000ULL;
}

bool collectionKindForDocument(const std::string &uuid,
                               CollectionKind &kind) {
  for (const CollectionKind candidate : {CollectionKind::Rss,
                                         CollectionKind::Website}) {
    if (uuid == collectionDocumentUuid(candidate)) {
      kind = candidate;
      return true;
    }
  }
  // A pre-v2 runtime could leave this transient collection UUID in navigation
  // history. It now resolves to the unified network reader.
  if (uuid == "4d82bf43-df69-43a2-bf73-2b77ccfe1003") {
    kind = CollectionKind::Website;
    return true;
  }
  return false;
}

bool endsWith(const std::string &value, const std::string &suffix) {
  return value.size() >= suffix.size() &&
         value.compare(value.size() - suffix.size(), suffix.size(), suffix) ==
             0;
}

bool hasNoStore(const HttpResponse &response) {
  std::string value = response.header("cache-control");
  std::transform(value.begin(), value.end(), value.begin(), [](char character) {
    return static_cast<char>(
        std::tolower(static_cast<unsigned char>(character)));
  });
  size_t cursor = 0;
  while (cursor <= value.size()) {
    const size_t comma = value.find(',', cursor);
    size_t begin = cursor;
    size_t end = comma == std::string::npos ? value.size() : comma;
    while (begin < end && std::isspace(static_cast<unsigned char>(value[begin]))) {
      ++begin;
    }
    while (end > begin &&
           std::isspace(static_cast<unsigned char>(value[end - 1]))) {
      --end;
    }
    if (value.substr(begin, end - begin) == "no-store") return true;
    if (comma == std::string::npos) break;
    cursor = comma + 1;
  }
  return false;
}

bool hasContentType(const HttpResponse &response, const char *expected) {
  std::string value = response.header("content-type");
  const size_t semicolon = value.find(';');
  if (semicolon != std::string::npos) value.resize(semicolon);
  while (!value.empty() &&
         std::isspace(static_cast<unsigned char>(value.back()))) {
    value.pop_back();
  }
  size_t begin = 0;
  while (begin < value.size() &&
         std::isspace(static_cast<unsigned char>(value[begin]))) {
    ++begin;
  }
  value.erase(0, begin);
  std::transform(value.begin(), value.end(), value.begin(), [](char character) {
    return static_cast<char>(
        std::tolower(static_cast<unsigned char>(character)));
  });
  return value == expected;
}

bool refreshHintHeaderMatches(const HttpResponse &response,
                              const OnDemandFrame &frame,
                              std::string &error) {
  if (!refreshHintHeaderMatchesManifest(
          response.header("x-ink-refresh-hint"), frame.refreshHint)) {
    return fail(error,
                "Render refresh hint header differs from frame manifest");
  }
  return true;
}

bool sidecarTargetsPackaged(const Sidecar &sidecar, const Manifest &manifest,
                            std::string &error) {
  for (const auto &interaction : sidecar.interactions) {
    if (!findDocument(manifest, interaction.targetUuid)) {
      return fail(error, "Sidecar links a UUID outside the verified package");
    }
  }
  return true;
}

bool interactionsMatch(const OnDemandFrame &frame, const Sidecar &sidecar,
                       std::string &error) {
  if (frame.interactions.size() != sidecar.interactions.size()) {
    return fail(error, "Frame manifest and sidecar hitbox counts differ");
  }
  for (size_t index = 0; index < frame.interactions.size(); ++index) {
    const Interaction &left = frame.interactions[index];
    const Interaction &right = sidecar.interactions[index];
    if (left.contentPath != right.id ||
        left.contentPath != right.contentPath || left.label != right.label ||
        left.bounds.x != right.bounds.x || left.bounds.y != right.bounds.y ||
        left.bounds.width != right.bounds.width ||
        left.bounds.height != right.bounds.height ||
        left.targetUuid != right.targetUuid ||
        left.targetUrl != right.targetUrl) {
      return fail(error, "Frame manifest and sidecar hitboxes differ");
    }
  }
  return true;
}

void initializeSntp() {
  static bool initialized = false;
  if (!initialized) {
    esp_sntp_config_t config =
        ESP_NETIF_SNTP_DEFAULT_CONFIG_MULTIPLE(
            3, ESP_SNTP_SERVER_LIST("ntp.aliyun.com", "pool.ntp.org",
                                    "time.cloudflare.com"));
    config.start = true;
    config.smooth_sync = true;
    if (esp_netif_sntp_init(&config) == ESP_OK) initialized = true;
  }
  setenv("TZ", "CST-8", 1);
  tzset();
}

} // namespace

bool InkRuntime::begin(std::string &error) {
  if (!display_.begin(error)) return false;
  display_.showStatus("InkOS", "正在打开 InkOS 应用首页，请稍等…");
  if (!initializeSettingsStore(error) || !loadSettings(settings_, error) ||
      !initializeDeviceStorage(error) ||
      !loadCollections(collections_, error)) {
    display_.showStatus("设置错误", error);
    return false;
  }
  const size_t embeddedBytes = embeddedHomeEnd - embeddedHomeStart;
  size_t versionBytes = embeddedVersionEnd - embeddedVersionStart;
  if (versionBytes > 0 && embeddedVersionStart[versionBytes - 1] == '\0') {
    --versionBytes;
  }
  const std::string version(embeddedVersionStart, versionBytes);
  JsonPtr versionRoot = parseJson(version);
  const char *versionSchema =
      versionRoot ? jsonString(versionRoot.get(), "schemaVersion") : nullptr;
  const char *versionPackage =
      versionRoot ? jsonString(versionRoot.get(), "packageId") : nullptr;
  const char *versionEntry =
      versionRoot ? jsonString(versionRoot.get(), "entryUuid") : nullptr;
  const char *versionArchiveSha =
      versionRoot ? jsonString(versionRoot.get(), "archiveSha256") : nullptr;
  uint32_t versionArchiveBytes = 0;
  uint32_t versionRevision = 0;
  const std::string archiveSha =
      sha256Hex(embeddedHomeStart, embeddedBytes);
  if (!versionRoot || !versionSchema ||
      std::strcmp(versionSchema, "inkos.embedded-home/v1") != 0 ||
      !versionPackage || !isUuid(versionPackage) || !versionEntry ||
      !isUuid(versionEntry) || !versionArchiveSha ||
      !isLowerHexSha256(versionArchiveSha) ||
      !jsonUint32(versionRoot.get(), "archiveBytes", versionArchiveBytes) ||
      versionArchiveBytes != embeddedBytes ||
      !jsonUint32(versionRoot.get(), "revision", versionRevision) ||
      archiveSha != versionArchiveSha) {
    error = "Embedded home archive/version identity is inconsistent";
    display_.showStatus("内置首页损坏", error);
    return false;
  }
  if (!embeddedArchive_.open(embeddedHomeStart, embeddedBytes, error)) {
    display_.showStatus("内置首页损坏", error);
    return false;
  }
  std::string manifestJson;
  if (!embeddedArchive_.extractText("ink-manifest.json", manifestJson,
                                    kMaximumManifestBytes, error)) {
    display_.showStatus("内置首页损坏", error);
    return false;
  }
  const std::string manifestSha = sha256Hex(
      reinterpret_cast<const uint8_t *>(manifestJson.data()),
      manifestJson.size());
  if (!parseManifest(manifestJson, manifestSha, '"' + manifestSha + '"',
                     embeddedManifest_, error) ||
      embeddedManifest_.packageId != kHomePackageId ||
      embeddedManifest_.packageId != versionPackage ||
      embeddedManifest_.entryUuid != versionEntry ||
      embeddedManifest_.revision != versionRevision) {
    if (error.empty()) error = "Embedded home package identity changed";
    display_.showStatus("内置首页损坏", error);
    return false;
  }
  ESP_LOGI(kTag,
           "embedded home archive=%u bytes archiveSha=%s manifestSha=%s metadata=%s",
           static_cast<unsigned>(embeddedBytes), archiveSha.c_str(),
           manifestSha.c_str(), version.c_str());

  StoredHomeInfo storedInfo;
  std::string storedError;
  bool homeActivated = false;
  if (loadStoredHomeInfo(storedInfo, storedError) && storedInfo.active) {
    homeActivated = activateLatestStoredHome(storedError);
    if (!homeActivated) {
      ESP_LOGW(kTag, "uploaded home rejected; using embedded fallback: %s",
               storedError.c_str());
    }
  } else if (!storedError.empty()) {
    ESP_LOGW(kTag, "uploaded home record rejected: %s", storedError.c_str());
  }
  error.clear();
  if (!homeActivated && !activateEmbeddedHome(error)) {
    display_.showStatus("内置首页不可用", error);
    return false;
  }

  if (!initializeWifi(error)) {
    ESP_LOGW(kTag, "Wi-Fi initialization failed: %s", error.c_str());
    error.clear();
  } else {
    configureNetwork();
  }
  initialized_ = true;
#if defined(CONFIG_INKOS_RSS_SERIAL_HARNESS) && \
    CONFIG_INKOS_RSS_SERIAL_HARNESS
  std::string harnessError;
  if (!initializeRssSerialHarness(harnessError)) {
    ESP_LOGE(kTag, "RSS_HARNESS_DISABLED code=usb-init");
  }
#endif
  logMainTaskStackWatermark("boot initialization");
  return true;
}

bool InkRuntime::loadEmbeddedHome(FrameTransaction &result,
                                  std::string &error) {
  DisplayMeta requested = displayMeta();
  if (const DisplayVariant *available =
          selectVariantWithBaseFallback(embeddedManifest_, requested)) {
    requested = available->meta;
  }
  return loadEmbedded(embeddedManifest_.entryUuid, 0, requested, result, error);
}

bool InkRuntime::loadEmbedded(const std::string &documentUuid,
                              uint16_t pageIndex, const DisplayMeta &meta,
                              FrameTransaction &result, std::string &error) {
  return loadPackaged(embeddedArchive_, embeddedManifest_, documentUuid,
                      pageIndex, meta, true, false, result, error);
}

bool InkRuntime::loadStoredHome(FrameTransaction &result,
                                std::string &error) {
  if (!storedMapping_.bytes) return fail(error, "No uploaded home is mapped");
  return loadStored(storedManifest_.entryUuid, 0, displayMeta(), result, error);
}

bool InkRuntime::loadStored(const std::string &documentUuid,
                            uint16_t pageIndex, const DisplayMeta &meta,
                            FrameTransaction &result, std::string &error) {
  if (!storedMapping_.bytes) return fail(error, "No uploaded home is mapped");
  DisplayMeta availableMeta = meta;
  if (const DisplayVariant *available =
          selectVariantWithBaseFallback(storedManifest_, meta)) {
    availableMeta = available->meta;
  }
  return loadPackaged(storedArchive_, storedManifest_, documentUuid, pageIndex,
                      availableMeta, false, true, result, error);
}

bool InkRuntime::loadPackaged(InkArchive &archive, const Manifest &manifest,
                              const std::string &documentUuid,
                              uint16_t pageIndex, const DisplayMeta &meta,
                              bool embedded, bool stored,
                              FrameTransaction &result,
                              std::string &error) {
  const DisplayVariant *variant = selectVariant(manifest, meta);
  const DocumentRef *document = findDocument(manifest, documentUuid);
  if (!variant || !document) {
    return fail(error, !variant ? "Local home lacks this display tuple"
                                : "Local home lacks the target document");
  }
  const auto frameSet = std::find_if(
      document->variants.begin(), document->variants.end(),
      [variant](const VariantPages &candidate) {
        return candidate.variantId == variant->id;
      });
  const PageRef *page = findPage(*document, variant->id, pageIndex);
  if (!page || frameSet == document->variants.end()) {
    return fail(error, "Local home lacks the target page");
  }
  std::string documentJson;
  std::string sidecarJson;
  std::vector<uint8_t> frame;
  if (!archive.extractText(document->documentPath, documentJson,
                           kMaximumDocumentBytes, error) ||
      !textMatches(documentJson, document->documentBytes,
                   document->documentSha256, error) ||
      !validateDocumentEnvelope(documentJson, *document, error) ||
      !archive.extractText(page->sidecarPath, sidecarJson,
                           kMaximumSidecarBytes, error) ||
      !textMatches(sidecarJson, page->sidecarBytes, page->sidecarSha256,
                   error) ||
      !archive.extract(
          page->sourceImage.present ? page->sourceImage.path : page->imagePath,
          frame,
          page->sourceImage.present ? kMaximumSourceImageBytes
                                    : kMaximumFrameBytes,
          error) ||
      !bodyMatches(frame,
                   page->sourceImage.present ? page->sourceImage.bytes
                                             : page->imageBytes,
                   page->sourceImage.present ? page->sourceImage.sha256
                                             : page->imageSha256,
                   error)) {
    return false;
  }
  Sidecar sidecar;
  if (!parseSidecar(sidecarJson, manifest.packageId, documentUuid,
                    pageIndex, variant->id, sidecar, error) ||
      sidecar.imageSha256 != page->imageSha256 ||
      sidecar.imagePath != page->imagePath ||
      !(sidecar.sourceImage == page->sourceImage) ||
      sidecar.parentUuid != document->parentUuid ||
      sidecar.pageCount != frameSet->pages.size() ||
      sidecar.width != variant->width || sidecar.height != variant->height ||
      !sidecarTargetsPackaged(sidecar, manifest, error) ||
      !(page->sourceImage.present
            ? validateSourceJpeg(frame, page->sourceImage.width,
                                 page->sourceImage.height, error)
            : validPngGeometry(frame, variant->width, variant->height,
                               PngFramePolicy::PackageGray4, error))) {
    if (error.empty()) error = "Local sidecar does not match its frame";
    return false;
  }
  result.manifest = manifest;
  result.documentJson = std::move(documentJson);
  result.png = std::move(frame);
  result.sidecar = std::move(sidecar);
  result.contentType = document->kind;
  result.renderProfile =
      page->sourceImage.present ? FrameRenderProfile::PaperS3PhotoGray16
                                : FrameRenderProfile::Generic;
  result.refreshHint = FrameRefreshHint::LegacyUnspecified;
  result.embedded = embedded;
  result.stored = stored;
  return true;
}

bool InkRuntime::activateEmbeddedHome(std::string &error) {
  FrameTransaction home;
  if (!loadEmbeddedHome(home, error) ||
      !activate(std::move(home),
                {embeddedManifest_.packageId, embeddedManifest_.entryUuid, 0,
                 true, false},
                false, error)) {
    return false;
  }
  backHistory_.clear();
  forwardHistory_.clear();
  if (storedMapping_.handle) {
    unmapStoredHome(storedMapping_);
    storedArchive_ = {};
    storedManifest_ = {};
  }
  return true;
}

bool InkRuntime::activateLatestStoredHome(std::string &error) {
  StoredHomeMapping candidateMapping;
  InkArchive candidateArchive;
  Manifest candidateManifest;
  if (!mapStoredHome(candidateMapping, candidateArchive, candidateManifest,
                     error)) {
    return false;
  }
  StoredHomeMapping oldMapping = storedMapping_;
  InkArchive oldArchive = std::move(storedArchive_);
  Manifest oldManifest = std::move(storedManifest_);
  storedMapping_ = candidateMapping;
  candidateMapping = {};
  storedArchive_ = std::move(candidateArchive);
  storedManifest_ = std::move(candidateManifest);

  FrameTransaction home;
  const bool activated =
      loadStoredHome(home, error) &&
      activate(std::move(home),
               {storedManifest_.packageId, storedManifest_.entryUuid, 0,
                false, true},
               false, error);
  if (!activated) {
    unmapStoredHome(storedMapping_);
    storedMapping_ = oldMapping;
    storedArchive_ = std::move(oldArchive);
    storedManifest_ = std::move(oldManifest);
    return false;
  }
  if (oldMapping.handle) unmapStoredHome(oldMapping);
  backHistory_.clear();
  forwardHistory_.clear();
  ESP_LOGI(kTag,
           "uploaded home activated slot=%c bytes=%u package=%s revision=%u sha=%s",
           storedMapping_.info.slot,
           static_cast<unsigned>(storedMapping_.info.archiveBytes),
           storedMapping_.info.packageId.c_str(),
           static_cast<unsigned>(storedMapping_.info.revision),
           storedMapping_.info.archiveSha256.c_str());
  return true;
}

bool InkRuntime::renderCollection(CollectionKind kind, uint16_t pageIndex,
                                  const DisplayMeta &meta,
                                  FrameTransaction &result,
                                  std::string &error) {
  if (!networkReady_ || settings_.serverBaseUrl.empty()) {
    return fail(error, "Collection rendering requires the configured server");
  }
  const char *uuid = collectionDocumentUuid(kind);
  const char *title = collectionTitle(kind);
  const auto &entries = collectionEntries(collections_, kind);

  cJSON *request = cJSON_CreateObject();
  cJSON *document = cJSON_CreateObject();
  cJSON *source = cJSON_CreateObject();
  cJSON *content = cJSON_CreateObject();
  cJSON *page = cJSON_CreateObject();
  cJSON *display = cJSON_CreateObject();
  if (!request || !document || !source || !content || !page || !display) {
    if (request) cJSON_Delete(request);
    if (document) cJSON_Delete(document);
    if (source) cJSON_Delete(source);
    if (content) cJSON_Delete(content);
    if (page) cJSON_Delete(page);
    if (display) cJSON_Delete(display);
    return fail(error, "Cannot allocate collection render request");
  }
  cJSON_AddStringToObject(document, "schemaVersion", "inkos.document/v1");
  cJSON_AddStringToObject(document, "uuid", uuid);
  cJSON_AddStringToObject(source, "title", title);
  cJSON_AddItemToObject(document, "source", source);
  cJSON_AddStringToObject(content, "schemaVersion", "inkos.content/v2");
  cJSON_AddStringToObject(content, "id", uuid);
  cJSON_AddNumberToObject(content, "revision",
                          std::max<uint32_t>(1, collections_.revision));
  cJSON_AddStringToObject(content, "locale", "zh-CN");
  if (entries.empty()) {
    cJSON_AddStringToObject(page, "kind", "detail");
    cJSON_AddStringToObject(page, "layout", "article");
    cJSON_AddStringToObject(page, "title", title);
    cJSON_AddStringToObject(
        page, "summary",
        "这个列表还是空的，请在设备管理后台添加 HTTPS 地址。");
    cJSON *blocks = cJSON_AddArrayToObject(page, "content");
    cJSON *paragraph = cJSON_CreateObject();
    cJSON_AddStringToObject(paragraph, "type", "paragraph");
    cJSON_AddStringToObject(
        paragraph, "text",
        "长按屏幕上部打开设置，查看同一局域网内的管理后台地址。");
    cJSON_AddItemToArray(blocks, paragraph);
  } else {
    cJSON_AddStringToObject(page, "kind", "list");
    cJSON_AddStringToObject(page, "layout", "list");
    cJSON_AddStringToObject(page, "title", title);
    cJSON_AddStringToObject(
        page, "description",
        kind == CollectionKind::Rss
            ? "选择订阅源；服务器会抓取并转换为适合墨水屏阅读的内容。"
            : "选择设备中保存的地址，由服务器抓取和渲染。");
    cJSON *items = cJSON_AddArrayToObject(page, "items");
    for (const auto &entry : entries) {
      cJSON *item = cJSON_CreateObject();
      cJSON_AddStringToObject(item, "id", entry.id.c_str());
      cJSON_AddStringToObject(item, "title", entry.label.c_str());
      cJSON_AddStringToObject(item, "summary", entry.url.c_str());
      cJSON *link = cJSON_AddObjectToObject(item, "link");
      cJSON_AddStringToObject(link, "label", "打开");
      cJSON *target = cJSON_AddObjectToObject(link, "target");
      cJSON_AddStringToObject(target, "kind", "url");
      cJSON_AddStringToObject(target, "url", entry.url.c_str());
      cJSON_AddItemToArray(items, item);
    }
  }
  cJSON_AddItemToObject(content, "page", page);
  cJSON_AddItemToObject(document, "content", content);
  cJSON_AddItemToObject(request, "document", document);
  cJSON_AddStringToObject(request, "profileId", kProfileId);
  cJSON_AddStringToObject(display, "orientation",
                          orientationName(meta.orientation));
  cJSON_AddNumberToObject(display, "fontLevel", meta.fontLevel);
  cJSON_AddBoolToObject(display, "invert", meta.invert);
  cJSON_AddItemToObject(request, "displayMeta", display);
  cJSON_AddNumberToObject(request, "pageIndex", pageIndex);
  char *printed = cJSON_PrintUnformatted(request);
  cJSON_Delete(request);
  if (!printed) return fail(error, "Cannot serialize collection render request");
  const std::string body(printed);
  cJSON_free(printed);

  HttpResponse response;
  if (!http_.postJson(joinServerUrl(settings_.serverBaseUrl,
                                    std::string(kApiBase) + "/render"),
                      body, {}, kMaximumFrameBytes, response, error)) {
    return false;
  }
  if (response.status != 200 || !hasContentType(response, "image/png") ||
      response.header("content-length").empty() ||
      response.advertisedLength !=
          static_cast<int64_t>(response.body.size())) {
    return fail(error, "Collection render HTTP/Content-Length validation failed");
  }
  const std::string calculatedSha =
      sha256Hex(response.body.data(), response.body.size());
  if (response.header("etag") != '"' + calculatedSha + '"') {
    return fail(error, "Collection PNG failed ETag/SHA-256 verification");
  }
  std::string frameJson;
  std::string sidecarJson;
  std::string warningsJson;
  if (!decodeBase64Url(response.header("x-ink-frame-manifest"), frameJson,
                       error) ||
      !decodeBase64Url(response.header("x-ink-sidecar"), sidecarJson, error) ||
      !decodeBase64Url(response.header("x-ink-warnings"), warningsJson,
                       error)) {
    return false;
  }
  OnDemandFrame frame;
  std::vector<std::string> warnings;
  if (!parseOnDemandFrame(frameJson, frame, error) ||
      !parseWarningList(warningsJson, warnings, error) ||
      !refreshHintHeaderMatches(response, frame, error)) {
    return false;
  }
  const uint16_t actualPage = static_cast<uint16_t>(
      std::min<uint32_t>(pageIndex, frame.pageCount - 1));
  const std::string variantId = expectedVariantId(meta);
  Sidecar sidecar;
  if (!parseSidecar(sidecarJson, kOnlinePackageId, uuid, actualPage,
                    variantId, sidecar, error)) {
    return false;
  }
  DisplayVariant variant = transientVariant(meta, variantId);
  Manifest manifest;
  manifest.packageId = kOnlinePackageId;
  manifest.entryUuid = uuid;
  manifest.title = title;
  manifest.revision = std::max<uint32_t>(1, collections_.revision);
  manifest.sha256 = calculatedSha;
  manifest.strongEtag = '"' + calculatedSha + '"';
  manifest.variants.push_back(variant);
  DocumentRef documentRef;
  documentRef.uuid = uuid;
  documentRef.title = title;
  documentRef.kind = entries.empty() ? "detail" : "list";
  manifest.documents.push_back(std::move(documentRef));
  const std::string expectedSuffix = "/" + variantId + "/" + uuid + "/";
  if (frame.documentId != uuid ||
      frame.documentRevision != std::max<uint32_t>(1, collections_.revision) ||
      frame.contentType != (entries.empty() ? "detail" : "list") ||
      frame.profileVersion != kProfileVersion ||
      frame.width != variant.width || frame.height != variant.height ||
      frame.rotation != variant.rotation ||
      frame.meta.orientation != meta.orientation ||
      frame.meta.fontLevel != meta.fontLevel || frame.meta.invert != meta.invert ||
      frame.pageIndex != actualPage || frame.payloadBytes != response.body.size() ||
      frame.sha256 != calculatedSha || warnings != frame.warnings ||
      sidecar.pageCount != frame.pageCount ||
      sidecar.imageSha256 != calculatedSha ||
      sidecar.imagePath.find(expectedSuffix) == std::string::npos ||
      sidecar.width != variant.width || sidecar.height != variant.height ||
      !interactionsMatch(frame, sidecar, error) ||
      !sidecarTargetsPackaged(sidecar, manifest, error) ||
      !validPngGeometry(response.body, variant.width, variant.height,
                        PngFramePolicy::PackageGray4, error)) {
    if (error.empty()) error = "Collection frame/sidecar does not match request";
    return false;
  }
  result.manifest = std::move(manifest);
  result.documentJson = body;
  result.png = std::move(response.body);
  result.sidecar = std::move(sidecar);
  result.contentType = frame.contentType;
  result.renderProfile = FrameRenderProfile::Generic;
  result.refreshHint = dynamicFrameRefreshHint(frame.refreshHint);
  result.embedded = false;
  result.stored = false;
  return true;
}

bool InkRuntime::renderApp(const std::string &action, uint16_t pageIndex,
                           const DisplayMeta &meta, FrameTransaction &result,
                           bool freshIdentity, std::string &error) {
  if (!networkReady_ || settings_.serverBaseUrl.empty()) {
    return fail(error, "App rendering requires the configured server");
  }
  const char *documentUuid = nullptr;
  const char *title = nullptr;
  const char *slug = nullptr;
  if (!appDocumentForAction(action, documentUuid, title, slug)) {
    return fail(error, "App action is not in the exact client whitelist");
  }
  const size_t pageCount = action == kRandomImageAction
                               ? collections_.images.size()
                               : static_cast<size_t>(1);
  const char *expectedImageMode =
      action == kRandomImageAction ? kPhotoPaperS3Gray16ImageMode
                                   : kDiagnosticRawColourImageMode;
  const FrameRenderProfile renderProfile =
      action == kRandomImageAction
          ? FrameRenderProfile::PaperS3PhotoGray16
          : FrameRenderProfile::Generic;
  if (pageCount == 0 || pageCount > kMaximumImageCollectionEntries ||
      pageIndex >= pageCount) {
    return fail(error, "App page is outside the configured image collection");
  }

  const bool newIdentity = freshIdentity || activeAppAction_ != action ||
                           activeAppNonce_.empty();
  const std::string nonce = newIdentity ? newAppNonce() : activeAppNonce_;
  const uint64_t requestedAtMs =
      newIdentity ? appRequestedAtMs() : activeAppRequestedAtMs_;

  cJSON *request = cJSON_CreateObject();
  cJSON *display = cJSON_CreateObject();
  if (!request || !display) {
    if (request) cJSON_Delete(request);
    if (display) cJSON_Delete(display);
    return fail(error, "Cannot allocate app render request");
  }
  cJSON_AddStringToObject(request, "action", action.c_str());
  cJSON_AddStringToObject(request, "nonce", nonce.c_str());
  cJSON_AddNumberToObject(request, "requestedAtUnixMs",
                          static_cast<double>(requestedAtMs));
  cJSON_AddNumberToObject(request, "pageIndex", pageIndex);
  if (action == kRandomImageAction) {
    cJSON *images = cJSON_AddArrayToObject(request, "images");
    if (!images) {
      cJSON_Delete(display);
      cJSON_Delete(request);
      return fail(error, "Cannot allocate app image collection");
    }
    for (const auto &entry : collections_.images) {
      cJSON *image = cJSON_CreateObject();
      if (!image) {
        cJSON_Delete(display);
        cJSON_Delete(request);
        return fail(error, "Cannot allocate app image entry");
      }
      cJSON_AddStringToObject(image, "id", entry.id.c_str());
      cJSON_AddStringToObject(image, "label", entry.label.c_str());
      cJSON_AddStringToObject(image, "url", entry.url.c_str());
      cJSON_AddItemToArray(images, image);
    }
  }
  cJSON_AddStringToObject(display, "orientation",
                          orientationName(meta.orientation));
  cJSON_AddNumberToObject(display, "fontLevel", meta.fontLevel);
  cJSON_AddBoolToObject(display, "invert", meta.invert);
  cJSON_AddItemToObject(request, "displayMeta", display);
  char *printed = cJSON_PrintUnformatted(request);
  cJSON_Delete(request);
  if (!printed) return fail(error, "Cannot serialize app render request");
  const std::string body(printed);
  cJSON_free(printed);

  HttpResponse response;
  if (!http_.postJson(joinServerUrl(settings_.serverBaseUrl,
                                    std::string(kApiBase) + "/apps/execute"),
                      body, {{"Cache-Control", "no-store"}},
                      kMaximumFrameBytes, response, error)) {
    return false;
  }
  if (response.status != 200) {
    return fail(error, "App render HTTP status " +
                           std::to_string(response.status));
  }
  const std::string requestedAt = std::to_string(requestedAtMs);
  if (!hasContentType(response, "image/png") || !hasNoStore(response) ||
      response.header("content-length").empty() ||
      response.advertisedLength !=
          static_cast<int64_t>(response.body.size()) ||
      response.header("x-ink-app-action") != action ||
      response.header("x-ink-app-nonce") != nonce ||
      response.header("x-ink-app-requested-at") != requestedAt ||
      response.header("x-ink-app-page-index") !=
          std::to_string(pageIndex) ||
      response.header("x-ink-app-image-mode") != expectedImageMode) {
    return fail(error, "App render response identity/headers are incomplete");
  }
  const std::string calculatedSha =
      sha256Hex(response.body.data(), response.body.size());
  if (!isLowerHexSha256(calculatedSha) ||
      response.header("x-ink-sha256") != calculatedSha ||
      response.header("etag") != '"' + calculatedSha + '"') {
    return fail(error, "App rendered PNG failed SHA-256 verification");
  }

  std::string frameJson;
  std::string sidecarJson;
  std::string warningsJson;
  if (!decodeBase64Url(response.header("x-ink-frame-manifest"), frameJson,
                       error) ||
      !decodeBase64Url(response.header("x-ink-sidecar"), sidecarJson, error) ||
      !decodeBase64Url(response.header("x-ink-warnings"), warningsJson,
                       error)) {
    return false;
  }
  OnDemandFrame frame;
  std::vector<std::string> warnings;
  if (!parseOnDemandFrame(frameJson, frame, error) ||
      !parseWarningList(warningsJson, warnings, error) ||
      !refreshHintHeaderMatches(response, frame, error)) {
    return false;
  }
  const std::string variantId = expectedVariantId(meta);
  Sidecar sidecar;
  if (!parseSidecar(sidecarJson, kOnlinePackageId, documentUuid, pageIndex,
                    variantId, sidecar, error)) {
    return false;
  }
  DisplayVariant variant = transientVariant(meta, variantId);
  char pageName[16]{};
  std::snprintf(pageName, sizeof(pageName), "%04u.png", pageIndex);
  const std::string expectedPath =
      std::string("apps/") + slug + "/" + nonce + "/" + variant.id + "/" +
      documentUuid + "/" + pageName;
  if (frame.documentId != documentUuid ||
      frame.documentRevision > UINT32_MAX || frame.contentType != "image" ||
      frame.profileVersion != kProfileVersion || frame.width != variant.width ||
      frame.height != variant.height || frame.rotation != variant.rotation ||
      frame.meta.orientation != meta.orientation ||
      frame.meta.fontLevel != meta.fontLevel || frame.meta.invert != meta.invert ||
      frame.pageIndex != pageIndex || frame.pageCount != pageCount ||
      frame.payloadBytes != response.body.size() ||
      frame.sha256 != calculatedSha || warnings != frame.warnings ||
      !frame.interactions.empty() || !sidecar.parentUuid.empty() ||
      sidecar.pageIndex != pageIndex || sidecar.pageCount != pageCount ||
      sidecar.imageSha256 != calculatedSha ||
      sidecar.imagePath != expectedPath || sidecar.width != variant.width ||
      sidecar.height != variant.height || !sidecar.interactions.empty() ||
      !sidecar.dynamicRegions.empty() ||
      !interactionsMatch(frame, sidecar, error) ||
      !validPngGeometry(response.body, variant.width, variant.height,
                        PngFramePolicy::AppDiagnosticTrueColour, error)) {
    if (error.empty()) error = "App frame/sidecar does not match its request";
    return false;
  }

  Manifest manifest;
  manifest.packageId = kOnlinePackageId;
  manifest.entryUuid = documentUuid;
  manifest.title = title;
  manifest.revision = static_cast<uint32_t>(frame.documentRevision);
  manifest.sha256 = calculatedSha;
  manifest.strongEtag = '"' + calculatedSha + '"';
  manifest.variants.push_back(variant);
  DocumentRef document;
  document.uuid = documentUuid;
  document.title = title;
  document.kind = "image";
  manifest.documents.push_back(std::move(document));
  result.manifest = std::move(manifest);
  result.documentJson = body;
  result.png = std::move(response.body);
  result.sidecar = std::move(sidecar);
  result.contentType = frame.contentType;
  result.renderProfile = renderProfile;
  result.refreshHint = dynamicFrameRefreshHint(frame.refreshHint);
  result.embedded = false;
  result.stored = false;
  ESP_LOGI(kTag,
           "APP_FRAME action=%s page=%u/%u image_mode=%s bytes=%u "
           "profile=%s",
           action.c_str(), static_cast<unsigned>(pageIndex + 1),
           static_cast<unsigned>(pageCount), expectedImageMode,
           static_cast<unsigned>(result.png.size()),
           renderProfile == FrameRenderProfile::PaperS3PhotoGray16
               ? "papers3-photo-gray16"
               : "generic");
  if (newIdentity) {
    activeAppAction_ = action;
    activeAppNonce_ = nonce;
    activeAppRequestedAtMs_ = requestedAtMs;
  }
  return true;
}

bool InkRuntime::fetchManifest(const std::string &packageId, Manifest &result,
                               bool cacheBypass, std::string &error) {
  if (!networkReady_ || settings_.serverBaseUrl.empty() ||
      !isUuid(packageId)) {
    return fail(error, "Renderer service is not connected");
  }
  HttpResponse response;
  std::map<std::string, std::string> headers;
  if (cacheBypass) headers["Cache-Control"] = "no-store";
  const std::string url = joinServerUrl(
      settings_.serverBaseUrl,
      std::string(kApiBase) + "/packages/" + packageId + "/manifest");
  if (!http_.get(url, headers, kMaximumManifestBytes, response, error)) {
    return false;
  }
  if (response.status != 200) {
    return fail(error, "Manifest HTTP status " +
                           std::to_string(response.status));
  }
  const std::string json = response.text();
  const std::string sha = sha256Hex(response.body.data(), response.body.size());
  if (!parseManifest(json, sha, response.header("etag"), result, error) ||
      result.packageId != packageId || !hasContentType(response, "application/json") ||
      !artifactHeadersProblem(response, result, sha,
                              static_cast<uint32_t>(response.body.size()))
           .empty()) {
    if (error.empty()) error = "Server returned a different package manifest";
    return false;
  }
  return true;
}

bool InkRuntime::renderOnline(const Manifest &manifest,
                              const DocumentRef &document,
                              uint64_t documentRevision, uint16_t pageIndex,
                              const DisplayMeta &meta, FrameTransaction &result,
                              bool &revisionChanged, std::string &error) {
  revisionChanged = false;
  cJSON *root = cJSON_CreateObject();
  cJSON *display = cJSON_CreateObject();
  if (!root || !display) {
    if (root) cJSON_Delete(root);
    if (display) cJSON_Delete(display);
    return fail(error, "Cannot allocate online render request");
  }
  cJSON_AddStringToObject(root, "documentUuid", document.uuid.c_str());
  cJSON_AddStringToObject(root, "manifestSha256", manifest.sha256.c_str());
  cJSON_AddStringToObject(display, "orientation",
                          orientationName(meta.orientation));
  cJSON_AddNumberToObject(display, "fontLevel", meta.fontLevel);
  cJSON_AddBoolToObject(display, "invert", meta.invert);
  cJSON_AddItemToObject(root, "displayMeta", display);
  cJSON_AddNumberToObject(root, "pageIndex", pageIndex);
  char *printed = cJSON_PrintUnformatted(root);
  cJSON_Delete(root);
  if (!printed) return fail(error, "Cannot serialize online render request");
  const std::string body(printed);
  cJSON_free(printed);

  HttpResponse response;
  const std::string url = joinServerUrl(
      settings_.serverBaseUrl,
      std::string(kApiBase) + "/packages/" + manifest.packageId + "/render");
  if (!http_.postJson(url, body, manifestHeaders(manifest), kMaximumFrameBytes,
                      response, error)) {
    return false;
  }
  if (response.status == 412) {
    revisionChanged = true;
    return fail(error, "PACKAGE_REVISION_CHANGED");
  }
  if (response.status != 200) {
    return fail(error, "Online render HTTP status " +
                           std::to_string(response.status) + ": " +
                           response.text());
  }
  if (!hasContentType(response, "image/png") || !hasNoStore(response) ||
      response.header("content-length").empty() ||
      response.header("x-ink-package-id") != manifest.packageId ||
      response.header("x-ink-package-revision") !=
          std::to_string(manifest.revision) ||
      response.header("x-ink-manifest-sha256") != manifest.sha256 ||
      response.header("x-ink-requested-page-index") !=
          std::to_string(pageIndex)) {
    return fail(error, "Online render response lineage/headers are incomplete");
  }
  const std::string calculatedSha =
      sha256Hex(response.body.data(), response.body.size());
  if (!isLowerHexSha256(calculatedSha) ||
      response.header("x-ink-sha256") != calculatedSha ||
      response.header("etag") != '"' + calculatedSha + '"') {
    return fail(error, "Online rendered PNG failed SHA-256 verification");
  }
  std::string frameJson;
  std::string sidecarJson;
  std::string warningsJson;
  if (!decodeBase64Url(response.header("x-ink-frame-manifest"), frameJson,
                       error) ||
      !decodeBase64Url(response.header("x-ink-sidecar"), sidecarJson, error) ||
      !decodeBase64Url(response.header("x-ink-warnings"), warningsJson,
                       error)) {
    return false;
  }
  OnDemandFrame frame;
  std::vector<std::string> warnings;
  if (!parseOnDemandFrame(frameJson, frame, error) ||
      !parseWarningList(warningsJson, warnings, error) ||
      !refreshHintHeaderMatches(response, frame, error)) {
    return false;
  }
  const std::string variantId = expectedVariantId(meta);
  const uint16_t expectedPage = static_cast<uint16_t>(
      std::min<uint32_t>(pageIndex, frame.pageCount - 1));
  Sidecar sidecar;
  if (!parseSidecar(sidecarJson, manifest.packageId, document.uuid,
                    expectedPage, variantId, sidecar, error)) {
    return false;
  }
  DisplayVariant variant = transientVariant(meta, variantId);
  char pageName[16]{};
  std::snprintf(pageName, sizeof(pageName), "%04u.png", expectedPage);
  const std::string expectedPathSuffix =
      "/" + variant.id + "/" + document.uuid + "/" + pageName;
  if (frame.documentId != document.uuid ||
      frame.documentRevision != documentRevision ||
      frame.contentType != document.kind || frame.profileVersion != kProfileVersion ||
      frame.width != variant.width || frame.height != variant.height ||
      frame.rotation != variant.rotation ||
      frame.meta.orientation != meta.orientation ||
      frame.meta.fontLevel != meta.fontLevel || frame.meta.invert != meta.invert ||
      frame.pageIndex != expectedPage ||
      frame.payloadBytes != response.body.size() ||
      frame.sha256 != calculatedSha || warnings != frame.warnings ||
      response.header("x-ink-actual-page-index") !=
          std::to_string(frame.pageIndex) ||
      sidecar.parentUuid != document.parentUuid ||
      sidecar.pageIndex != frame.pageIndex ||
      sidecar.pageCount != frame.pageCount ||
      sidecar.imageSha256 != calculatedSha ||
      !endsWith(sidecar.imagePath, expectedPathSuffix) ||
      sidecar.width != variant.width || sidecar.height != variant.height ||
      !interactionsMatch(frame, sidecar, error) ||
      !sidecarTargetsPackaged(sidecar, manifest, error) ||
      !validPngGeometry(response.body, variant.width, variant.height,
                        PngFramePolicy::PackageGray4, error)) {
    if (error.empty()) {
      error = "Online render frame/sidecar does not match its request";
    }
    return false;
  }
  result.manifest = manifest;
  if (!selectVariant(result.manifest, meta)) {
    result.manifest.variants.push_back(std::move(variant));
  }
  result.png = std::move(response.body);
  result.sidecar = std::move(sidecar);
  result.contentType = frame.contentType;
  result.renderProfile = FrameRenderProfile::Generic;
  result.refreshHint = dynamicFrameRefreshHint(frame.refreshHint);
  result.embedded = false;
  return true;
}

bool InkRuntime::loadOnline(const std::string &packageId,
                            const std::string &documentUuid, uint16_t pageIndex,
                            const DisplayMeta &meta, FrameTransaction &result,
                            std::string &error,
                            uint8_t revisionRetriesRemaining,
                            const Manifest *verifiedManifest) {
  // Package-internal navigation already owns a manifest whose strong ETag and
  // every artifact digest were verified when the current frame was activated.
  // Re-downloading and parsing the same (potentially large) manifest while the
  // active transaction is still resident roughly doubles the navigation heap
  // peak. RSS archives are especially susceptible because a feed, article
  // pages and full-screen image children all share one manifest. Reuse that
  // immutable snapshot and let If-Match detect a newer published revision.
  Manifest fetchedManifest;
  if (!verifiedManifest) {
    if (!fetchManifest(packageId, fetchedManifest, true, error)) return false;
    verifiedManifest = &fetchedManifest;
  } else if (verifiedManifest->packageId != packageId) {
    return fail(error, "Verified manifest belongs to a different package");
  }
  const Manifest &manifest = *verifiedManifest;
  const DocumentRef *document = findDocument(manifest, documentUuid);
  if (!document) return fail(error, "Target UUID is absent from the manifest");

  HttpResponse documentResponse;
  const std::string documentUrl = joinServerUrl(
      settings_.serverBaseUrl,
      std::string(kApiBase) + "/packages/" + manifest.packageId +
          "/documents/" + document->uuid);
  if (!http_.get(documentUrl, manifestHeaders(manifest), kMaximumDocumentBytes,
                 documentResponse, error)) {
    return false;
  }
  if (documentResponse.status == 412) {
    if (revisionRetriesRemaining > 0) {
      ESP_LOGW(kTag,
               "NAV_RETRY phase=document id=%u code=REVISION_CHANGED "
               "pkg=%s doc=%s remaining=%u manifest_ref=%s",
               static_cast<unsigned>(navigationSequence_), packageId.c_str(),
               documentUuid.c_str(), revisionRetriesRemaining,
               telemetryReference(manifest.sha256).c_str());
      return loadOnline(packageId, documentUuid, pageIndex, meta, result, error,
                        revisionRetriesRemaining - 1);
    }
    return fail(error, "Package kept changing while reading the document");
  }
  if (documentResponse.status != 200) {
    return fail(error, "Document HTTP status " +
                           std::to_string(documentResponse.status));
  }
  const std::string lineageProblem =
      artifactHeadersProblem(documentResponse, manifest,
                             document->documentSha256,
                             document->documentBytes);
  const std::string documentJson = documentResponse.text();
  uint64_t documentRevision = 0;
  if (!lineageProblem.empty() ||
      !hasContentType(documentResponse, "application/json") ||
      !bodyMatches(documentResponse.body, document->documentBytes,
                   document->documentSha256, error) ||
      !validateDocumentEnvelope(documentJson, *document, error,
                                &documentRevision)) {
    if (!lineageProblem.empty()) error = lineageProblem;
    if (revisionRetriesRemaining > 0) {
      ESP_LOGW(kTag,
               "NAV_RETRY phase=document-integrity pkg=%s doc=%s remaining=%u "
               "id=%u manifest_ref=%s code=%s",
               packageId.c_str(), documentUuid.c_str(),
               revisionRetriesRemaining,
               static_cast<unsigned>(navigationSequence_),
               telemetryReference(manifest.sha256).c_str(),
               navigationFailureCodeName(
                   classifyNavigationFailure(error)));
      error.clear();
      return loadOnline(packageId, documentUuid, pageIndex, meta, result, error,
                        revisionRetriesRemaining - 1);
    }
    return false;
  }
  // The validated JSON now lives in documentJson. Release its HTTP backing
  // store before allocating sidecar/frame state or copying a reused manifest.
  std::vector<uint8_t>().swap(documentResponse.body);

  const DisplayVariant *variant = selectVariant(manifest, meta);
  const auto renderRequestedPage = [&]() -> bool {
    bool revisionChanged = false;
    if (!renderOnline(manifest, *document, documentRevision, pageIndex, meta,
                      result,
                      revisionChanged, error)) {
      if (revisionChanged && revisionRetriesRemaining > 0) {
        ESP_LOGW(kTag,
                 "NAV_RETRY phase=render id=%u code=REVISION_CHANGED "
                 "pkg=%s doc=%s remaining=%u manifest_ref=%s",
                 static_cast<unsigned>(navigationSequence_),
                 packageId.c_str(), documentUuid.c_str(),
                 revisionRetriesRemaining,
                 telemetryReference(manifest.sha256).c_str());
        return loadOnline(packageId, documentUuid, pageIndex, meta, result,
                          error, revisionRetriesRemaining - 1);
      }
      return false;
    }
    result.documentJson = documentJson;
    return true;
  };
  if (!variant) return renderRequestedPage();
  const VariantPages *pageSet = nullptr;
  for (const auto &candidate : document->variants) {
    if (candidate.variantId == variant->id) pageSet = &candidate;
  }
  if (!pageSet || pageSet->pages.empty()) {
    // On-demand rendering appends the requested display tuple to the active
    // manifest so later pages can reuse it. That top-level tuple does not mean
    // every sibling document has pre-rendered frames for it: the embedded home
    // package, for example, carries only font-p0 frames. Fall back to the
    // package render endpoint exactly as we do when the tuple is absent.
    return renderRequestedPage();
  }
  pageIndex = std::min<uint16_t>(pageIndex, pageSet->pages.size() - 1);
  const PageRef &page = pageSet->pages[pageIndex];
  const std::string frameBase = std::string(kApiBase) + "/packages/" +
                                manifest.packageId + "/frames/" + variant->id +
                                "/" + document->uuid + "/" +
                                std::to_string(pageIndex);
  HttpResponse sidecarResponse;
  HttpResponse frameResponse;
  if (!http_.get(joinServerUrl(settings_.serverBaseUrl, frameBase + "/sidecar"),
                 manifestHeaders(manifest), kMaximumSidecarBytes,
                 sidecarResponse, error)) {
    return false;
  }
  if (sidecarResponse.status == 412) {
    if (revisionRetriesRemaining > 0) {
      ESP_LOGW(kTag,
               "NAV_RETRY phase=sidecar id=%u code=REVISION_CHANGED "
               "pkg=%s doc=%s remaining=%u manifest_ref=%s",
               static_cast<unsigned>(navigationSequence_), packageId.c_str(),
               documentUuid.c_str(), revisionRetriesRemaining,
               telemetryReference(manifest.sha256).c_str());
      return loadOnline(packageId, documentUuid, pageIndex, meta, result, error,
                        revisionRetriesRemaining - 1);
    }
    return fail(error, "Package kept changing while reading the sidecar");
  }
  if (sidecarResponse.status != 200 ||
      !hasContentType(sidecarResponse, "application/json") ||
      !artifactHeadersProblem(sidecarResponse, manifest,
                              page.sidecarSha256, page.sidecarBytes)
           .empty() ||
      !bodyMatches(sidecarResponse.body, page.sidecarBytes, page.sidecarSha256,
                   error)) {
    if (error.empty()) {
      error = "Sidecar HTTP/integrity failure " +
              std::to_string(sidecarResponse.status);
    }
    if (revisionRetriesRemaining > 0) {
      ESP_LOGW(kTag,
               "NAV_RETRY phase=sidecar-integrity pkg=%s doc=%s remaining=%u "
               "id=%u manifest_ref=%s code=%s",
               packageId.c_str(), documentUuid.c_str(),
               revisionRetriesRemaining,
               static_cast<unsigned>(navigationSequence_),
               telemetryReference(manifest.sha256).c_str(),
               navigationFailureCodeName(
                   classifyNavigationFailure(error)));
      error.clear();
      return loadOnline(packageId, documentUuid, pageIndex, meta, result, error,
                        revisionRetriesRemaining - 1);
    }
    return false;
  }
  Sidecar sidecar;
  if (!parseSidecar(sidecarResponse.text(), manifest.packageId, document->uuid,
                    pageIndex, variant->id, sidecar, error) ||
      sidecar.parentUuid != document->parentUuid ||
      sidecar.pageCount != pageSet->pages.size() ||
      sidecar.imagePath != page.imagePath ||
      sidecar.imageSha256 != page.imageSha256 ||
      !(sidecar.sourceImage == page.sourceImage) ||
      sidecar.width != variant->width || sidecar.height != variant->height ||
      !sidecarTargetsPackaged(sidecar, manifest, error)) {
    if (error.empty()) error = "Sidecar does not match its manifest frame";
    if (revisionRetriesRemaining > 0) {
      ESP_LOGW(kTag,
               "NAV_RETRY phase=sidecar-envelope pkg=%s doc=%s remaining=%u "
               "id=%u manifest_ref=%s code=%s",
               packageId.c_str(), documentUuid.c_str(),
               revisionRetriesRemaining,
               static_cast<unsigned>(navigationSequence_),
               telemetryReference(manifest.sha256).c_str(),
               navigationFailureCodeName(
                   classifyNavigationFailure(error)));
      error.clear();
      return loadOnline(packageId, documentUuid, pageIndex, meta, result, error,
                        revisionRetriesRemaining - 1);
    }
    return false;
  }
  std::vector<uint8_t>().swap(sidecarResponse.body);
  if (!http_.get(joinServerUrl(settings_.serverBaseUrl, frameBase),
                 manifestHeaders(manifest), kMaximumFrameBytes, frameResponse,
                 error)) {
    return false;
  }
  if (frameResponse.status == 412) {
    if (revisionRetriesRemaining > 0) {
      ESP_LOGW(kTag,
               "NAV_RETRY phase=frame id=%u code=REVISION_CHANGED "
               "pkg=%s doc=%s remaining=%u manifest_ref=%s",
               static_cast<unsigned>(navigationSequence_), packageId.c_str(),
               documentUuid.c_str(), revisionRetriesRemaining,
               telemetryReference(manifest.sha256).c_str());
      return loadOnline(packageId, documentUuid, pageIndex, meta, result, error,
                        revisionRetriesRemaining - 1);
    }
    return fail(error, "Package kept changing while reading the PNG");
  }
  if (frameResponse.status != 200 ||
      !hasContentType(frameResponse, "image/png") ||
      !artifactHeadersProblem(frameResponse, manifest, page.imageSha256,
                              page.imageBytes)
           .empty() ||
      !bodyMatches(frameResponse.body, page.imageBytes, page.imageSha256,
                   error) ||
      !validPngGeometry(frameResponse.body, variant->width, variant->height,
                        PngFramePolicy::PackageGray4, error)) {
    if (error.empty()) {
      error = "Frame HTTP/integrity failure " +
              std::to_string(frameResponse.status);
    }
    if (revisionRetriesRemaining > 0) {
      ESP_LOGW(kTag,
               "NAV_RETRY phase=frame-integrity pkg=%s doc=%s remaining=%u "
               "id=%u manifest_ref=%s code=%s",
               packageId.c_str(), documentUuid.c_str(),
               revisionRetriesRemaining,
               static_cast<unsigned>(navigationSequence_),
               telemetryReference(manifest.sha256).c_str(),
               navigationFailureCodeName(
                   classifyNavigationFailure(error)));
      error.clear();
      return loadOnline(packageId, documentUuid, pageIndex, meta, result, error,
                        revisionRetriesRemaining - 1);
    }
    return false;
  }
  if (verifiedManifest == &fetchedManifest) {
    result.manifest = std::move(fetchedManifest);
  }
  result.documentJson = documentJson;
  result.png = std::move(frameResponse.body);
  result.sidecar = std::move(sidecar);
  result.contentType = document->kind;
  result.renderProfile = FrameRenderProfile::Generic;
  result.refreshHint = FrameRefreshHint::LegacyUnspecified;
  result.embedded = false;
  return true;
}

bool InkRuntime::activate(FrameTransaction &&transaction,
                          const Location &requested, bool recordHistory,
                          std::string &error) {
  const auto variant = std::find_if(
      transaction.manifest.variants.begin(), transaction.manifest.variants.end(),
      [&transaction](const DisplayVariant &value) {
        return value.id == transaction.sidecar.variantId;
      });
  if (variant == transaction.manifest.variants.end()) {
    return fail(error, "Frame sidecar names an unknown display variant");
  }
  if (!display_.showFrame(transaction.png, *variant, transaction.contentType,
                          transaction.renderProfile, transaction.refreshHint,
                          error)) {
    return false;
  }
  if (recordHistory && initialized_) {
    backHistory_.push_back(location_);
    if (backHistory_.size() > 32) backHistory_.erase(backHistory_.begin());
    forwardHistory_.clear();
  }
  location_ = requested;
  location_.packageId = transaction.manifest.packageId;
  location_.documentUuid = transaction.sidecar.documentUuid;
  location_.pageIndex = transaction.sidecar.pageIndex;
  location_.embedded = transaction.embedded;
  location_.stored = transaction.stored;
  active_ = std::move(transaction);
  resetClockPaintState();
  logMainTaskStackWatermark(active_.embedded
                                ? "embedded frame activation"
                                : active_.stored ? "stored frame activation"
                                                 : "online frame activation");
  return true;
}

void InkRuntime::resetClockPaintState() {
  clockNextUs_.assign(active_.sidecar.dynamicRegions.size(),
                      esp_timer_get_time());
  clockValues_.assign(active_.sidecar.dynamicRegions.size(), {});
}

bool InkRuntime::navigateTo(const Location &location, bool recordHistory,
                            std::string &error, const char *cause) {
  CollectionKind collectionKind;
  std::string appAction;
  const bool appLocation = location.packageId == kOnlinePackageId &&
                           appActionForDocument(location.documentUuid,
                                                appAction);
  const bool collectionLocation =
      location.packageId == kOnlinePackageId &&
      collectionKindForDocument(location.documentUuid, collectionKind);
  const bool reusableManifest =
      active_.manifest.packageId == location.packageId &&
      findDocument(active_.manifest, location.documentUuid);
  const char *route =
      appLocation
          ? "app"
          : collectionLocation
                ? (collectionKind == CollectionKind::Rss ? "collection-rss"
                                                         : "collection-website")
                : location.stored
                      ? "stored"
                      : location.embedded
                            ? "embedded"
                            : reusableManifest ? "online-reuse"
                                               : "online-fetch";
  const uint32_t navigationId =
      nextTelemetrySequence(navigationSequence_);
  const std::string targetReference = telemetryReference(
      location.packageId + "|" + location.documentUuid + "|" +
      std::to_string(location.pageIndex));
  ESP_LOGI(
      kTag,
      "NAV_START id=%u cause=%s route=%s from_doc=%s from_page=%u "
      "target_doc=%s target_page=%u target_ref=%s history=%d",
      static_cast<unsigned>(navigationId),
      cause && cause[0] != '\0' ? cause : "unknown", route,
      location_.documentUuid.empty() ? "-" : location_.documentUuid.c_str(),
      location_.pageIndex, location.documentUuid.c_str(), location.pageIndex,
      targetReference.c_str(), recordHistory);

  FrameTransaction transaction;
  bool loaded = false;
  const std::string previousAppAction = activeAppAction_;
  const std::string previousAppNonce = activeAppNonce_;
  const uint64_t previousAppRequestedAtMs = activeAppRequestedAtMs_;
  if (appLocation) {
    loaded = renderApp(appAction, location.pageIndex, displayMeta(),
                       transaction, false, error);
  } else if (collectionLocation) {
    loaded = renderCollection(collectionKind, location.pageIndex,
                              displayMeta(), transaction, error);
  } else if (location.stored && storedMapping_.bytes &&
      location.packageId == storedManifest_.packageId) {
    loaded = loadStored(location.documentUuid, location.pageIndex,
                        displayMeta(), transaction, error);
  } else if (location.embedded &&
             location.packageId == embeddedManifest_.packageId) {
    loaded = loadEmbedded(location.documentUuid, location.pageIndex,
                          displayMeta(), transaction, error);
    if (!loaded && networkReady_) {
      error.clear();
      loaded = loadOnline(location.packageId, location.documentUuid,
                          location.pageIndex, displayMeta(), transaction, error);
    }
  } else {
    const Manifest *verifiedManifest =
        reusableManifest ? &active_.manifest : nullptr;
    loaded = loadOnline(location.packageId, location.documentUuid,
                        location.pageIndex, displayMeta(), transaction, error,
                        3, verifiedManifest);
  }
  bool transferredActiveManifest = false;
  if (loaded && transaction.manifest.packageId.empty()) {
    // loadOnline deliberately leaves the already-verified manifest in active_
    // during all network, integrity and PNG work. Transfer ownership only
    // after those operations succeed, eliminating the second full manifest
    // allocation for an in-package RSS/article jump.
    transaction.manifest = std::move(active_.manifest);
    transferredActiveManifest = true;
  }
  const bool activated = loaded &&
      activate(std::move(transaction), location, recordHistory, error);
  if (!activated && transferredActiveManifest) {
    active_.manifest = std::move(transaction.manifest);
  }
  if (!activated && appLocation) {
    activeAppAction_ = previousAppAction;
    activeAppNonce_ = previousAppNonce;
    activeAppRequestedAtMs_ = previousAppRequestedAtMs;
  }
  if (activated) {
    ESP_LOGI(
        kTag,
        "NAV_OK id=%u cause=%s route=%s pkg=%s doc=%s content=%s "
        "page=%u/%u parent=%d manifest_ref=%s back=%u forward=%u",
        static_cast<unsigned>(navigationId),
        cause && cause[0] != '\0' ? cause : "unknown", route,
        location_.packageId.c_str(), location_.documentUuid.c_str(),
        active_.contentType.c_str(),
        static_cast<unsigned>(location_.pageIndex + 1),
        static_cast<unsigned>(active_.sidecar.pageCount),
        active_.sidecar.parentUuid.empty() ? 0 : 1,
        telemetryReference(active_.manifest.sha256).c_str(),
        static_cast<unsigned>(backHistory_.size()),
        static_cast<unsigned>(forwardHistory_.size()));
  } else {
    NavigationFailureCode code = classifyNavigationFailure(error);
    if (loaded && code == NavigationFailureCode::Unknown) {
      code = NavigationFailureCode::DisplayFailed;
    }
    ESP_LOGW(
        kTag,
        "NAV_RETAIN id=%u cause=%s route=%s phase=%s code=%s "
        "target_doc=%s target_page=%u target_ref=%s retained_doc=%s "
        "retained_page=%u",
        static_cast<unsigned>(navigationId),
        cause && cause[0] != '\0' ? cause : "unknown", route,
        loaded ? "activate" : "load", navigationFailureCodeName(code),
        location.documentUuid.c_str(), location.pageIndex,
        targetReference.c_str(),
        location_.documentUuid.empty() ? "-" : location_.documentUuid.c_str(),
        location_.pageIndex);
  }
  return activated;
}

bool InkRuntime::resolveSource(const std::string &url, Location &location,
                               std::string &error) {
  const uint32_t sourceId = nextTelemetrySequence(sourceSequence_);
  const std::string sourceReference = telemetryReference(url);
  const auto logFailure =
      [&](const char *phase,
          NavigationFailureCode overrideCode =
              NavigationFailureCode::Unknown) {
        const NavigationFailureCode code =
            overrideCode == NavigationFailureCode::Unknown
                ? classifyNavigationFailure(error)
                : overrideCode;
        ESP_LOGW(kTag,
                 "SOURCE_JOB id=%u phase=%s status=failed code=%s "
                 "source_ref=%s",
                 static_cast<unsigned>(sourceId), phase,
                 navigationFailureCodeName(code), sourceReference.c_str());
      };
  const auto failSource = [&](const char *phase,
                              const std::string &message) {
    error = message;
    logFailure(phase);
    return false;
  };
  ESP_LOGI(kTag,
           "SOURCE_JOB id=%u phase=resolve status=start source_ref=%s",
           static_cast<unsigned>(sourceId), sourceReference.c_str());
  if (!networkReady_ || url.rfind("https://", 0) != 0) {
    return failSource(
        "preflight", "Source URL requires an online renderer connection");
  }
  cJSON *root = cJSON_CreateObject();
  cJSON *meta = cJSON_CreateObject();
  if (!root || !meta) {
    if (root) cJSON_Delete(root);
    if (meta) cJSON_Delete(meta);
    return failSource("request",
                      "Cannot allocate source resolution request");
  }
  cJSON_AddStringToObject(root, "url", url.c_str());
  const DisplayMeta display = displayMeta();
  cJSON_AddStringToObject(meta, "orientation",
                          orientationName(display.orientation));
  cJSON_AddNumberToObject(meta, "fontLevel", display.fontLevel);
  cJSON_AddBoolToObject(meta, "invert", display.invert);
  cJSON_AddItemToObject(root, "displayMeta", meta);
  char *printed = cJSON_PrintUnformatted(root);
  cJSON_Delete(root);
  if (!printed) {
    return failSource("request", "Cannot serialize source request");
  }
  const std::string body(printed);
  cJSON_free(printed);
  HttpResponse response;
  if (!http_.postJson(joinServerUrl(settings_.serverBaseUrl,
                                    std::string(kApiBase) + "/sources/resolve"),
                      body, {}, 256U * 1024U, response, error)) {
    logFailure("resolve-http");
    return false;
  }
  if (response.status != 200 && response.status != 202) {
    return failSource("resolve-http",
                      "Source resolver HTTP status " +
                          std::to_string(response.status) + ": " +
                          response.text());
  }
  JsonPtr resolution = parseJson(response.text());
  if (!resolution) {
    return failSource("resolve-parse",
                      "Source resolver returned invalid JSON");
  }
  const char *packageId = jsonString(resolution.get(), "packageId");
  const char *entryUuid = jsonString(resolution.get(), "entryUuid");
  if (response.status == 202) {
    const char *statusUrl = jsonString(resolution.get(), "statusUrl");
    if (!statusUrl) {
      return failSource("resolve-parse", "Source job has no status URL");
    }
    ESP_LOGI(kTag,
             "SOURCE_JOB id=%u phase=queue status=queued source_ref=%s",
             static_cast<unsigned>(sourceId), sourceReference.c_str());
    std::string completedPackage;
    std::string previousStatus;
    for (uint16_t attempt = 0; attempt < 180; ++attempt) {
      vTaskDelay(pdMS_TO_TICKS(1000));
      HttpResponse jobResponse;
      if (!http_.get(joinServerUrl(settings_.serverBaseUrl, statusUrl), {},
                     256U * 1024U, jobResponse, error)) {
        logFailure("poll-http");
        return false;
      }
      if (jobResponse.status != 200) {
        return failSource("poll-http", "Source job HTTP status " +
                                           std::to_string(jobResponse.status));
      }
      JsonPtr job = parseJson(jobResponse.text());
      const char *status = job ? jsonString(job.get(), "status") : nullptr;
      const char *safeStatus = safeSourceJobStatus(status);
      if (!status || std::strcmp(safeStatus, "invalid") == 0) {
        return failSource("poll-parse",
                          "Source job returned invalid JSON");
      }
      if (previousStatus != safeStatus) {
        previousStatus = safeStatus;
        ESP_LOGI(kTag,
                 "SOURCE_JOB id=%u phase=poll status=%s attempt=%u "
                 "source_ref=%s",
                 static_cast<unsigned>(sourceId), safeStatus,
                 static_cast<unsigned>(attempt + 1),
                 sourceReference.c_str());
      }
      if (std::strcmp(status, "failed") == 0 ||
          std::strcmp(status, "cancelled") == 0) {
        const cJSON *failure =
            cJSON_GetObjectItemCaseSensitive(job.get(), "error");
        const char *remoteCode = cJSON_IsObject(failure)
                                     ? jsonString(failure, "code")
                                     : nullptr;
        const char *message = cJSON_IsObject(failure)
                                  ? jsonString(failure, "message")
                                  : nullptr;
        const bool cancelled = std::strcmp(status, "cancelled") == 0;
        const std::string code = safeTelemetryCode(
            remoteCode,
            cancelled ? "SOURCE_JOB_CANCELLED" : "SOURCE_JOB_FAILED");
        ESP_LOGW(kTag,
                 "SOURCE_JOB id=%u phase=generate status=%s code=%s "
                 "attempt=%u source_ref=%s",
                 static_cast<unsigned>(sourceId), safeStatus, code.c_str(),
                 static_cast<unsigned>(attempt + 1),
                 sourceReference.c_str());
        error = cancelled
                    ? "Source generation cancelled"
                    : message && message[0] != '\0'
                          ? "Source generation failed: " +
                                std::string(message)
                          : "Source generation did not complete";
        return false;
      }
      if (std::strcmp(status, "complete") == 0) {
        const cJSON *package =
            cJSON_GetObjectItemCaseSensitive(job.get(), "package");
        const char *finishedId = cJSON_IsObject(package)
                                     ? jsonString(package, "packageId")
                                     : nullptr;
        if (!finishedId || !isUuid(finishedId)) {
          return failSource(
              "poll-parse",
              "Completed source job has no package identity");
        }
        completedPackage = finishedId;
        break;
      }
    }
    if (completedPackage.empty()) {
      return failSource(
          "generate", "Source generation timed out after 180 seconds");
    }
    Manifest manifest;
    if (!fetchManifest(completedPackage, manifest, true, error)) {
      logFailure("manifest");
      return false;
    }
    location = {manifest.packageId, manifest.entryUuid, 0, false};
    ESP_LOGI(kTag,
             "SOURCE_JOB id=%u phase=resolve status=ready package=%s "
             "doc=%s source_ref=%s",
             static_cast<unsigned>(sourceId), manifest.packageId.c_str(),
             manifest.entryUuid.c_str(), sourceReference.c_str());
    return true;
  }
  if (!packageId || !entryUuid || !isUuid(packageId) || !isUuid(entryUuid)) {
    return failSource(
        "resolve-parse",
        "Resolved source has no valid package/entry UUID");
  }
  location = {packageId, entryUuid, 0, false};
  ESP_LOGI(kTag,
           "SOURCE_JOB id=%u phase=resolve status=cached package=%s "
           "doc=%s source_ref=%s",
           static_cast<unsigned>(sourceId), packageId, entryUuid,
           sourceReference.c_str());
  return true;
}

void InkRuntime::handleInput(const InputEvent &event) {
  if (event.kind == InputKind::None) return;
  // This event is already release-confirmed (except the deliberate settings
  // hold). Suppress fresh controller state until the synchronous navigation or
  // display operation finishes, preventing a touch made during BUSY/network
  // wait from becoming a second queued action afterward.
  display_.suppressInputUntilRelease();
  ESP_LOGI(kTag,
           "NAV_INPUT kind=%s current_doc=%s page=%u/%u back=%u forward=%u",
           inputKindName(event.kind),
           location_.documentUuid.empty() ? "-" : location_.documentUuid.c_str(),
           static_cast<unsigned>(location_.pageIndex + 1),
           static_cast<unsigned>(active_.sidecar.pageCount),
           static_cast<unsigned>(backHistory_.size()),
           static_cast<unsigned>(forwardHistory_.size()));
  if (settingsOpen_) {
    handleSettingsInput(event);
    return;
  }
  if (event.kind == InputKind::SettingsHold) {
    openSettings();
    return;
  }
  std::string error;
  const auto showNavigationProgress = [this](const Location &target) {
    if (!target.embedded && !target.stored) {
      display_.showLoading("正在打开目标页面，请稍等…");
    }
  };
  const auto returnToPreviousLevel =
      [this, &error, &showNavigationProgress](const char *historyCause,
                                              const char *parentCause) {
        if (!backHistory_.empty()) {
          const Location target = backHistory_.back();
          backHistory_.pop_back();
          const Location current = location_;
          showNavigationProgress(target);
          if (navigateTo(target, false, error, historyCause)) {
            forwardHistory_.push_back(current);
            return true;
          }
          backHistory_.push_back(target);
          return false;
        }
        if (!active_.sidecar.parentUuid.empty()) {
          const Location target = {
              location_.packageId, active_.sidecar.parentUuid, 0,
              location_.embedded, location_.stored};
          showNavigationProgress(target);
          return navigateTo(target, false, error, parentCause);
        }
        ESP_LOGI(kTag,
                 "NAV_BOUNDARY action=stay reason=no-previous-level "
                 "current_doc=%s page=%u/%u",
                 location_.documentUuid.empty()
                     ? "-"
                     : location_.documentUuid.c_str(),
                 static_cast<unsigned>(location_.pageIndex + 1),
                 static_cast<unsigned>(active_.sidecar.pageCount));
        return false;
      };
  if (event.kind == InputKind::SwipeRight) {
    if (forwardHistory_.empty()) return;
    const Location target = forwardHistory_.back();
    forwardHistory_.pop_back();
    const Location current = location_;
    showNavigationProgress(target);
    if (navigateTo(target, false, error, "history-forward")) {
      backHistory_.push_back(current);
    } else {
      forwardHistory_.push_back(target);
    }
  } else if (event.kind == InputKind::SwipeLeft ||
             (event.kind == InputKind::SwipeDown &&
              location_.pageIndex == 0)) {
    returnToPreviousLevel("history-back", "parent-back");
  } else if (event.kind == InputKind::SwipeUp) {
    if (location_.pageIndex + 1 < active_.sidecar.pageCount) {
      const Location target = {
          location_.packageId, location_.documentUuid,
          static_cast<uint16_t>(location_.pageIndex + 1), location_.embedded,
          location_.stored};
      showNavigationProgress(target);
      navigateTo(target, false, error, "page-next");
    } else if (active_.sidecar.pageCount > 0) {
      returnToPreviousLevel("last-page-back", "last-page-parent-back");
    }
  } else if (event.kind == InputKind::SwipeDown) {
    if (location_.pageIndex > 0) {
      const Location target = {
          location_.packageId, location_.documentUuid,
          static_cast<uint16_t>(location_.pageIndex - 1), location_.embedded,
          location_.stored};
      showNavigationProgress(target);
      navigateTo(target, false, error, "page-previous");
    }
  } else if (event.kind == InputKind::Tap) {
    const Interaction *interaction =
        hitTest(active_.sidecar, event.x, event.y);
    if (!interaction) {
      ESP_LOGI(kTag, "NAV_TARGET kind=none hit=0");
      return;
    }
    const NavigationTargetKind targetKind = classifyNavigationTarget(
        interaction->targetUrl, interaction->targetUuid);
    const std::string targetReference = telemetryReference(
        interaction->targetUrl.empty() ? interaction->targetUuid
                                       : interaction->targetUrl);
    ESP_LOGI(kTag,
             "NAV_TARGET kind=%s hit=1 target_doc=%s target_ref=%s "
             "fallback=%d",
             navigationTargetKindName(targetKind),
             interaction->targetUuid.empty() ? "-"
                                             : interaction->targetUuid.c_str(),
             targetReference.c_str(),
             interaction->fallbackUrl.empty() ? 0 : 1);
    if (!interaction->targetUrl.empty()) {
      if (interaction->targetUrl == kSettingsAction) {
        openSettings();
        return;
      }
      CollectionKind collectionKind;
      const char *appDocumentUuid = nullptr;
      const char *appTitleValue = nullptr;
      const char *appSlug = nullptr;
      if (appDocumentForAction(interaction->targetUrl, appDocumentUuid,
                               appTitleValue, appSlug)) {
        (void)appTitleValue;
        (void)appSlug;
        display_.showLoading(interaction->targetUrl == kRandomImageAction
                                 ? "正在打开图片查看器，请稍等…"
                                 : "正在打开百度地图，请稍等…");
        const std::string previousAppAction = activeAppAction_;
        const std::string previousAppNonce = activeAppNonce_;
        const uint64_t previousAppRequestedAtMs = activeAppRequestedAtMs_;
        FrameTransaction transaction;
        const bool rendered = renderApp(interaction->targetUrl, 0,
                                        displayMeta(), transaction, true,
                                        error);
        const bool activated = rendered &&
            activate(std::move(transaction),
                     {kOnlinePackageId, appDocumentUuid, 0, false, false},
                     true, error);
        if (!activated) {
          activeAppAction_ = previousAppAction;
          activeAppNonce_ = previousAppNonce;
          activeAppRequestedAtMs_ = previousAppRequestedAtMs;
        }
      } else if (collectionKindForUrl(interaction->targetUrl, collectionKind)) {
        display_.showLoading("正在打开" +
                             std::string(collectionTitle(collectionKind)) +
                             "，请稍等…");
        navigateTo({kOnlinePackageId, collectionDocumentUuid(collectionKind),
                    0, false, false},
                   true, error, "collection-open");
      } else {
        display_.showLoading(
            "正在打开" +
            (interaction->label.empty() ? std::string("网页内容")
                                        : interaction->label) +
            "，请稍等…");
        Location target;
        if (resolveSource(interaction->targetUrl, target, error)) {
          navigateTo(target, true, error, "source-open");
        }
      }
    } else if (interaction->targetUuid != location_.documentUuid) {
      const Location packagedTarget = {
          location_.packageId, interaction->targetUuid, 0,
          location_.embedded, location_.stored};
      showNavigationProgress(packagedTarget);
      if (navigateTo(packagedTarget, true, error, "package-link")) return;
      if (!interaction->fallbackUrl.empty()) {
        const std::string packageError = error;
        const std::string fallbackReference =
            telemetryReference(interaction->fallbackUrl);
        ESP_LOGW(kTag,
                 "NAV_FALLBACK target=%s fallback_ref=%s code=%s",
                 interaction->targetUuid.c_str(),
                 fallbackReference.c_str(),
                 navigationFailureCodeName(
                     classifyNavigationFailure(packageError)));
        error.clear();
        display_.showLoading("正在打开文章详情，请稍等…");
        Location sourceTarget;
        if (resolveSource(interaction->fallbackUrl, sourceTarget, error) &&
            navigateTo(sourceTarget, true, error, "fallback-source")) {
          return;
        }
        error = "包内详情打开失败（" + packageError +
                "）；从原始地址重新打开也失败：" + error;
      }
    }
  }
  if (!error.empty()) {
    const DisplayVariant *variant = activeVariant();
    bool restored = false;
    if (variant) {
      std::string restoreError;
      if (display_.showFrame(active_.png, *variant, active_.contentType,
                             active_.renderProfile, active_.refreshHint,
                             restoreError)) {
        resetClockPaintState();
        restored = true;
      } else {
        ESP_LOGE(kTag, "NAV_RESTORE status=failed code=%s",
                 navigationFailureCodeName(
                     classifyNavigationFailure(restoreError)));
      }
    }
    if (restored) {
      display_.showLoading("打开失败，已保留原页面：" + error);
    }
    ESP_LOGW(kTag, "NAV_RETAIN phase=input code=%s restored=%d",
             navigationFailureCodeName(classifyNavigationFailure(error)),
             restored ? 1 : 0);
  }
}

void InkRuntime::openSettings() {
  settingsDraft_ = settings_;
  settingsOpen_ = true;
  const std::string manager = networkReady_ && !stationAddress().empty()
                                  ? "http://" + stationAddress() + "/"
                                  : std::string();
  display_.showSettings(settingsDraft_, active_.manifest.title, manager);
}

void InkRuntime::handleSettingsInput(const InputEvent &event) {
  if (event.kind == InputKind::SettingsHold) {
    settingsOpen_ = false;
    const DisplayVariant *variant = activeVariant();
    std::string error;
    if (variant &&
        display_.showFrame(active_.png, *variant, active_.contentType,
                           active_.renderProfile, active_.refreshHint,
                           error)) {
      resetClockPaintState();
    }
    return;
  }
  if (event.kind != InputKind::Tap) return;
  const int32_t bottomButtons = 72;
  const int32_t rowAreaTop = 96;
  const int32_t available =
      display_.height() - rowAreaTop - bottomButtons - 18;
  const int32_t gap = 8;
  const int32_t rowHeight = std::min<int32_t>(
      132, (available - gap * 3) / 4);
  const int32_t rowTop = rowAreaTop +
      (available - rowHeight * 4 - gap * 3) / 2;
  const int32_t buttonTop = display_.height() - bottomButtons + 8;
  std::string error;
  if (event.y >= buttonTop) {
    if (event.x < display_.width() / 2) {
      settingsOpen_ = false;
      const DisplayVariant *variant = activeVariant();
      if (variant && display_.showFrame(active_.png, *variant,
                                        active_.contentType,
                                        active_.renderProfile,
                                        active_.refreshHint, error)) {
        resetClockPaintState();
      }
    } else if (applySettings(error)) {
      settingsOpen_ = false;
    }
  } else {
    int selected = -1;
    for (int row = 0; row < 4; ++row) {
      const int32_t top = rowTop + row * (rowHeight + gap);
      if (event.y >= top && event.y < top + rowHeight) selected = row;
    }
    switch (selected) {
    case 0:
      settingsDraft_.orientationMode =
          settingsDraft_.orientationMode == OrientationMode::Manual
              ? OrientationMode::Automatic
              : OrientationMode::Manual;
      break;
    case 1:
      if (settingsDraft_.orientationMode == OrientationMode::Manual) {
        settingsDraft_.manualOrientation =
            settingsDraft_.manualOrientation == Orientation::Portrait
                ? Orientation::Landscape
                : Orientation::Portrait;
      }
      break;
    case 2:
      settingsDraft_.fontLevel = settingsDraft_.fontLevel == 2
                                     ? -2
                                     : settingsDraft_.fontLevel + 1;
      break;
    case 3:
      settingsOpen_ = false;
      if (networkReady_ && !stationAddress().empty()) {
        display_.showStatus(
            "设备管理",
            "请在同一局域网打开：\nhttp://" + stationAddress() +
                "/\n\n可修改 Wi-Fi、渲染服务器、RSS/收藏列表和首页 .ink。\n\n长按屏幕上部可返回设置。");
        return;
      }
      if (portal_.start(settings_, error)) {
        display_.showPortal(configurationApSsid(), "192.168.4.1",
                            "保存后设备会自动连接并返回当前页面。");
      }
      return;
    default: return;
    }
    const std::string manager = networkReady_ && !stationAddress().empty()
                                    ? "http://" + stationAddress() + "/"
                                    : std::string();
    display_.showSettings(settingsDraft_, active_.manifest.title, manager);
  }
  if (!error.empty()) {
    ESP_LOGW(kTag, "settings action failed: %s", error.c_str());
    const std::string manager = networkReady_ && !stationAddress().empty()
                                    ? "http://" + stationAddress() + "/"
                                    : std::string();
    display_.showSettings(settingsDraft_, active_.manifest.title, manager);
  }
}

bool InkRuntime::applySettings(std::string &error) {
  const DeviceSettings previous = settings_;
  if (!saveSettings(settingsDraft_, error)) return false;
  settings_ = settingsDraft_;
  if (!navigateTo(location_, false, error, "settings-apply")) {
    settings_ = previous;
    std::string ignored;
    saveSettings(previous, ignored);
    const DisplayVariant *variant = activeVariant();
    if (variant && display_.showFrame(active_.png, *variant,
                                      active_.contentType,
                                      active_.renderProfile,
                                      active_.refreshHint, ignored)) {
      resetClockPaintState();
    }
    return false;
  }
  return true;
}

void InkRuntime::tickClock() {
  if (settingsOpen_ || active_.sidecar.dynamicRegions.empty()) return;
  timeval wall{};
  gettimeofday(&wall, nullptr);
  const std::time_t now = wall.tv_sec;
  if (now < 1'700'000'000) return;
  std::tm local{};
  localtime_r(&now, &local);
  char value[9]{};
  std::snprintf(value, sizeof(value), "%02d:%02d:%02d", local.tm_hour,
                local.tm_min, local.tm_sec);
  const int64_t monotonic = esp_timer_get_time();
  const int64_t wallMs = static_cast<int64_t>(wall.tv_sec) * 1000 +
                         wall.tv_usec / 1000;
  for (size_t index = 0; index < active_.sidecar.dynamicRegions.size(); ++index) {
    const ClockRegion &region = active_.sidecar.dynamicRegions[index];
    if (monotonic < clockNextUs_[index]) continue;
    const int64_t nextWallMs =
        (wallMs / region.refreshMs + 1) * region.refreshMs;
    clockNextUs_[index] = monotonic + (nextWallMs - wallMs) * 1000;
    const bool firstTick = clockValues_[index].empty();
    if (!firstTick && clockValues_[index] == value) continue;
    std::string error;
    if (!display_.showClock(region, clockValues_[index], value, error)) {
      ESP_LOGW(kTag, "clock refresh failed: %s", error.c_str());
    } else {
      clockValues_[index] = value;
    }
  }
}

void InkRuntime::tickOrientation() {
  if (settingsOpen_ ||
      settings_.orientationMode != OrientationMode::Automatic) {
    return;
  }
  Orientation suggested;
  if (!display_.suggestedOrientation(suggested) ||
      suggested == settings_.manualOrientation) {
    return;
  }
  const Orientation previous = settings_.manualOrientation;
  settings_.manualOrientation = suggested;
  std::string error;
  if (!navigateTo(location_, false, error, "orientation-change")) {
    settings_.manualOrientation = previous;
    ESP_LOGW(kTag, "sensor rotation retained old frame: %s", error.c_str());
    return;
  }
  saveSettings(settings_, error);
}

void InkRuntime::configureNetwork() {
  std::string error;
  if (!settings_.wifiSsid.empty() && !settings_.serverBaseUrl.empty() &&
      connectStation(settings_, 12000, error)) {
    networkReady_ = true;
    initializeSntp();
    ESP_LOGI(kTag, "Wi-Fi connected: %s", stationAddress().c_str());
    std::string managerError;
    if (!portal_.startManager(settings_, managerError)) {
      ESP_LOGW(kTag, "LAN manager unavailable: %s", managerError.c_str());
    }
    if (settings_.fontLevel != 0) {
      navigateTo(location_, false, error, "network-ready");
    }
    return;
  }
  networkReady_ = false;
  if (!error.empty()) ESP_LOGW(kTag, "Wi-Fi unavailable: %s", error.c_str());
  error.clear();
  if (portal_.start(settings_, error)) {
    display_.showPortal(configurationApSsid(), "192.168.4.1",
                        "首页已内置；配置失败不会清除当前内容。");
  } else {
    ESP_LOGE(kTag, "configuration portal failed: %s", error.c_str());
  }
}

DisplayMeta InkRuntime::displayMeta() const {
  // The public renderer contract still carries an explicit invert field, but
  // the PaperS3 client supports only the stable white-paper mode.
  return {settings_.manualOrientation, settings_.fontLevel, false};
}

const DisplayVariant *InkRuntime::activeVariant() const {
  const auto found = std::find_if(
      active_.manifest.variants.begin(), active_.manifest.variants.end(),
      [this](const DisplayVariant &variant) {
        return variant.id == active_.sidecar.variantId;
      });
  return found == active_.manifest.variants.end() ? nullptr : &*found;
}

#if defined(CONFIG_INKOS_RSS_SERIAL_HARNESS) && \
    CONFIG_INKOS_RSS_SERIAL_HARNESS
bool InkRuntime::initializeRssSerialHarness(std::string &error) {
  if (!usb_serial_jtag_is_driver_installed()) {
    usb_serial_jtag_driver_config_t config =
        USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT();
    config.tx_buffer_size = 2048;
    config.rx_buffer_size = 512;
    const esp_err_t installed = usb_serial_jtag_driver_install(&config);
    if (installed != ESP_OK) {
      error = "Could not install the USB-Serial/JTAG driver";
      return false;
    }
  }
  usb_serial_jtag_vfs_use_driver();

  char challenge[9] = {};
  std::snprintf(challenge, sizeof(challenge), "%08x",
                static_cast<unsigned>(esp_random()));
  rssHarnessChallenge_ = challenge;
  rssHarnessLineBytes_ = 0;
  rssHarnessDiscardLine_ = false;
  rssHarnessArmed_ = true;
  error.clear();
  ESP_LOGW(kTag,
           "RSS_HARNESS_READY protocol=1 challenge=%s one_shot=1 "
           "transport=usb-serial-jtag",
           rssHarnessChallenge_.c_str());
  return true;
}

bool InkRuntime::pollRssSerialHarness() {
  if (!rssHarnessArmed_ || !usb_serial_jtag_is_driver_installed()) {
    return false;
  }
  std::array<uint8_t, 64> incoming{};
  const int received = usb_serial_jtag_read_bytes(
      incoming.data(), incoming.size(), 0);
  if (received <= 0) return false;

  for (int index = 0; index < received; ++index) {
    const uint8_t byte = incoming[static_cast<size_t>(index)];
    if (byte == '\r') continue;
    if (byte == '\n') {
      if (rssHarnessDiscardLine_) {
        ESP_LOGW(kTag, "RSS_HARNESS_REJECT reason=line");
        rssHarnessDiscardLine_ = false;
        rssHarnessLineBytes_ = 0;
        continue;
      }
      if (rssHarnessLineBytes_ == 0) continue;

      const std::string line(rssHarnessLine_.data(),
                             rssHarnessLineBytes_);
      rssHarnessLineBytes_ = 0;
      std::string runId;
      const RssHarnessCommandResult parsed = parseRssHarnessCommand(
          line, rssHarnessChallenge_, runId);
      if (parsed != RssHarnessCommandResult::Ok) {
        ESP_LOGW(kTag, "RSS_HARNESS_REJECT reason=%s",
                 parsed == RssHarnessCommandResult::ChallengeMismatch
                     ? "challenge"
                     : "format");
        continue;
      }

      // Consume the capability before starting any slow network/display work.
      // A repeated or buffered command cannot execute a second scenario.
      rssHarnessArmed_ = false;
      ESP_LOGW(kTag, "RSS_HARNESS_ACCEPT run=%s", runId.c_str());
      (void)runRssSerialHarness(runId);
      return true;
    }
    if (byte < 0x20 || byte > 0x7e ||
        rssHarnessLineBytes_ >= kRssHarnessMaximumLineBytes) {
      rssHarnessDiscardLine_ = true;
      rssHarnessLineBytes_ = 0;
      continue;
    }
    if (!rssHarnessDiscardLine_) {
      rssHarnessLine_[rssHarnessLineBytes_++] =
          static_cast<char>(byte);
    }
  }
  return false;
}

bool InkRuntime::runRssSerialHarness(const std::string &runId) {
  StoredHomeInfo startingHome;
  DeviceSettings persistedSettings;
  DeviceCollections persistedCollections;
  std::string storageError;
  const DeviceSettings startingSettings = settings_;
  const std::string startingCollections = collectionsJson(collections_);
  bool mutatedRuntime = false;
  bool passed = true;
  const char *failure = "none";

  const auto failStep = [&](const char *code) {
    if (passed) failure = code;
    passed = false;
  };
  const auto locationIs =
      [this](const Location &expected, const char *contentType) {
        return sameLocation(location_, expected) &&
               active_.contentType == contentType &&
               active_.sidecar.documentUuid == expected.documentUuid &&
               active_.sidecar.pageIndex == expected.pageIndex;
      };
  const auto tapUniqueUrl =
      [this, &runId](const char *step, const std::string &url) {
        const Interaction *match = nullptr;
        size_t matches = 0;
        for (const Interaction &interaction : active_.sidecar.interactions) {
          if (interaction.targetUrl == url) {
            match = &interaction;
            ++matches;
          }
        }
        if (matches != 1 || !match || match->bounds.width <= 0 ||
            match->bounds.height <= 0) {
          return false;
        }
        const int32_t x =
            match->bounds.x + (match->bounds.width - 1) / 2;
        const int32_t y =
            match->bounds.y + (match->bounds.height - 1) / 2;
        if (!active_.sidecar.width || !active_.sidecar.height || x < 0 ||
            y < 0 || x >= active_.sidecar.width ||
            y >= active_.sidecar.height ||
            hitTest(active_.sidecar, x, y) != match) {
          return false;
        }
        ESP_LOGW(kTag,
                 "RSS_HARNESS_STEP run=%s step=%s action=tap x=%ld y=%ld",
                 runId.c_str(), step, static_cast<long>(x),
                 static_cast<long>(y));
        handleInput({InputKind::Tap, x, y});
        return true;
      };

  ESP_LOGW(kTag, "RSS_HARNESS_START run=%s scenario=rss-nav-v1",
           runId.c_str());

  if (!initialized_ || !networkReady_ || settingsOpen_ ||
      !loadStoredHomeInfo(startingHome, storageError) ||
      !startingHome.active) {
    failStep("preflight-home-network");
  }
  storageError.clear();
  if (passed &&
      (!loadSettings(persistedSettings, storageError) ||
       !sameSettings(persistedSettings, startingSettings))) {
    failStep("preflight-settings");
  }
  storageError.clear();
  if (passed &&
      (!loadCollections(persistedCollections, storageError) ||
       collectionsJson(persistedCollections) != startingCollections)) {
    failStep("preflight-collections");
  }
  if (passed) {
    const size_t matches = static_cast<size_t>(std::count_if(
        collections_.rss.begin(), collections_.rss.end(),
        [](const CollectionEntry &entry) {
          return entry.url == kRssHarnessFeedUrl;
        }));
    if (matches != 1) failStep("preflight-feed");
  }

  if (passed) {
    mutatedRuntime = true;
    storageError.clear();
    if (!activateEmbeddedHome(storageError)) {
      failStep("embedded-home");
    }
  }
  if (passed &&
      (!tapUniqueUrl("home-rss", "inkos://collection/rss") ||
       !locationIs({kOnlinePackageId,
                    collectionDocumentUuid(CollectionKind::Rss), 0, false,
                    false},
                   "list"))) {
    failStep("rss-collection");
  }
  if (passed && !tapUniqueUrl("rss-feed", kRssHarnessFeedUrl)) {
    failStep("rss-feed-tap");
  }

  Location feedLocation;
  if (passed) {
    feedLocation = location_;
    if (feedLocation.embedded || feedLocation.stored ||
        feedLocation.packageId.empty() ||
        feedLocation.packageId == kOnlinePackageId ||
        feedLocation.documentUuid.empty() || feedLocation.pageIndex != 0 ||
        active_.contentType != "list" ||
        active_.sidecar.documentUuid != feedLocation.documentUuid ||
        active_.sidecar.pageCount == 0 ||
        active_.sidecar.interactions.empty()) {
      failStep("feed-postcondition");
    }
  }

  std::string detailUuid;
  if (passed) {
    const Interaction &first = active_.sidecar.interactions.front();
    if (!isUuid(first.targetUuid) || !first.targetUrl.empty() ||
        first.fallbackUrl.rfind("https://", 0) != 0 ||
        first.bounds.width <= 0 || first.bounds.height <= 0) {
      failStep("detail-contract");
    } else {
      const int32_t x = first.bounds.x + (first.bounds.width - 1) / 2;
      const int32_t y = first.bounds.y + (first.bounds.height - 1) / 2;
      if (x < 0 || y < 0 || x >= active_.sidecar.width ||
          y >= active_.sidecar.height ||
          hitTest(active_.sidecar, x, y) != &first) {
        failStep("detail-hit-test");
      } else {
        detailUuid = first.targetUuid;
        ESP_LOGW(
            kTag,
            "RSS_HARNESS_STEP run=%s step=feed-detail action=tap x=%ld y=%ld",
            runId.c_str(), static_cast<long>(x), static_cast<long>(y));
        handleInput({InputKind::Tap, x, y});
      }
    }
  }

  const auto detailIsPage =
      [this, &feedLocation, &detailUuid, &locationIs](uint16_t page) {
        return locationIs(
                   {feedLocation.packageId, detailUuid, page, false, false},
                   "detail") &&
               active_.sidecar.parentUuid ==
                   feedLocation.documentUuid &&
               active_.sidecar.pageCount >= 2;
      };
  if (passed && !detailIsPage(0)) failStep("detail-page-1");

  if (passed) {
    ESP_LOGW(kTag,
             "RSS_HARNESS_STEP run=%s step=detail-next action=swipe-up",
             runId.c_str());
    handleInput({InputKind::SwipeUp, 0, 0});
    if (!detailIsPage(1)) failStep("detail-page-2");
  }
  if (passed) {
    ESP_LOGW(kTag,
             "RSS_HARNESS_STEP run=%s step=detail-previous "
             "action=swipe-down",
             runId.c_str());
    handleInput({InputKind::SwipeDown, 0, 0});
    if (!detailIsPage(0)) failStep("detail-return-page-1");
  }
  if (passed) {
    ESP_LOGW(kTag,
             "RSS_HARNESS_STEP run=%s step=detail-back "
             "action=swipe-left",
             runId.c_str());
    handleInput({InputKind::SwipeLeft, 0, 0});
    if (!locationIs(feedLocation, "list")) failStep("feed-return");
  }

  // Restore the record that is current now, not blindly the record captured
  // before the run. A concurrent management update therefore wins, while the
  // harness is reported as conflicted instead of overwriting persistent state.
  StoredHomeInfo currentHome;
  storageError.clear();
  bool homeLoaded = loadStoredHomeInfo(currentHome, storageError);
  bool homeUnchanged = homeLoaded && sameStoredHome(startingHome, currentHome);
  bool restored = true;
  if (mutatedRuntime) {
    storageError.clear();
    restored = homeLoaded && currentHome.active
                   ? activateLatestStoredHome(storageError)
                   : homeLoaded && activateEmbeddedHome(storageError);
  }
  if (!homeLoaded || !restored) failStep("restore-home");
  if (homeLoaded && !homeUnchanged) failStep("state-conflict-home");

  DeviceSettings finalSettings;
  DeviceCollections finalCollections;
  storageError.clear();
  const bool settingsUnchanged =
      loadSettings(finalSettings, storageError) &&
      sameSettings(persistedSettings, finalSettings) &&
      sameSettings(startingSettings, settings_);
  storageError.clear();
  const bool collectionsUnchanged =
      loadCollections(finalCollections, storageError) &&
      collectionsJson(finalCollections) == startingCollections &&
      collectionsJson(collections_) == startingCollections;
  if (!settingsUnchanged) failStep("state-conflict-settings");
  if (!collectionsUnchanged) failStep("state-conflict-collections");

  ESP_LOGW(
      kTag,
      "RSS_HARNESS_RESULT run=%s status=%s failure=%s restored=%d "
      "home_unchanged=%d settings_unchanged=%d collections_unchanged=%d",
      runId.c_str(), passed ? "PASS" : "FAIL", failure, restored ? 1 : 0,
      homeUnchanged ? 1 : 0, settingsUnchanged ? 1 : 0,
      collectionsUnchanged ? 1 : 0);
  return passed;
}
#endif

void InkRuntime::loop() {
  if (!initialized_) return;
  if (consumeCollectionsChanged()) {
    DeviceCollections updated;
    std::string storageError;
    if (loadCollections(updated, storageError)) {
      collections_ = std::move(updated);
      CollectionKind activeKind;
      if (location_.packageId == kOnlinePackageId &&
          collectionKindForDocument(location_.documentUuid, activeKind)) {
        navigateTo({kOnlinePackageId, collectionDocumentUuid(activeKind), 0,
                    false, false},
                   false, storageError, "collection-updated");
      } else if (location_.packageId == kOnlinePackageId &&
                 location_.documentUuid == kRandomImageDocument &&
                 !collections_.images.empty()) {
        const uint16_t page = static_cast<uint16_t>(std::min<size_t>(
            location_.pageIndex, collections_.images.size() - 1));
        navigateTo({kOnlinePackageId, kRandomImageDocument, page, false,
                    false},
                   false, storageError, "image-collection-updated");
      }
    }
    if (!storageError.empty()) {
      ESP_LOGW(kTag, "collection update retained old frame: %s",
               storageError.c_str());
    }
  }
  bool uploadedHomeDeleted = false;
  if (consumeStoredHomeChanged(uploadedHomeDeleted)) {
    settingsOpen_ = false;
    std::string homeError;
    const bool switched = uploadedHomeDeleted
                              ? activateEmbeddedHome(homeError)
                              : activateLatestStoredHome(homeError);
    if (!switched) {
      ESP_LOGE(kTag, "home switch failed; retaining current frame: %s",
               homeError.c_str());
    }
  }
  DeviceSettings saved;
  if (portal_.consumeSaved(saved)) {
    portal_.stop();
    settings_ = saved;
    display_.showStatus("正在连接", "正在连接 Wi-Fi 并检查渲染服务器…");
    std::string error;
    if (connectStation(settings_, 15000, error)) {
      networkReady_ = true;
      initializeSntp();
      std::string managerError;
      if (!portal_.startManager(settings_, managerError)) {
        ESP_LOGW(kTag, "LAN manager unavailable: %s", managerError.c_str());
      }
      if (!navigateTo(location_, false, error, "network-configured")) {
        const DisplayVariant *variant = activeVariant();
        if (variant && display_.showFrame(active_.png, *variant,
                                          active_.contentType,
                                          active_.renderProfile,
                                          active_.refreshHint, error)) {
          resetClockPaintState();
        }
      }
    } else {
      networkReady_ = false;
      portal_.start(settings_, error);
      display_.showPortal(configurationApSsid(), "192.168.4.1",
                          "连接失败，请检查 SSID、密码和服务器地址。");
    }
  }
  const int64_t now = esp_timer_get_time();
  if (networkReady_ && !wifiConnected()) {
    networkReady_ = false;
    nextReconnectUs_ = now + 1'000'000;
    ESP_LOGW(kTag, "Wi-Fi disconnected; retaining the active frame");
  }
  if (!networkReady_ && !portal_.running() &&
      !settings_.wifiSsid.empty() && !settings_.serverBaseUrl.empty() &&
      now >= nextReconnectUs_) {
    std::string reconnectError;
    if (connectStation(settings_, 5000, reconnectError)) {
      networkReady_ = true;
      initializeSntp();
      std::string managerError;
      if (!portal_.startManager(settings_, managerError)) {
        ESP_LOGW(kTag, "LAN manager unavailable: %s", managerError.c_str());
      }
      ESP_LOGI(kTag, "Wi-Fi reconnected: %s", stationAddress().c_str());
    } else {
      nextReconnectUs_ = esp_timer_get_time() + 30'000'000;
      ESP_LOGW(kTag, "Wi-Fi reconnect deferred: %s", reconnectError.c_str());
    }
  }
#if defined(CONFIG_INKOS_RSS_SERIAL_HARNESS) && \
    CONFIG_INKOS_RSS_SERIAL_HARNESS
  if (pollRssSerialHarness()) return;
#endif
  handleInput(display_.pollInput());
  tickOrientation();
  tickClock();
}

} // namespace inkos::idf
