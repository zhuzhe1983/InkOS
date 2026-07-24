#include "ink_protocol.h"

#include <cJSON.h>
#include <mbedtls/sha256.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstring>
#include <memory>
#include <set>

namespace inkos::idf {
namespace {

using JsonPtr = std::unique_ptr<cJSON, decltype(&cJSON_Delete)>;

bool fail(std::string &error, const std::string &message) {
  error = message;
  return false;
}

JsonPtr parseJson(const std::string &json, std::string &error) {
  cJSON *root = cJSON_ParseWithLength(json.data(), json.size());
  if (!root || !cJSON_IsObject(root)) {
    if (root) cJSON_Delete(root);
    error = "JSON root is not an object";
    return {nullptr, cJSON_Delete};
  }
  return {root, cJSON_Delete};
}

const char *stringAt(const cJSON *object, const char *key) {
  const cJSON *value = cJSON_GetObjectItemCaseSensitive(object, key);
  return cJSON_IsString(value) && value->valuestring ? value->valuestring
                                                     : nullptr;
}

const cJSON *objectAt(const cJSON *object, const char *key) {
  const cJSON *value = cJSON_GetObjectItemCaseSensitive(object, key);
  return cJSON_IsObject(value) ? value : nullptr;
}

const cJSON *arrayAt(const cJSON *object, const char *key) {
  const cJSON *value = cJSON_GetObjectItemCaseSensitive(object, key);
  return cJSON_IsArray(value) ? value : nullptr;
}

// JSON numbers are IEEE-754 doubles in cJSON. Protocol revisions are allowed
// to use JavaScript-safe integers (the Web generator uses millisecond
// timestamps), so valueint cannot be used: cJSON saturates it at INT32_MAX.
bool safeUintAt(const cJSON *object, const char *key, uint64_t &result) {
  const cJSON *value = cJSON_GetObjectItemCaseSensitive(object, key);
  constexpr double kMaximumJsonSafeInteger = 9007199254740991.0; // 2^53 - 1
  if (!cJSON_IsNumber(value) || !std::isfinite(value->valuedouble) ||
      value->valuedouble < 0 ||
      value->valuedouble > kMaximumJsonSafeInteger ||
      std::floor(value->valuedouble) != value->valuedouble) {
    return false;
  }
  result = static_cast<uint64_t>(value->valuedouble);
  return static_cast<double>(result) == value->valuedouble;
}

bool uintAt(const cJSON *object, const char *key, uint32_t &result) {
  uint64_t parsed = 0;
  if (!safeUintAt(object, key, parsed) || parsed > UINT32_MAX) return false;
  result = static_cast<uint32_t>(parsed);
  return true;
}

bool positiveIntAt(const cJSON *object, const char *key, int32_t &result) {
  const cJSON *value = cJSON_GetObjectItemCaseSensitive(object, key);
  if (!cJSON_IsNumber(value) || value->valuedouble <= 0 ||
      value->valuedouble > INT32_MAX ||
      value->valuedouble != static_cast<double>(value->valueint)) {
    return false;
  }
  result = static_cast<int32_t>(value->valuedouble);
  return true;
}

bool nonnegativeIntAt(const cJSON *object, const char *key, int32_t &result) {
  const cJSON *value = cJSON_GetObjectItemCaseSensitive(object, key);
  if (!cJSON_IsNumber(value) || value->valuedouble < 0 ||
      value->valuedouble > INT32_MAX ||
      value->valuedouble != static_cast<double>(value->valueint)) {
    return false;
  }
  result = static_cast<int32_t>(value->valuedouble);
  return true;
}

bool isBooleanAt(const cJSON *object, const char *key, bool &result) {
  const cJSON *value = cJSON_GetObjectItemCaseSensitive(object, key);
  if (!cJSON_IsBool(value)) return false;
  result = cJSON_IsTrue(value);
  return true;
}

bool validClockId(const char *id) {
  if (!id) return false;
  const size_t size = std::strlen(id);
  if (size == 0 || size > 64 ||
      !((id[0] >= 'a' && id[0] <= 'z') ||
        (id[0] >= '0' && id[0] <= '9'))) {
    return false;
  }
  for (size_t index = 1; index < size; ++index) {
    const char value = id[index];
    if (!((value >= 'a' && value <= 'z') ||
          (value >= '0' && value <= '9') || value == '.' || value == '_' ||
          value == '-')) {
      return false;
    }
  }
  return true;
}

bool parseSemanticVersion(const char *value, std::array<uint32_t, 3> &parts) {
  if (!value) return false;
  const std::string version(value);
  size_t cursor = 0;
  for (size_t part = 0; part < parts.size(); ++part) {
    if (cursor >= version.size() ||
        !std::isdigit(static_cast<unsigned char>(version[cursor]))) {
      return false;
    }
    uint64_t parsed = 0;
    while (cursor < version.size() &&
           std::isdigit(static_cast<unsigned char>(version[cursor]))) {
      parsed = parsed * 10 + static_cast<uint32_t>(version[cursor++] - '0');
      if (parsed > UINT32_MAX) return false;
    }
    parts[part] = static_cast<uint32_t>(parsed);
    if (part + 1 < parts.size() &&
        (cursor >= version.size() || version[cursor++] != '.')) {
      return false;
    }
  }
  if (cursor == version.size()) return true;
  if (version[cursor++] != '-' || cursor == version.size()) return false;
  return std::all_of(version.begin() + cursor, version.end(), [](char value) {
    return std::isalnum(static_cast<unsigned char>(value)) || value == '.' ||
           value == '-';
  });
}

bool versionAtLeast(const char *current, const char *minimum) {
  std::array<uint32_t, 3> currentParts{};
  std::array<uint32_t, 3> minimumParts{};
  return parseSemanticVersion(current, currentParts) &&
         parseSemanticVersion(minimum, minimumParts) &&
         currentParts >= minimumParts;
}

bool boundsInside(const Bounds &bounds, uint16_t width, uint16_t height) {
  return bounds.x >= 0 && bounds.y >= 0 && bounds.width > 0 &&
         bounds.height > 0 &&
         static_cast<int64_t>(bounds.x) + bounds.width <= width &&
         static_cast<int64_t>(bounds.y) + bounds.height <= height;
}

bool overlaps(const Bounds &left, const Bounds &right) {
  return !(static_cast<int64_t>(left.x) + left.width <= right.x ||
           static_cast<int64_t>(right.x) + right.width <= left.x ||
           static_cast<int64_t>(left.y) + left.height <= right.y ||
           static_cast<int64_t>(right.y) + right.height <= left.y);
}

bool parseBounds(const cJSON *object, Bounds &bounds) {
  return object && nonnegativeIntAt(object, "x", bounds.x) &&
         nonnegativeIntAt(object, "y", bounds.y) &&
         positiveIntAt(object, "width", bounds.width) &&
         positiveIntAt(object, "height", bounds.height);
}

bool supportedRequiredCapability(const char *capability) {
  static constexpr std::array<const char *, 7> values = {
      "navigation.parent-v1", "navigation.hitbox-v1",
      "display.font-level-v1", "content-ota.atomic-v1",
      "local-widget.clock-v1", "device.settings-v1",
      "frame.source-image-jpeg-v1"};
  return capability &&
         std::any_of(values.begin(), values.end(), [capability](const char *v) {
           return std::strcmp(v, capability) == 0;
         });
}

bool safeInteractionUrl(const char *url) {
  if (!url) return false;
  const size_t size = std::strlen(url);
  if (size == 0 || size > 2048) return false;
  if (std::strncmp(url, "https://", 8) == 0) return true;
  // These are device-owned, non-network actions. Keep the whitelist exact so
  // an uploaded package cannot turn an arbitrary custom scheme into a fetch.
  static constexpr std::array<const char *, 6> collections = {
      "inkos://collection/rss", "inkos://collection/website",
      "inkos://collection/other", "inkos://app/random-image",
      "inkos://app/baidu-map", "inkos://device/settings"};
  return std::any_of(collections.begin(), collections.end(),
                     [url](const char *value) {
                       return std::strcmp(url, value) == 0;
                     });
}

bool safeFallbackUrl(const char *url) {
  if (!url) return false;
  const size_t size = std::strlen(url);
  if (size <= 8 || size > 2048 || std::strncmp(url, "https://", 8) != 0) {
    return false;
  }
  for (size_t index = 0; index < size; ++index) {
    const unsigned char character = static_cast<unsigned char>(url[index]);
    if (character <= 0x20 || character == 0x7f || character == '\\') {
      return false;
    }
  }
  const char *authority = url + 8;
  const char *authorityEnd = authority + std::strcspn(authority, "/?#");
  if (authority == authorityEnd ||
      std::find(authority, authorityEnd, '@') != authorityEnd) {
    return false;
  }
  if (*authority == '[') {
    const char *closing = std::find(authority, authorityEnd, ']');
    return closing != authorityEnd && closing > authority + 1 &&
           (closing + 1 == authorityEnd ||
            (authorityEnd - closing == 5 &&
             std::strncmp(closing + 1, ":443", 4) == 0));
  }
  const char *port = std::find(authority, authorityEnd, ':');
  if (port == authority) return false;
  return port == authorityEnd ||
         (authorityEnd - port == 4 && std::strncmp(port, ":443", 4) == 0);
}

bool parseVariant(const cJSON *value, DisplayVariant &variant,
                  std::string &error) {
  const char *id = stringAt(value, "id");
  const char *profileId = stringAt(value, "profileId");
  const char *pixelFormat = stringAt(value, "pixelFormat");
  const char *codec = stringAt(value, "codec");
  const cJSON *displayMeta = objectAt(value, "displayMeta");
  const cJSON *logicalSize = objectAt(value, "logicalSize");
  uint32_t profileVersion = 0;
  uint32_t rotation = 0;
  uint32_t width = 0;
  uint32_t height = 0;
  bool invert = false;
  const char *orientation = displayMeta ? stringAt(displayMeta, "orientation")
                                        : nullptr;
  const cJSON *fontValue = displayMeta
                               ? cJSON_GetObjectItemCaseSensitive(displayMeta,
                                                                  "fontLevel")
                               : nullptr;
  if (!id || !profileId || std::strcmp(profileId, kProfileId) != 0 ||
      !uintAt(value, "screenProfileVersion", profileVersion) ||
      profileVersion != kProfileVersion || !displayMeta || !logicalSize ||
      !isBooleanAt(displayMeta, "invert", invert) || !orientation ||
      !fontValue || !cJSON_IsNumber(fontValue) || fontValue->valueint < -2 ||
      fontValue->valueint > 2 ||
      fontValue->valuedouble != static_cast<double>(fontValue->valueint) ||
      !uintAt(logicalSize, "width", width) || width > UINT16_MAX ||
      !uintAt(logicalSize, "height", height) || height > UINT16_MAX ||
      !uintAt(value, "displayRotation", rotation) || rotation > UINT16_MAX ||
      !pixelFormat || std::strcmp(pixelFormat, "gray4") != 0 || !codec ||
      std::strcmp(codec, "png") != 0) {
    return fail(error, "Manifest has an unsupported PaperS3 variant");
  }
  if (!parseOrientation(orientation, variant.meta.orientation)) {
    return fail(error, "Variant has an invalid orientation");
  }
  const bool geometryOk =
      (variant.meta.orientation == Orientation::Portrait && width == 540 &&
       height == 960 && rotation == 90) ||
      (variant.meta.orientation == Orientation::Landscape && width == 960 &&
       height == 540 && rotation == 0);
  if (!geometryOk) {
    return fail(error, "Variant geometry does not match PaperS3");
  }
  variant.id = id;
  variant.profileId = profileId;
  variant.profileVersion = profileVersion;
  variant.meta.fontLevel = static_cast<int8_t>(fontValue->valueint);
  variant.meta.invert = invert;
  variant.width = static_cast<uint16_t>(width);
  variant.height = static_cast<uint16_t>(height);
  variant.rotation = static_cast<uint16_t>(rotation);
  variant.pixelFormat = pixelFormat;
  variant.codec = codec;
  return true;
}

bool parseSourceImage(const cJSON *owner, SourceImageRef &result,
                      std::string &error) {
  const cJSON *value =
      cJSON_GetObjectItemCaseSensitive(owner, "sourceImage");
  if (!value) {
    result = {};
    return true;
  }
  const char *path = cJSON_IsObject(value) ? stringAt(value, "path") : nullptr;
  const char *sha = cJSON_IsObject(value) ? stringAt(value, "sha256") : nullptr;
  const char *mediaType =
      cJSON_IsObject(value) ? stringAt(value, "mediaType") : nullptr;
  const char *fit = cJSON_IsObject(value) ? stringAt(value, "fit") : nullptr;
  const cJSON *pixelSize =
      cJSON_IsObject(value) ? objectAt(value, "pixelSize") : nullptr;
  uint32_t bytes = 0;
  uint32_t width = 0;
  uint32_t height = 0;
  if (!cJSON_IsObject(value) || !path || std::strlen(path) < 5 ||
      std::strcmp(path + std::strlen(path) - 4, ".jpg") != 0 ||
      !uintAt(value, "bytes", bytes) || bytes == 0 ||
      bytes > kMaximumSourceImageBytes || !sha ||
      !isLowerHexSha256(sha) || !mediaType ||
      std::strcmp(mediaType, "image/jpeg") != 0 || !pixelSize ||
      !uintAt(pixelSize, "width", width) || width == 0 || width > 4096 ||
      !uintAt(pixelSize, "height", height) || height == 0 || height > 4096 ||
      static_cast<uint64_t>(width) * height > 12000000ULL || !fit ||
      std::strcmp(fit, "contain") != 0) {
    return fail(error, "Manifest has an invalid source-image reference");
  }
  result.present = true;
  result.path = path;
  result.bytes = bytes;
  result.sha256 = sha;
  result.mediaType = mediaType;
  result.width = static_cast<uint16_t>(width);
  result.height = static_cast<uint16_t>(height);
  result.fit = fit;
  return true;
}

bool parsePage(const cJSON *value, PageRef &page, std::string &error) {
  uint32_t index = 0;
  uint32_t imageBytes = 0;
  uint32_t sidecarBytes = 0;
  const char *imagePath = stringAt(value, "imagePath");
  const char *imageSha = stringAt(value, "imageSha256");
  const char *sidecarPath = stringAt(value, "sidecarPath");
  const char *sidecarSha = stringAt(value, "sidecarSha256");
  if (!uintAt(value, "pageIndex", index) || index > UINT16_MAX ||
      !imagePath || !uintAt(value, "imageBytes", imageBytes) ||
      imageBytes == 0 || imageBytes > kMaximumFrameBytes || !imageSha ||
      !isLowerHexSha256(imageSha) || !sidecarPath ||
      !uintAt(value, "sidecarBytes", sidecarBytes) || sidecarBytes == 0 ||
      sidecarBytes > kMaximumSidecarBytes || !sidecarSha ||
      !isLowerHexSha256(sidecarSha)) {
    return fail(error, "Manifest has an invalid frame reference");
  }
  if (!parseSourceImage(value, page.sourceImage, error)) return false;
  page.index = static_cast<uint16_t>(index);
  page.imagePath = imagePath;
  page.imageBytes = imageBytes;
  page.imageSha256 = imageSha;
  page.sidecarPath = sidecarPath;
  page.sidecarBytes = sidecarBytes;
  page.sidecarSha256 = sidecarSha;
  return true;
}

bool parseDocument(const cJSON *value, const std::set<std::string> &variantIds,
                   DocumentRef &document, std::string &error) {
  const char *uuid = stringAt(value, "uuid");
  const char *parentUuid = stringAt(value, "parentUuid");
  const char *title = stringAt(value, "title");
  const char *kind = stringAt(value, "kind");
  const char *path = stringAt(value, "documentPath");
  const char *sha = stringAt(value, "documentSha256");
  uint32_t bytes = 0;
  const cJSON *variants = arrayAt(value, "variants");
  if (!uuid || !isUuid(uuid) || (parentUuid && !isUuid(parentUuid)) ||
      !title || !kind || !path || !uintAt(value, "documentBytes", bytes) ||
      bytes == 0 || bytes > kMaximumDocumentBytes || !sha ||
      !isLowerHexSha256(sha) || !variants ||
      cJSON_GetArraySize(variants) > 32) {
    return fail(error, "Manifest has an invalid document reference");
  }
  document.uuid = uuid;
  document.parentUuid = parentUuid ? parentUuid : "";
  document.title = title;
  document.kind = kind;
  document.documentPath = path;
  document.documentBytes = bytes;
  document.documentSha256 = sha;
  std::set<std::string> seenVariants;
  cJSON *variantValue = nullptr;
  cJSON_ArrayForEach(variantValue, variants) {
    if (!cJSON_IsObject(variantValue)) {
      return fail(error, "Document variant entry is not an object");
    }
    const char *variantId = stringAt(variantValue, "variantId");
    const cJSON *pages = arrayAt(variantValue, "pages");
    uint32_t pageCount = 0;
    if (!variantId || variantIds.count(variantId) == 0 ||
        !seenVariants.insert(variantId).second || !pages ||
        !uintAt(variantValue, "pageCount", pageCount) || pageCount == 0 ||
        pageCount > 4096 ||
        static_cast<uint32_t>(cJSON_GetArraySize(pages)) != pageCount) {
      return fail(error, "Document has an invalid variant page set");
    }
    VariantPages parsed;
    parsed.variantId = variantId;
    cJSON *pageValue = nullptr;
    cJSON_ArrayForEach(pageValue, pages) {
      PageRef page;
      if (!cJSON_IsObject(pageValue) ||
          !parsePage(pageValue, page, error) ||
          page.index != parsed.pages.size()) {
        if (error.empty()) error = "Frame indexes are not contiguous";
        return false;
      }
      parsed.pages.push_back(std::move(page));
    }
    document.variants.push_back(std::move(parsed));
  }
  return true;
}

bool parseClock(const cJSON *value, uint16_t width, uint16_t height,
                const std::vector<Interaction> &interactions,
                ClockRegion &region, std::string &error) {
  const char *id = stringAt(value, "id");
  const char *kind = stringAt(value, "kind");
  const char *format = stringAt(value, "format");
  const char *timezone = stringAt(value, "timezone");
  const cJSON *bounds = objectAt(value, "bounds");
  const cJSON *style = objectAt(value, "style");
  uint32_t refreshMs = 0;
  uint32_t fullRefreshEvery = 0;
  uint32_t fontSize = 0;
  uint32_t fontWeight = 0;
  if (!validClockId(id) || !kind || std::strcmp(kind, "clock") != 0 ||
      !format || std::strcmp(format, "HH:mm:ss") != 0 || !timezone ||
      std::strcmp(timezone, "Asia/Shanghai") != 0 || !bounds || !style ||
      !parseBounds(bounds, region.bounds) ||
      !uintAt(value, "refreshMs", refreshMs) || refreshMs < 1000 ||
      refreshMs > 60000 ||
      !uintAt(value, "fullRefreshEvery", fullRefreshEvery) ||
      fullRefreshEvery < 1 || fullRefreshEvery > 3600 ||
      !uintAt(style, "fontSize", fontSize) || fontSize < 8 ||
      fontSize > 256 || !uintAt(style, "fontWeight", fontWeight) ||
      (fontWeight != 400 && fontWeight != 700) ||
      !boundsInside(region.bounds, width, height)) {
    return fail(error, "Sidecar has an invalid clock dynamic region");
  }
  const char *family = stringAt(style, "fontFamily");
  const char *horizontal = stringAt(style, "textAlign");
  const char *vertical = stringAt(style, "verticalAlign");
  const char *foreground = stringAt(style, "foreground");
  const char *background = stringAt(style, "background");
  if (!family || std::strcmp(family, "monospace") != 0 || !horizontal ||
      !vertical || !foreground || !background ||
      std::strcmp(foreground, background) == 0 ||
      (std::strcmp(foreground, "black") != 0 &&
       std::strcmp(foreground, "white") != 0) ||
      (std::strcmp(background, "black") != 0 &&
       std::strcmp(background, "white") != 0)) {
    return fail(error, "Sidecar has unsupported clock styling");
  }
  if (std::strcmp(horizontal, "left") == 0) {
    region.style.textAlign = TextAlign::Left;
  } else if (std::strcmp(horizontal, "center") == 0) {
    region.style.textAlign = TextAlign::Center;
  } else if (std::strcmp(horizontal, "right") == 0) {
    region.style.textAlign = TextAlign::Right;
  } else {
    return fail(error, "Clock has an invalid horizontal alignment");
  }
  if (std::strcmp(vertical, "top") == 0) {
    region.style.verticalAlign = VerticalAlign::Top;
  } else if (std::strcmp(vertical, "middle") == 0) {
    region.style.verticalAlign = VerticalAlign::Middle;
  } else if (std::strcmp(vertical, "bottom") == 0) {
    region.style.verticalAlign = VerticalAlign::Bottom;
  } else {
    return fail(error, "Clock has an invalid vertical alignment");
  }
  for (const auto &interaction : interactions) {
    if (overlaps(region.bounds, interaction.bounds)) {
      return fail(error, "Clock region overlaps an interaction");
    }
  }
  region.id = id;
  region.refreshMs = refreshMs;
  region.fullRefreshEvery = fullRefreshEvery;
  region.style.fontSize = fontSize;
  region.style.fontWeight = fontWeight;
  region.style.foregroundWhite = std::strcmp(foreground, "white") == 0;
  region.style.backgroundWhite = std::strcmp(background, "white") == 0;
  return true;
}

bool parseWarningsArray(const cJSON *value, std::vector<std::string> &warnings,
                        std::string &error) {
  if (!cJSON_IsArray(value) || cJSON_GetArraySize(value) > 256) {
    return fail(error, "Frame warnings are not a bounded array");
  }
  cJSON *item = nullptr;
  cJSON_ArrayForEach(item, value) {
    if (!cJSON_IsString(item) || !item->valuestring ||
        std::strlen(item->valuestring) > 2000) {
      return fail(error, "Frame warning is not a bounded string");
    }
    warnings.emplace_back(item->valuestring);
  }
  return true;
}

bool parseFrameInteraction(const cJSON *value,
                           const std::string &documentId, uint16_t width,
                           uint16_t height, Interaction &interaction,
                           std::string &error) {
  const char *contentPath = stringAt(value, "contentPath");
  const char *label = stringAt(value, "label");
  const cJSON *action = objectAt(value, "action");
  const char *type = action ? stringAt(action, "type") : nullptr;
  if (!contentPath || std::strlen(contentPath) == 0 ||
      std::strlen(contentPath) > 512 || !label || std::strlen(label) == 0 ||
      std::strlen(label) > 500 || !type ||
      !parseBounds(objectAt(value, "bounds"), interaction.bounds) ||
      !boundsInside(interaction.bounds, width, height)) {
    return fail(error, "Frame manifest has an invalid interaction");
  }
  if (std::strcmp(type, "open-document") == 0) {
    const char *target = stringAt(action, "documentId");
    if (!target || !isUuid(target)) {
      return fail(error, "Frame interaction has an invalid document target");
    }
    interaction.targetUuid = target;
  } else if (std::strcmp(type, "open-url") == 0) {
    const char *url = stringAt(action, "url");
    if (!safeInteractionUrl(url)) {
      return fail(error, "Frame interaction has an unsafe URL target");
    }
    interaction.targetUuid = documentId;
    interaction.targetUrl = url;
  } else {
    return fail(error, "Frame interaction has an unsupported action");
  }
  interaction.id = contentPath;
  interaction.contentPath = contentPath;
  interaction.label = label;
  return true;
}

} // namespace

const char *orientationName(Orientation value) {
  return value == Orientation::Portrait ? "portrait" : "landscape";
}

bool parseOrientation(const char *value, Orientation &result) {
  if (!value) return false;
  if (std::strcmp(value, "portrait") == 0) {
    result = Orientation::Portrait;
    return true;
  }
  if (std::strcmp(value, "landscape") == 0) {
    result = Orientation::Landscape;
    return true;
  }
  return false;
}

std::string sha256Hex(const uint8_t *data, size_t size) {
  std::array<uint8_t, 32> digest{};
  mbedtls_sha256(data, size, digest.data(), 0);
  static constexpr char hex[] = "0123456789abcdef";
  std::string result(64, '0');
  for (size_t index = 0; index < digest.size(); ++index) {
    result[index * 2] = hex[digest[index] >> 4];
    result[index * 2 + 1] = hex[digest[index] & 0x0f];
  }
  return result;
}

bool isLowerHexSha256(const std::string &value) {
  return value.size() == 64 &&
         std::all_of(value.begin(), value.end(), [](char character) {
           return (character >= '0' && character <= '9') ||
                  (character >= 'a' && character <= 'f');
         });
}

bool isUuid(const std::string &value) {
  if (value.size() != 36) return false;
  for (size_t index = 0; index < value.size(); ++index) {
    if (index == 8 || index == 13 || index == 18 || index == 23) {
      if (value[index] != '-') return false;
    } else if (!std::isxdigit(static_cast<unsigned char>(value[index])) ||
               (value[index] >= 'A' && value[index] <= 'F')) {
      return false;
    }
  }
  return true;
}

bool parseManifest(const std::string &json, const std::string &sha256,
                   const std::string &etag, Manifest &result,
                   std::string &error) {
  JsonPtr root = parseJson(json, error);
  if (!root) return false;
  const char *schema = stringAt(root.get(), "schemaVersion");
  const char *packageId = stringAt(root.get(), "packageId");
  const char *entryUuid = stringAt(root.get(), "entryUuid");
  const char *title = stringAt(root.get(), "title");
  const cJSON *compatibility = objectAt(root.get(), "compatibility");
  const cJSON *variants = arrayAt(root.get(), "variants");
  const cJSON *documents = arrayAt(root.get(), "documents");
  uint32_t revision = 0;
  uint32_t formatMajor = 0;
  const cJSON *minimumClients =
      compatibility ? objectAt(compatibility, "minimumClientVersions")
                    : nullptr;
  const char *minimumPaperS3 =
      minimumClients ? stringAt(minimumClients, "paperS3") : nullptr;
  if (!schema || std::strcmp(schema, "inkos.package/v1") != 0 || !packageId ||
      !isUuid(packageId) || !entryUuid || !isUuid(entryUuid) || !title ||
      !uintAt(root.get(), "revision", revision) || revision == 0 ||
      !compatibility || !uintAt(compatibility, "formatMajor", formatMajor) ||
      formatMajor != 1 || !minimumPaperS3 ||
      !versionAtLeast(kClientVersion, minimumPaperS3) || !variants ||
      cJSON_GetArraySize(variants) == 0 ||
      cJSON_GetArraySize(variants) > 32 || !documents ||
      cJSON_GetArraySize(documents) == 0 ||
      cJSON_GetArraySize(documents) > 2048 || !isLowerHexSha256(sha256)) {
    return fail(error, "Unsupported or malformed inkos.package/v1 manifest");
  }
  const cJSON *required = arrayAt(compatibility, "requiredCapabilities");
  if (!required || cJSON_GetArraySize(required) == 0) {
    return fail(error, "Manifest has no required capability declaration");
  }
  bool sourceImageCapability = false;
  cJSON *item = nullptr;
  cJSON_ArrayForEach(item, required) {
    if (!cJSON_IsString(item) ||
        !supportedRequiredCapability(item->valuestring)) {
      return fail(error, "Manifest requires an unsupported capability");
    }
    if (std::strcmp(item->valuestring, "frame.source-image-jpeg-v1") == 0) {
      sourceImageCapability = true;
    }
  }

  Manifest parsed;
  parsed.packageId = packageId;
  parsed.entryUuid = entryUuid;
  parsed.title = title;
  parsed.revision = revision;
  parsed.sha256 = sha256;
  parsed.strongEtag = etag.empty() ? '"' + sha256 + '"' : etag;
  std::set<std::string> variantIds;
  cJSON *variantValue = nullptr;
  cJSON_ArrayForEach(variantValue, variants) {
    DisplayVariant variant;
    if (!cJSON_IsObject(variantValue) ||
        !parseVariant(variantValue, variant, error) ||
        !variantIds.insert(variant.id).second) {
      if (error.empty()) error = "Manifest has duplicate variants";
      return false;
    }
    parsed.variants.push_back(std::move(variant));
  }
  std::set<std::string> documentIds;
  cJSON *documentValue = nullptr;
  cJSON_ArrayForEach(documentValue, documents) {
    DocumentRef document;
    if (!cJSON_IsObject(documentValue) ||
        !parseDocument(documentValue, variantIds, document, error) ||
        !documentIds.insert(document.uuid).second) {
      if (error.empty()) error = "Manifest has duplicate document UUIDs";
      return false;
    }
    parsed.documents.push_back(std::move(document));
  }
  if (documentIds.count(parsed.entryUuid) == 0) {
    return fail(error, "Manifest entry UUID is not packaged");
  }
  for (const auto &document : parsed.documents) {
    if ((!document.parentUuid.empty() &&
         documentIds.count(document.parentUuid) == 0) ||
        (document.uuid == parsed.entryUuid && !document.parentUuid.empty()) ||
        (document.uuid != parsed.entryUuid && document.parentUuid.empty())) {
      return fail(error, "Manifest parent graph is incomplete");
    }
    for (const auto &pageSet : document.variants) {
      const auto variant = std::find_if(
          parsed.variants.begin(), parsed.variants.end(),
          [&pageSet](const DisplayVariant &candidate) {
            return candidate.id == pageSet.variantId;
          });
      if (variant == parsed.variants.end()) {
        return fail(error, "Manifest source image names an unknown variant");
      }
      for (const auto &page : pageSet.pages) {
        if (!page.sourceImage.present) continue;
        if (!sourceImageCapability || document.kind != "image" ||
            page.sourceImage.path == page.imagePath) {
          return fail(error,
                      "Manifest source image is incompatible with its variant");
        }
      }
    }
  }
  result = std::move(parsed);
  return true;
}

bool parseSidecar(const std::string &json, const std::string &packageId,
                  const std::string &documentUuid, uint16_t pageIndex,
                  const std::string &variantId, Sidecar &result,
                  std::string &error) {
  JsonPtr root = parseJson(json, error);
  if (!root) return false;
  const char *schema = stringAt(root.get(), "schemaVersion");
  const char *actualPackage = stringAt(root.get(), "packageId");
  const char *actualDocument = stringAt(root.get(), "documentUuid");
  const char *parentUuid = stringAt(root.get(), "parentUuid");
  const char *actualVariant = stringAt(root.get(), "variantId");
  const char *imagePath = stringAt(root.get(), "imagePath");
  const char *imageSha = stringAt(root.get(), "imageSha256");
  const cJSON *logicalSize = objectAt(root.get(), "logicalSize");
  const cJSON *interactions = arrayAt(root.get(), "interactions");
  uint32_t actualPage = 0;
  uint32_t pageCount = 0;
  uint32_t width = 0;
  uint32_t height = 0;
  if (!schema || std::strcmp(schema, "inkos.frame-sidecar/v1") != 0 ||
      !actualPackage || packageId != actualPackage || !actualDocument ||
      documentUuid != actualDocument || (parentUuid && !isUuid(parentUuid)) ||
      !actualVariant || (!variantId.empty() && variantId != actualVariant) ||
      !uintAt(root.get(), "pageIndex", actualPage) ||
      (pageIndex != UINT16_MAX && actualPage != pageIndex) ||
      !uintAt(root.get(), "pageCount", pageCount) || pageCount == 0 ||
      actualPage >= pageCount || !imagePath || imagePath[0] == '\0' ||
      !imageSha || !isLowerHexSha256(imageSha) ||
      !logicalSize || !uintAt(logicalSize, "width", width) || width == 0 ||
      width > UINT16_MAX || !uintAt(logicalSize, "height", height) ||
      height == 0 || height > UINT16_MAX || !interactions ||
      cJSON_GetArraySize(interactions) > 256) {
    return fail(error, "Sidecar does not describe the requested frame");
  }
  Sidecar parsed;
  parsed.packageId = actualPackage;
  parsed.documentUuid = actualDocument;
  parsed.parentUuid = parentUuid ? parentUuid : "";
  parsed.variantId = actualVariant;
  parsed.pageIndex = actualPage;
  parsed.pageCount = pageCount;
  parsed.width = width;
  parsed.height = height;
  parsed.imagePath = imagePath;
  parsed.imageSha256 = imageSha;
  if (!parseSourceImage(root.get(), parsed.sourceImage, error)) return false;
  cJSON *value = nullptr;
  cJSON_ArrayForEach(value, interactions) {
    const char *id = stringAt(value, "id");
    const char *contentPath = stringAt(value, "contentPath");
    const char *label = stringAt(value, "label");
    const char *targetUuid = stringAt(value, "targetUuid");
    const char *targetUrl = stringAt(value, "targetUrl");
    const char *fallbackUrl = stringAt(value, "fallbackUrl");
    Interaction interaction;
    if (!cJSON_IsObject(value) || !id || !contentPath || !label || !targetUuid ||
        !isUuid(targetUuid) || !parseBounds(objectAt(value, "bounds"),
                                            interaction.bounds) ||
        !boundsInside(interaction.bounds, parsed.width, parsed.height) ||
        (targetUrl && !safeInteractionUrl(targetUrl)) ||
        (fallbackUrl && !safeFallbackUrl(fallbackUrl)) ||
        (targetUrl && fallbackUrl)) {
      return fail(error, "Sidecar has an invalid interaction");
    }
    interaction.id = id;
    interaction.contentPath = contentPath;
    interaction.label = label;
    interaction.targetUuid = targetUuid;
    interaction.targetUrl = targetUrl ? targetUrl : "";
    interaction.fallbackUrl = fallbackUrl ? fallbackUrl : "";
    parsed.interactions.push_back(std::move(interaction));
  }
  const cJSON *dynamic = arrayAt(root.get(), "dynamicRegions");
  if (dynamic) {
    if (cJSON_GetArraySize(dynamic) > 8) {
      return fail(error, "Sidecar has too many dynamic regions");
    }
    std::set<std::string> ids;
    cJSON_ArrayForEach(value, dynamic) {
      ClockRegion region;
      if (!cJSON_IsObject(value) ||
          !parseClock(value, parsed.width, parsed.height, parsed.interactions,
                      region, error) ||
          !ids.insert(region.id).second) {
        if (error.empty()) error = "Sidecar has duplicate clock region IDs";
        return false;
      }
      parsed.dynamicRegions.push_back(std::move(region));
    }
  }
  result = std::move(parsed);
  return true;
}

bool parseOnDemandFrame(const std::string &json, OnDemandFrame &result,
                        std::string &error) {
  JsonPtr root = parseJson(json, error);
  if (!root) return false;
  const char *schema = stringAt(root.get(), "schemaVersion");
  const char *rendererVersion = stringAt(root.get(), "rendererVersion");
  const char *frameId = stringAt(root.get(), "frameId");
  const char *documentId = stringAt(root.get(), "documentId");
  const char *contentType = stringAt(root.get(), "contentType");
  const char *profileId = stringAt(root.get(), "screenProfileId");
  const char *pixelFormat = stringAt(root.get(), "pixelFormat");
  const char *layoutStrategy = stringAt(root.get(), "layoutStrategy");
  const char *rasterStrategy = stringAt(root.get(), "rasterStrategy");
  const char *codec = stringAt(root.get(), "codec");
  const char *sha = stringAt(root.get(), "sha256");
  const char *crc32 = stringAt(root.get(), "crc32");
  const cJSON *nativeSize = objectAt(root.get(), "nativeSize");
  const cJSON *logicalSize = objectAt(root.get(), "logicalSize");
  const cJSON *display = objectAt(root.get(), "displayMeta");
  const cJSON *pagination = objectAt(root.get(), "pagination");
  const cJSON *update = objectAt(root.get(), "update");
  const cJSON *interactions = arrayAt(root.get(), "interactions");
  const cJSON *warnings = arrayAt(root.get(), "warnings");
  const cJSON *refreshHintValue =
      cJSON_GetObjectItemCaseSensitive(root.get(), "refreshHint");
  const char *refreshHint =
      cJSON_IsString(refreshHintValue) && refreshHintValue->valuestring
          ? refreshHintValue->valuestring
          : nullptr;
  uint64_t documentRevision = 0;
  uint32_t profileVersion = 0;
  uint32_t nativeWidth = 0;
  uint32_t nativeHeight = 0;
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t rotation = 0;
  uint32_t pageIndex = 0;
  uint32_t pageCount = 0;
  uint32_t payloadBytes = 0;
  bool invert = false;
  bool hasPrevious = false;
  bool hasNext = false;
  const char *orientation = display ? stringAt(display, "orientation") : nullptr;
  const cJSON *fontLevel =
      display ? cJSON_GetObjectItemCaseSensitive(display, "fontLevel")
              : nullptr;
  if (!schema || std::strcmp(schema, "inkos.frame/v2") != 0 ||
      !rendererVersion || std::strlen(rendererVersion) == 0 ||
      std::strlen(rendererVersion) > 128 || !frameId ||
      std::strlen(frameId) != 24 ||
      !std::all_of(frameId, frameId + 24, [](char value) {
        return (value >= '0' && value <= '9') ||
               (value >= 'a' && value <= 'f');
      }) ||
      !documentId || !isUuid(documentId) ||
      !safeUintAt(root.get(), "documentRevision", documentRevision) ||
      documentRevision == 0 || !contentType ||
      (std::strcmp(contentType, "detail") != 0 &&
       std::strcmp(contentType, "list") != 0 &&
       std::strcmp(contentType, "reader") != 0 &&
       std::strcmp(contentType, "image") != 0) ||
      !profileId || std::strcmp(profileId, kProfileId) != 0 ||
      !uintAt(root.get(), "screenProfileVersion", profileVersion) ||
      profileVersion != kProfileVersion || !nativeSize || !logicalSize ||
      !uintAt(nativeSize, "width", nativeWidth) || nativeWidth != 960 ||
      !uintAt(nativeSize, "height", nativeHeight) || nativeHeight != 540 ||
      !uintAt(logicalSize, "width", width) || width > UINT16_MAX ||
      !uintAt(logicalSize, "height", height) || height > UINT16_MAX ||
      !uintAt(root.get(), "displayRotation", rotation) ||
      rotation > UINT16_MAX || !pixelFormat ||
      std::strcmp(pixelFormat, "gray4") != 0 || !layoutStrategy ||
      std::strcmp(layoutStrategy, "paper-s3-semantic-v1") != 0 ||
      !rasterStrategy ||
      std::strcmp(rasterStrategy, "eink-gray4-png-v1") != 0 || !display ||
      !orientation || !fontLevel || !cJSON_IsNumber(fontLevel) ||
      fontLevel->valueint < -2 || fontLevel->valueint > 2 ||
      fontLevel->valuedouble != static_cast<double>(fontLevel->valueint) ||
      !isBooleanAt(display, "invert", invert) || !codec ||
      std::strcmp(codec, "png") != 0 || !pagination ||
      !uintAt(pagination, "pageIndex", pageIndex) || pageIndex > UINT16_MAX ||
      !uintAt(pagination, "pageCount", pageCount) || pageCount == 0 ||
      pageCount > UINT16_MAX || pageIndex >= pageCount ||
      !isBooleanAt(pagination, "hasPrevious", hasPrevious) ||
      !isBooleanAt(pagination, "hasNext", hasNext) ||
      hasPrevious != (pageIndex > 0) || hasNext != (pageIndex + 1 < pageCount) ||
      !uintAt(root.get(), "payloadBytes", payloadBytes) || payloadBytes == 0 ||
      payloadBytes > kMaximumFrameBytes || !sha || !isLowerHexSha256(sha) ||
      !crc32 || std::strlen(crc32) != 8 ||
      !std::all_of(crc32, crc32 + 8, [](char value) {
        return (value >= '0' && value <= '9') ||
               (value >= 'a' && value <= 'f');
      }) ||
      !update || !interactions || cJSON_GetArraySize(interactions) > 256 ||
      !warnings ||
      (refreshHintValue &&
       (!refreshHint || std::strcmp(refreshHint, "binary-text") != 0))) {
    return fail(error, "On-demand frame manifest is malformed or unsupported");
  }

  OnDemandFrame parsed;
  if (!parseOrientation(orientation, parsed.meta.orientation)) {
    return fail(error, "On-demand frame has an invalid orientation");
  }
  const bool geometryOk =
      (parsed.meta.orientation == Orientation::Portrait && width == 540 &&
       height == 960 && rotation == 90) ||
      (parsed.meta.orientation == Orientation::Landscape && width == 960 &&
       height == 540 && rotation == 0);
  const char *updateKind = stringAt(update, "kind");
  if (!geometryOk || !updateKind || std::strcmp(updateKind, "full") != 0 ||
      !parseBounds(objectAt(update, "region"), parsed.updateRegion) ||
      parsed.updateRegion.x != 0 || parsed.updateRegion.y != 0 ||
      parsed.updateRegion.width != static_cast<int32_t>(width) ||
      parsed.updateRegion.height != static_cast<int32_t>(height)) {
    return fail(error, "On-demand frame geometry/update region is invalid");
  }
  parsed.documentId = documentId;
  parsed.documentRevision = documentRevision;
  parsed.contentType = contentType;
  parsed.profileVersion = profileVersion;
  parsed.nativeWidth = nativeWidth;
  parsed.nativeHeight = nativeHeight;
  parsed.width = width;
  parsed.height = height;
  parsed.rotation = rotation;
  parsed.meta.fontLevel = static_cast<int8_t>(fontLevel->valueint);
  parsed.meta.invert = invert;
  parsed.pageIndex = pageIndex;
  parsed.pageCount = pageCount;
  parsed.hasPrevious = hasPrevious;
  parsed.hasNext = hasNext;
  parsed.payloadBytes = payloadBytes;
  parsed.sha256 = sha;
  if (refreshHint) parsed.refreshHint = refreshHint;
  cJSON *interactionValue = nullptr;
  cJSON_ArrayForEach(interactionValue, interactions) {
    Interaction interaction;
    if (!cJSON_IsObject(interactionValue) ||
        !parseFrameInteraction(interactionValue, parsed.documentId,
                               parsed.width, parsed.height, interaction,
                               error)) {
      return false;
    }
    parsed.interactions.push_back(std::move(interaction));
  }
  if (!parseWarningsArray(warnings, parsed.warnings, error)) return false;
  result = std::move(parsed);
  return true;
}

bool parseWarningList(const std::string &json, std::vector<std::string> &result,
                      std::string &error) {
  cJSON *value = cJSON_ParseWithLength(json.data(), json.size());
  if (!value) return fail(error, "Render warnings header is invalid JSON");
  std::unique_ptr<cJSON, decltype(&cJSON_Delete)> root(value, cJSON_Delete);
  std::vector<std::string> parsed;
  if (!parseWarningsArray(root.get(), parsed, error)) return false;
  result = std::move(parsed);
  return true;
}

bool validateDocumentEnvelope(const std::string &json,
                              const DocumentRef &reference,
                              std::string &error,
                              uint64_t *contentRevision) {
  JsonPtr root = parseJson(json, error);
  if (!root) return false;
  const char *schema = stringAt(root.get(), "schemaVersion");
  const char *uuid = stringAt(root.get(), "uuid");
  const char *parentUuid = stringAt(root.get(), "parentUuid");
  const cJSON *content = objectAt(root.get(), "content");
  const char *contentId = content ? stringAt(content, "id") : nullptr;
  const char *contentSchema = content ? stringAt(content, "schemaVersion")
                                      : nullptr;
  const cJSON *page = content ? objectAt(content, "page") : nullptr;
  const char *pageKind = page ? stringAt(page, "kind") : nullptr;
  uint64_t revision = 0;
  if (!schema || std::strcmp(schema, "inkos.document/v1") != 0 || !uuid ||
      reference.uuid != uuid || (parentUuid ? parentUuid : "") !=
                                      reference.parentUuid ||
      !contentSchema || std::strcmp(contentSchema, "inkos.content/v2") != 0 ||
      !contentId || reference.uuid != contentId || !pageKind ||
      reference.kind != pageKind ||
      !safeUintAt(content, "revision", revision) || revision == 0) {
    return fail(error, "Document envelope does not match its manifest ref");
  }
  if (contentRevision) *contentRevision = revision;
  return true;
}

const DisplayVariant *selectVariant(const Manifest &manifest,
                                    const DisplayMeta &meta) {
  const auto found = std::find_if(
      manifest.variants.begin(), manifest.variants.end(),
      [&meta](const DisplayVariant &variant) {
        return variant.profileId == kProfileId &&
               variant.profileVersion == kProfileVersion &&
               variant.meta.orientation == meta.orientation &&
               variant.meta.fontLevel == meta.fontLevel &&
               variant.meta.invert == meta.invert;
      });
  return found == manifest.variants.end() ? nullptr : &*found;
}

const DisplayVariant *selectVariantWithBaseFallback(
    const Manifest &manifest, const DisplayMeta &meta) {
  if (const DisplayVariant *exact = selectVariant(manifest, meta)) {
    return exact;
  }
  DisplayMeta base = meta;
  base.fontLevel = 0;
  base.invert = false;
  return selectVariant(manifest, base);
}

const DocumentRef *findDocument(const Manifest &manifest,
                                const std::string &uuid) {
  const auto found = std::find_if(
      manifest.documents.begin(), manifest.documents.end(),
      [&uuid](const DocumentRef &document) { return document.uuid == uuid; });
  return found == manifest.documents.end() ? nullptr : &*found;
}

const PageRef *findPage(const DocumentRef &document,
                        const std::string &variantId, uint16_t pageIndex) {
  const auto variant = std::find_if(
      document.variants.begin(), document.variants.end(),
      [&variantId](const VariantPages &value) {
        return value.variantId == variantId;
      });
  if (variant == document.variants.end() || pageIndex >= variant->pages.size()) {
    return nullptr;
  }
  return &variant->pages[pageIndex];
}

const Interaction *hitTest(const Sidecar &sidecar, int32_t x, int32_t y) {
  const Interaction *best = nullptr;
  for (const auto &interaction : sidecar.interactions) {
    if (!interaction.bounds.contains(x, y)) continue;
    if (!best || interaction.bounds.area() < best->bounds.area()) {
      best = &interaction;
    }
  }
  return best;
}

} // namespace inkos::idf
