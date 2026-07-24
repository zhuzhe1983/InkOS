#include "package_catalog.h"

#include <mbedtls/sha256.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cstring>
#include <initializer_list>

namespace inkos::paper {
namespace {

constexpr size_t kMaxManifestBytes = 2U * 1024U * 1024U;
constexpr size_t kMaxJsonArtifactBytes = 2U * 1024U * 1024U;
constexpr size_t kMaxDocuments = 2048;
constexpr size_t kMaxVariants = 64;
constexpr size_t kMaxPagesPerVariant = 4096;
constexpr size_t kMaxInteractions = 256;
constexpr size_t kMaxDynamicRegions = 8;

const char *kCapabilities[] = {
    "navigation.parent-v1", "navigation.hitbox-v1",
    "display.font-level-v1", "display.invert-v1",
    "content-ota.atomic-v1",
};

bool fail(std::string &error, const std::string &message) {
  error = message;
  return false;
}

bool isHex(char value) {
  return (value >= '0' && value <= '9') || (value >= 'a' && value <= 'f');
}

bool isValidUtf8(const std::string &value) {
  for (size_t index = 0; index < value.size();) {
    const uint8_t first = static_cast<uint8_t>(value[index]);
    if (first <= 0x7f) {
      ++index;
      continue;
    }
    size_t length = 0;
    uint8_t secondMinimum = 0x80;
    uint8_t secondMaximum = 0xbf;
    if (first >= 0xc2 && first <= 0xdf) {
      length = 2;
    } else if (first == 0xe0) {
      length = 3;
      secondMinimum = 0xa0;
    } else if (first >= 0xe1 && first <= 0xec) {
      length = 3;
    } else if (first == 0xed) {
      length = 3;
      secondMaximum = 0x9f;
    } else if (first >= 0xee && first <= 0xef) {
      length = 3;
    } else if (first == 0xf0) {
      length = 4;
      secondMinimum = 0x90;
    } else if (first >= 0xf1 && first <= 0xf3) {
      length = 4;
    } else if (first == 0xf4) {
      length = 4;
      secondMaximum = 0x8f;
    } else {
      return false;
    }
    if (index + length > value.size()) {
      return false;
    }
    const uint8_t second = static_cast<uint8_t>(value[index + 1]);
    if (second < secondMinimum || second > secondMaximum) {
      return false;
    }
    for (size_t continuation = 2; continuation < length; ++continuation) {
      const uint8_t byte = static_cast<uint8_t>(value[index + continuation]);
      if (byte < 0x80 || byte > 0xbf) {
        return false;
      }
    }
    index += length;
  }
  return true;
}

bool isUuid(const std::string &value) {
  if (value.size() != 36) {
    return false;
  }
  for (size_t index = 0; index < value.size(); ++index) {
    if (index == 8 || index == 13 || index == 18 || index == 23) {
      if (value[index] != '-') {
        return false;
      }
    } else if (!isHex(value[index])) {
      return false;
    }
  }
  return true;
}

bool isSha256(const std::string &value) {
  return value.size() == 64 &&
         std::all_of(value.begin(), value.end(), isHex);
}

bool supportedCapability(const std::string &value) {
  for (const char *capability : kCapabilities) {
    if (value == capability) {
      return true;
    }
  }
  return false;
}

bool supportedPixelFormat(const std::string &value) {
  return value == "mono1" || value == "gray4" || value == "spectra6";
}

bool supportedContentKind(const std::string &value) {
  return value == "detail" || value == "list" || value == "reader" ||
         value == "image";
}

bool isPaperS3Geometry(const DisplayVariant &variant) {
  if (variant.orientation == "portrait") {
    return variant.width == 540 && variant.height == 960 &&
           variant.displayRotation == 90;
  }
  if (variant.orientation == "landscape") {
    return variant.width == 960 && variant.height == 540 &&
           variant.displayRotation == 0;
  }
  return false;
}

bool parseVersion(const std::string &value, std::array<uint32_t, 3> &parts) {
  size_t cursor = 0;
  for (size_t part = 0; part < parts.size(); ++part) {
    if (cursor >= value.size() || !std::isdigit(value[cursor])) {
      return false;
    }
    uint64_t result = 0;
    while (cursor < value.size() && std::isdigit(value[cursor])) {
      result = result * 10 + static_cast<uint32_t>(value[cursor++] - '0');
      if (result > UINT32_MAX) {
        return false;
      }
    }
    parts[part] = static_cast<uint32_t>(result);
    if (part + 1 < parts.size()) {
      if (cursor >= value.size() || value[cursor++] != '.') {
        return false;
      }
    }
  }
  return cursor == value.size() || value[cursor] == '-';
}

bool versionAtLeast(const std::string &current, const std::string &minimum) {
  std::array<uint32_t, 3> currentParts{};
  std::array<uint32_t, 3> minimumParts{};
  if (!parseVersion(current, currentParts) ||
      !parseVersion(minimum, minimumParts)) {
    return false;
  }
  return currentParts >= minimumParts;
}

bool readJson(fs::FS &fs, const std::string &path, size_t limit,
              JsonDocument &document, std::string &error) {
  File file = fs.open(path.c_str(), FILE_READ);
  if (!file || file.isDirectory()) {
    return fail(error, "Missing JSON file: " + path);
  }
  const size_t size = file.size();
  if (size == 0 || size > limit) {
    file.close();
    return fail(error, "JSON file exceeds size limit: " + path);
  }
  const DeserializationError parseError = deserializeJson(
      document, file, DeserializationOption::NestingLimit(32));
  file.close();
  if (parseError) {
    return fail(error, "Invalid JSON in " + path + ": " + parseError.c_str());
  }
  if (!document.is<JsonObject>()) {
    return fail(error, "JSON root must be an object: " + path);
  }
  return true;
}

bool verifyLengthAndHash(fs::FS &fs, const std::string &path,
                         uint32_t expectedBytes,
                         const std::string &expectedSha,
                         std::string &error) {
  File file = fs.open(path.c_str(), FILE_READ);
  if (!file || file.isDirectory()) {
    return fail(error, "Missing declared artifact: " + path);
  }
  const size_t actualSize = file.size();
  file.close();
  if (actualSize != expectedBytes) {
    return fail(error, "Length mismatch for " + path);
  }
  std::string actualSha;
  if (!sha256File(fs, path, actualSha, error)) {
    return false;
  }
  if (actualSha != expectedSha) {
    return fail(error, "SHA-256 mismatch for " + path);
  }
  return true;
}

bool pngDimensions(fs::FS &fs, const std::string &path, uint16_t expectedWidth,
                   uint16_t expectedHeight, std::string &error) {
  static constexpr uint8_t signature[] = {0x89, 'P', 'N', 'G', 0x0d, 0x0a,
                                           0x1a, 0x0a};
  uint8_t header[24]{};
  File file = fs.open(path.c_str(), FILE_READ);
  if (!file || file.read(header, sizeof(header)) != sizeof(header)) {
    if (file) {
      file.close();
    }
    return fail(error, "Truncated PNG: " + path);
  }
  file.close();
  if (memcmp(header, signature, sizeof(signature)) != 0 ||
      memcmp(header + 12, "IHDR", 4) != 0) {
    return fail(error, "Invalid PNG signature/IHDR: " + path);
  }
  const uint32_t width = (static_cast<uint32_t>(header[16]) << 24) |
                         (static_cast<uint32_t>(header[17]) << 16) |
                         (static_cast<uint32_t>(header[18]) << 8) | header[19];
  const uint32_t height = (static_cast<uint32_t>(header[20]) << 24) |
                          (static_cast<uint32_t>(header[21]) << 16) |
                          (static_cast<uint32_t>(header[22]) << 8) | header[23];
  if (width != expectedWidth || height != expectedHeight) {
    return fail(error, "PNG dimensions do not match variant: " + path);
  }
  return true;
}

bool collectFiles(fs::FS &fs, const std::string &root,
                  const std::string &current,
                  std::vector<std::string> &relativePaths,
                  std::string &error) {
  File directory = fs.open(current.c_str(), FILE_READ);
  if (!directory || !directory.isDirectory()) {
    return fail(error, "Package root is not a directory: " + current);
  }
  File entry = directory.openNextFile();
  while (entry) {
    std::string fullPath = entry.path();
    const bool directoryEntry = entry.isDirectory();
    entry.close();
    if (directoryEntry) {
      if (!collectFiles(fs, root, fullPath, relativePaths, error)) {
        directory.close();
        return false;
      }
    } else {
      std::string prefix = root;
      if (prefix.back() != '/') {
        prefix += '/';
      }
      if (fullPath.rfind(prefix, 0) != 0) {
        directory.close();
        return fail(error, "Artifact escaped package root: " + fullPath);
      }
      relativePaths.push_back(fullPath.substr(prefix.size()));
    }
    entry = directory.openNextFile();
  }
  directory.close();
  return true;
}

const char *requiredString(JsonObjectConst object, const char *key) {
  return object[key].is<const char *>() ? object[key].as<const char *>() : nullptr;
}

bool hasOnlyKeys(JsonObjectConst object,
                 std::initializer_list<const char *> allowed) {
  for (JsonPairConst pair : object) {
    const char *key = pair.key().c_str();
    if (std::none_of(allowed.begin(), allowed.end(),
                     [key](const char *candidate) {
                       return std::strcmp(key, candidate) == 0;
                     })) {
      return false;
    }
  }
  return true;
}

bool validDynamicRegionId(const char *value) {
  if (!value) {
    return false;
  }
  const size_t length = std::strlen(value);
  if (length == 0 || length > 64 ||
      !((value[0] >= 'a' && value[0] <= 'z') ||
        (value[0] >= '0' && value[0] <= '9'))) {
    return false;
  }
  for (size_t index = 1; index < length; ++index) {
    const char character = value[index];
    if (!((character >= 'a' && character <= 'z') ||
          (character >= '0' && character <= '9') || character == '.' ||
          character == '_' || character == '-')) {
      return false;
    }
  }
  return true;
}

bool parseClockRegion(JsonObjectConst object, uint16_t frameWidth,
                      uint16_t frameHeight, ClockRegion &result,
                      std::string &error) {
  if (!hasOnlyKeys(object, {"id", "kind", "bounds", "format", "timezone",
                            "refreshMs", "fullRefreshEvery", "style"})) {
    return fail(error, "Dynamic clock region contains unsupported fields");
  }
  const char *id = requiredString(object, "id");
  const char *kind = requiredString(object, "kind");
  const char *format = requiredString(object, "format");
  const char *timezone = requiredString(object, "timezone");
  JsonObjectConst bounds = object["bounds"].as<JsonObjectConst>();
  JsonObjectConst style = object["style"].as<JsonObjectConst>();
  if (!validDynamicRegionId(id) || !kind || std::strcmp(kind, "clock") != 0 ||
      !format || std::strcmp(format, "HH:mm:ss") != 0 || !timezone ||
      std::strcmp(timezone, "Asia/Shanghai") != 0 || bounds.isNull() ||
      style.isNull() ||
      !hasOnlyKeys(bounds, {"x", "y", "width", "height"}) ||
      !hasOnlyKeys(style, {"fontFamily", "fontSize", "fontWeight", "textAlign",
                           "verticalAlign", "foreground", "background"}) ||
      bounds.size() != 4 || style.size() != 7 ||
      !bounds["x"].is<int32_t>() || !bounds["y"].is<int32_t>() ||
      !bounds["width"].is<int32_t>() || !bounds["height"].is<int32_t>() ||
      !object["refreshMs"].is<uint32_t>() ||
      !object["fullRefreshEvery"].is<uint16_t>() ||
      !style["fontSize"].is<uint16_t>() ||
      !style["fontWeight"].is<uint16_t>()) {
    return fail(error, "Invalid dynamic clock region fields");
  }

  ClockRegion parsed;
  parsed.id = id;
  parsed.bounds = {
      bounds["x"].as<int32_t>(), bounds["y"].as<int32_t>(),
      bounds["width"].as<int32_t>(), bounds["height"].as<int32_t>(),
  };
  parsed.refreshMs = object["refreshMs"].as<uint32_t>();
  parsed.fullRefreshEvery = object["fullRefreshEvery"].as<uint16_t>();
  parsed.style.fontSize = style["fontSize"].as<uint16_t>();
  parsed.style.fontWeight = style["fontWeight"].as<uint16_t>();
  const char *fontFamily = requiredString(style, "fontFamily");
  const char *textAlign = requiredString(style, "textAlign");
  const char *verticalAlign = requiredString(style, "verticalAlign");
  const char *foreground = requiredString(style, "foreground");
  const char *background = requiredString(style, "background");
  if (!inkos::clockBoundsInside(parsed.bounds, frameWidth, frameHeight) ||
      parsed.refreshMs < 1000 || parsed.refreshMs > 60000 ||
      parsed.fullRefreshEvery < 1 || parsed.fullRefreshEvery > 3600 ||
      parsed.style.fontSize < 8 || parsed.style.fontSize > 256 ||
      (parsed.style.fontWeight != 400 && parsed.style.fontWeight != 700) ||
      !fontFamily || std::strcmp(fontFamily, "monospace") != 0 ||
      !textAlign || !verticalAlign || !foreground || !background) {
    return fail(error, "Unsupported dynamic clock region values");
  }

  if (std::strcmp(textAlign, "left") == 0) {
    parsed.style.textAlign = ClockTextAlign::Left;
  } else if (std::strcmp(textAlign, "center") == 0) {
    parsed.style.textAlign = ClockTextAlign::Center;
  } else if (std::strcmp(textAlign, "right") == 0) {
    parsed.style.textAlign = ClockTextAlign::Right;
  } else {
    return fail(error, "Unsupported dynamic clock horizontal alignment");
  }
  if (std::strcmp(verticalAlign, "top") == 0) {
    parsed.style.verticalAlign = ClockVerticalAlign::Top;
  } else if (std::strcmp(verticalAlign, "middle") == 0) {
    parsed.style.verticalAlign = ClockVerticalAlign::Middle;
  } else if (std::strcmp(verticalAlign, "bottom") == 0) {
    parsed.style.verticalAlign = ClockVerticalAlign::Bottom;
  } else {
    return fail(error, "Unsupported dynamic clock vertical alignment");
  }
  if ((std::strcmp(foreground, "black") != 0 &&
       std::strcmp(foreground, "white") != 0) ||
      (std::strcmp(background, "black") != 0 &&
       std::strcmp(background, "white") != 0) ||
      std::strcmp(foreground, background) == 0) {
    return fail(error, "Unsupported dynamic clock colors");
  }
  parsed.style.foregroundWhite = std::strcmp(foreground, "white") == 0;
  parsed.style.backgroundWhite = std::strcmp(background, "white") == 0;
  result = std::move(parsed);
  return true;
}

bool overlaps(const inkos::ClockBounds &left, const inkos::Bounds &right) {
  return !(static_cast<int64_t>(left.x) + left.width <= right.x ||
           static_cast<int64_t>(right.x) + right.width <= left.x ||
           static_cast<int64_t>(left.y) + left.height <= right.y ||
           static_cast<int64_t>(right.y) + right.height <= left.y);
}

} // namespace

std::string joinPath(const std::string &root, const std::string &relative) {
  if (root.empty()) {
    return relative;
  }
  if (root.back() == '/') {
    return root + relative;
  }
  return root + "/" + relative;
}

bool isNormalizedArchivePath(const std::string &path) {
  if (path.empty() || path.size() > 512 || path.front() == '/' ||
      path.find('\\') != std::string::npos ||
      path.find('\0') != std::string::npos || !isValidUtf8(path)) {
    return false;
  }
  size_t start = 0;
  while (start <= path.size()) {
    const size_t end = path.find('/', start);
    const std::string segment = path.substr(start, end - start);
    if (segment.empty() || segment == "." || segment == "..") {
      return false;
    }
    for (unsigned char value : segment) {
      if (value < 0x20 || value == 0x7f) {
        return false;
      }
    }
    if (end == std::string::npos) {
      break;
    }
    start = end + 1;
  }
  return true;
}

bool sha256File(fs::FS &fs, const std::string &path, std::string &digest,
                std::string &error) {
  File file = fs.open(path.c_str(), FILE_READ);
  if (!file || file.isDirectory()) {
    return fail(error, "Cannot hash file: " + path);
  }
  mbedtls_sha256_context context;
  mbedtls_sha256_init(&context);
  mbedtls_sha256_starts(&context, 0);
  uint8_t buffer[4096];
  while (file.available()) {
    const size_t count = file.read(buffer, sizeof(buffer));
    if (count == 0) {
      file.close();
      mbedtls_sha256_free(&context);
      return fail(error, "Failed while hashing: " + path);
    }
    mbedtls_sha256_update(&context, buffer, count);
  }
  file.close();
  uint8_t bytes[32]{};
  mbedtls_sha256_finish(&context, bytes);
  mbedtls_sha256_free(&context);
  static constexpr char alphabet[] = "0123456789abcdef";
  digest.resize(64);
  for (size_t index = 0; index < sizeof(bytes); ++index) {
    digest[index * 2] = alphabet[bytes[index] >> 4];
    digest[index * 2 + 1] = alphabet[bytes[index] & 0x0f];
  }
  return true;
}

bool PackageCatalog::loadAndVerify(fs::FS &fs, const std::string &rootPath,
                                   std::string &error) {
  fs_ = &fs;
  rootPath_ = rootPath;
  packageId_.clear();
  entryUuid_.clear();
  title_.clear();
  revision_ = 0;
  activeVariantId_.clear();
  variants_.clear();
  documents_.clear();
  declaredPaths_.clear();

  JsonDocument manifest;
  if (!readJson(fs, joinPath(rootPath, "ink-manifest.json"),
                kMaxManifestBytes, manifest, error)) {
    return false;
  }
  JsonObjectConst root = manifest.as<JsonObjectConst>();
  if (!parseManifest(root, error) || !validateCompatibility(root, error) ||
      !verifyDeclaredFiles(error) || !verifyDocuments(error)) {
    return false;
  }
  return true;
}

bool PackageCatalog::parseManifest(JsonObjectConst root, std::string &error) {
  const char *schema = requiredString(root, "schemaVersion");
  const char *package = requiredString(root, "packageId");
  const char *entry = requiredString(root, "entryUuid");
  const char *manifestTitle = requiredString(root, "title");
  if (!schema || strcmp(schema, "inkos.package/v1") != 0 || !package ||
      !entry || !manifestTitle || !isUuid(package) || !isUuid(entry) ||
      !root["revision"].is<uint32_t>() || root["revision"].as<uint32_t>() == 0) {
    return fail(error, "Invalid inkos.package/v1 identity fields");
  }
  packageId_ = package;
  entryUuid_ = entry;
  title_ = manifestTitle;
  revision_ = root["revision"].as<uint32_t>();

  JsonArrayConst variants = root["variants"].as<JsonArrayConst>();
  if (variants.isNull() || variants.size() == 0 || variants.size() > kMaxVariants) {
    return fail(error, "Manifest variants are missing or exceed limits");
  }
  for (JsonObjectConst item : variants) {
    const char *id = requiredString(item, "id");
    const char *profile = requiredString(item, "profileId");
    const char *orientation = item["displayMeta"]["orientation"];
    const char *pixelFormat = requiredString(item, "pixelFormat");
    const char *codec = requiredString(item, "codec");
    if (!id || !profile || !orientation || !pixelFormat || !codec ||
        strcmp(codec, "png") != 0 ||
        !item["screenProfileVersion"].is<uint32_t>() ||
        !item["displayMeta"]["fontLevel"].is<int8_t>() ||
        !item["displayMeta"]["invert"].is<bool>() ||
        !item["logicalSize"]["width"].is<uint16_t>() ||
        !item["logicalSize"]["height"].is<uint16_t>() ||
        !item["displayRotation"].is<uint16_t>()) {
      return fail(error, "Invalid display variant in manifest");
    }
    const int8_t fontLevel = item["displayMeta"]["fontLevel"].as<int8_t>();
    const uint16_t rotation = item["displayRotation"].as<uint16_t>();
    const uint16_t width = item["logicalSize"]["width"].as<uint16_t>();
    const uint16_t height = item["logicalSize"]["height"].as<uint16_t>();
    if (id[0] == '\0' || profile[0] == '\0' ||
        item["screenProfileVersion"].as<uint32_t>() == 0 || width == 0 ||
        height == 0 || !supportedPixelFormat(pixelFormat) ||
        fontLevel < -2 || fontLevel > 2 ||
        (strcmp(orientation, "portrait") != 0 &&
         strcmp(orientation, "landscape") != 0) ||
        (rotation != 0 && rotation != 90 && rotation != 180 && rotation != 270)) {
      return fail(error, "Unsupported display variant values");
    }
    if (std::any_of(variants_.begin(), variants_.end(),
                    [id](const DisplayVariant &variant) {
                      return variant.id == id;
                    })) {
      return fail(error, "Duplicate display variant ID");
    }
    variants_.push_back({
        id,
        profile,
        item["screenProfileVersion"].as<uint32_t>(),
        fontLevel,
        item["displayMeta"]["invert"].as<bool>(),
        orientation,
        width,
        height,
        rotation,
        pixelFormat,
    });
  }

  JsonArrayConst documents = root["documents"].as<JsonArrayConst>();
  if (documents.isNull() || documents.size() == 0 ||
      documents.size() > kMaxDocuments) {
    return fail(error, "Manifest documents are missing or exceed limits");
  }
  declaredPaths_.push_back("ink-manifest.json");
  for (JsonObjectConst item : documents) {
    const char *uuid = requiredString(item, "uuid");
    const char *documentTitle = requiredString(item, "title");
    const char *kind = requiredString(item, "kind");
    const char *documentPath = requiredString(item, "documentPath");
    const char *documentSha = requiredString(item, "documentSha256");
    const char *parent = item["parentUuid"].is<const char *>()
                             ? item["parentUuid"].as<const char *>()
                             : "";
    if (!uuid || !documentTitle || !kind || !documentPath || !documentSha ||
        !isUuid(uuid) || (parent[0] != '\0' && !isUuid(parent)) ||
        documentTitle[0] == '\0' || !supportedContentKind(kind) ||
        !isNormalizedArchivePath(documentPath) || !isSha256(documentSha) ||
        !item["documentBytes"].is<uint32_t>() ||
        item["documentBytes"].as<uint32_t>() == 0) {
      return fail(error, "Invalid document index entry");
    }
    if (std::any_of(documents_.begin(), documents_.end(),
                    [uuid](const DocumentRef &document) {
                      return document.uuid == uuid;
                    })) {
      return fail(error, "Duplicate document UUID");
    }
    DocumentRef parsed{
        uuid, parent, documentTitle, kind, documentPath,
        item["documentBytes"].as<uint32_t>(), documentSha, {}};
    declaredPaths_.push_back(documentPath);

    JsonArrayConst indexedVariants = item["variants"].as<JsonArrayConst>();
    if (indexedVariants.isNull() || indexedVariants.size() != variants_.size()) {
      return fail(error, "Every document must contain every display variant");
    }
    for (JsonObjectConst indexed : indexedVariants) {
      const char *variantId = requiredString(indexed, "variantId");
      JsonArrayConst pages = indexed["pages"].as<JsonArrayConst>();
      if (!variantId || pages.isNull() || pages.size() == 0 ||
          pages.size() > kMaxPagesPerVariant ||
          !indexed["pageCount"].is<uint16_t>() ||
          indexed["pageCount"].as<uint16_t>() != pages.size() ||
          std::none_of(variants_.begin(), variants_.end(),
                       [variantId](const DisplayVariant &variant) {
                         return variant.id == variantId;
                       })) {
        return fail(error, "Invalid document variant frame set");
      }
      VariantFrames frames;
      frames.variantId = variantId;
      for (size_t pageNumber = 0; pageNumber < pages.size(); ++pageNumber) {
        JsonObjectConst page = pages[pageNumber];
        const char *imagePath = requiredString(page, "imagePath");
        const char *imageSha = requiredString(page, "imageSha256");
        const char *sidecarPath = requiredString(page, "sidecarPath");
        const char *sidecarSha = requiredString(page, "sidecarSha256");
        if (!imagePath || !imageSha || !sidecarPath || !sidecarSha ||
            !isNormalizedArchivePath(imagePath) ||
            !isNormalizedArchivePath(sidecarPath) || !isSha256(imageSha) ||
            !isSha256(sidecarSha) || !page["pageIndex"].is<uint16_t>() ||
            page["pageIndex"].as<uint16_t>() != pageNumber ||
            !page["imageBytes"].is<uint32_t>() ||
            page["imageBytes"].as<uint32_t>() == 0 ||
            !page["sidecarBytes"].is<uint32_t>() ||
            page["sidecarBytes"].as<uint32_t>() == 0) {
          return fail(error, "Invalid page index entry");
        }
        frames.pages.push_back({
            static_cast<uint16_t>(pageNumber), imagePath,
            page["imageBytes"].as<uint32_t>(), imageSha, sidecarPath,
            page["sidecarBytes"].as<uint32_t>(), sidecarSha,
        });
        declaredPaths_.push_back(imagePath);
        declaredPaths_.push_back(sidecarPath);
      }
      if (std::any_of(parsed.variants.begin(), parsed.variants.end(),
                      [variantId](const VariantFrames &existing) {
                        return existing.variantId == variantId;
                      })) {
        return fail(error, "Duplicate document variant frame set");
      }
      parsed.variants.push_back(std::move(frames));
    }
    documents_.push_back(std::move(parsed));
  }

  std::vector<std::string> uniquePaths = declaredPaths_;
  std::sort(uniquePaths.begin(), uniquePaths.end());
  if (std::adjacent_find(uniquePaths.begin(), uniquePaths.end()) !=
      uniquePaths.end()) {
    return fail(error, "Manifest declares duplicate archive paths");
  }
  return true;
}

bool PackageCatalog::validateCompatibility(JsonObjectConst root,
                                           std::string &error) const {
  JsonObjectConst compatibility = root["compatibility"].as<JsonObjectConst>();
  if (compatibility.isNull() ||
      compatibility["formatMajor"].as<uint32_t>() != 1) {
    return fail(error, "Unsupported package format major");
  }
  const char *minimum = compatibility["minimumClientVersions"]["paperS3"];
  if (!minimum || !versionAtLeast(kClientVersion, minimum)) {
    return fail(error, "PaperS3 client version is below package minimum");
  }
  JsonArrayConst capabilities =
      compatibility["requiredCapabilities"].as<JsonArrayConst>();
  if (capabilities.isNull() || capabilities.size() == 0) {
    return fail(error, "Package has no required capability declaration");
  }
  for (const char *capability : capabilities) {
    if (!capability || !supportedCapability(capability)) {
      return fail(error, std::string("Unsupported required capability: ") +
                             (capability ? capability : "<invalid>"));
    }
  }
  const bool hasProfile = std::any_of(
      variants_.begin(), variants_.end(), [](const DisplayVariant &variant) {
        return variant.profileId == kProfileId &&
               variant.screenProfileVersion == kProfileVersion &&
               variant.pixelFormat == "gray4" &&
               isPaperS3Geometry(variant);
      });
  if (!hasProfile) {
    return fail(error, "Package has no compatible PaperS3 profile variant");
  }
  return true;
}

bool PackageCatalog::verifyDeclaredFiles(std::string &error) const {
  std::vector<std::string> actualPaths;
  if (!collectFiles(*fs_, rootPath_, rootPath_, actualPaths, error)) {
    return false;
  }
  std::vector<std::string> expected = declaredPaths_;
  std::sort(expected.begin(), expected.end());
  std::sort(actualPaths.begin(), actualPaths.end());
  if (expected != actualPaths) {
    return fail(error, "Declared and extracted archive paths differ");
  }
  return true;
}

bool PackageCatalog::verifyDocuments(std::string &error) const {
  const DocumentRef *entry = document(entryUuid_);
  if (!entry || !entry->parentUuid.empty()) {
    return fail(error, "entryUuid is missing or has a parent");
  }
  for (const auto &item : documents_) {
    if (item.uuid != entryUuid_ &&
        (item.parentUuid.empty() || !contains(item.parentUuid))) {
      return fail(error, "Non-entry document has a missing parent");
    }
    std::vector<std::string> visited;
    const DocumentRef *cursor = &item;
    while (cursor && !cursor->parentUuid.empty()) {
      if (std::find(visited.begin(), visited.end(), cursor->uuid) !=
          visited.end()) {
        return fail(error, "Parent graph contains a cycle");
      }
      visited.push_back(cursor->uuid);
      cursor = document(cursor->parentUuid);
    }
    if (!cursor || cursor->uuid != entryUuid_) {
      return fail(error, "Document does not descend from entryUuid");
    }

    const std::string documentFile = joinPath(rootPath_, item.documentPath);
    if (!verifyLengthAndHash(*fs_, documentFile, item.documentBytes,
                             item.documentSha256, error)) {
      return false;
    }
    JsonDocument envelope;
    if (!readJson(*fs_, documentFile, kMaxJsonArtifactBytes, envelope, error)) {
      return false;
    }
    JsonObjectConst root = envelope.as<JsonObjectConst>();
    const char *schema = requiredString(root, "schemaVersion");
    const char *uuid = requiredString(root, "uuid");
    const char *parent = root["parentUuid"].is<const char *>()
                             ? root["parentUuid"].as<const char *>()
                             : "";
    const char *contentSchema = root["content"]["schemaVersion"];
    const char *contentId = root["content"]["id"];
    const char *contentKind = root["content"]["page"]["kind"];
    if (!schema || strcmp(schema, "inkos.document/v1") != 0 || !uuid ||
        item.uuid != uuid || item.parentUuid != parent || !contentSchema ||
        strcmp(contentSchema, "inkos.content/v2") != 0 || !contentId ||
        item.uuid != contentId || !contentKind || item.kind != contentKind) {
      return fail(error, "Document envelope does not match manifest: " +
                             item.uuid);
    }

    for (const auto &frames : item.variants) {
      const auto variant = std::find_if(
          variants_.begin(), variants_.end(),
          [&frames](const DisplayVariant &value) {
            return value.id == frames.variantId;
          });
      if (variant == variants_.end()) {
        return fail(error, "Document references unknown variant");
      }
      for (const auto &frame : frames.pages) {
        const std::string imageFile = joinPath(rootPath_, frame.imagePath);
        const std::string sidecarFile = joinPath(rootPath_, frame.sidecarPath);
        if (!verifyLengthAndHash(*fs_, imageFile, frame.imageBytes,
                                 frame.imageSha256, error) ||
            !verifyLengthAndHash(*fs_, sidecarFile, frame.sidecarBytes,
                                 frame.sidecarSha256, error) ||
            !pngDimensions(*fs_, imageFile, variant->width, variant->height,
                           error) ||
            !verifySidecar(item, *variant, frame, nullptr, error)) {
          return false;
        }
      }
    }
  }
  return true;
}

bool PackageCatalog::verifySidecar(const DocumentRef &documentRef,
                                   const DisplayVariant &variant,
                                   const FrameRef &frame,
                                   FrameSidecar *result,
                                   std::string &error) const {
  JsonDocument document;
  const std::string sidecarFile = joinPath(rootPath_, frame.sidecarPath);
  if (!readJson(*fs_, sidecarFile, kMaxJsonArtifactBytes, document, error)) {
    return false;
  }
  JsonObjectConst root = document.as<JsonObjectConst>();
  const char *schema = requiredString(root, "schemaVersion");
  const char *package = requiredString(root, "packageId");
  const char *uuid = requiredString(root, "documentUuid");
  const char *parent = root["parentUuid"].is<const char *>()
                           ? root["parentUuid"].as<const char *>()
                           : "";
  const char *variantId = requiredString(root, "variantId");
  const char *imagePath = requiredString(root, "imagePath");
  const char *imageSha = requiredString(root, "imageSha256");
  if (!schema || strcmp(schema, "inkos.frame-sidecar/v1") != 0 ||
      !package || packageId_ != package || !uuid || documentRef.uuid != uuid ||
      documentRef.parentUuid != parent || !variantId || variant.id != variantId ||
      !root["pageIndex"].is<uint16_t>() ||
      root["pageIndex"].as<uint16_t>() != frame.pageIndex ||
      !root["pageCount"].is<uint16_t>() ||
      root["pageCount"].as<uint16_t>() == 0 || !imagePath ||
      frame.imagePath != imagePath || !imageSha || frame.imageSha256 != imageSha ||
      root["logicalSize"]["width"].as<uint16_t>() != variant.width ||
      root["logicalSize"]["height"].as<uint16_t>() != variant.height) {
    return fail(error, "Sidecar does not match manifest frame: " + sidecarFile);
  }
  const VariantFrames *frameSet = framesFor(documentRef, variant.id);
  if (!frameSet || root["pageCount"].as<uint16_t>() != frameSet->pages.size()) {
    return fail(error, "Sidecar pageCount does not match frame set");
  }
  JsonArrayConst interactions = root["interactions"].as<JsonArrayConst>();
  if (interactions.isNull() || interactions.size() > kMaxInteractions) {
    return fail(error, "Sidecar interactions exceed limits");
  }

  FrameSidecar parsed;
  parsed.packageId = package;
  parsed.documentUuid = uuid;
  parsed.parentUuid = parent;
  parsed.variantId = variantId;
  parsed.pageIndex = frame.pageIndex;
  parsed.pageCount = root["pageCount"].as<uint16_t>();
  parsed.imagePath = imagePath;
  parsed.imageSha256 = imageSha;
  parsed.width = variant.width;
  parsed.height = variant.height;
  for (JsonObjectConst interaction : interactions) {
    const char *interactionId = requiredString(interaction, "id");
    const char *contentPath = requiredString(interaction, "contentPath");
    const char *target = requiredString(interaction, "targetUuid");
    if (!interactionId || interactionId[0] == '\0' || !contentPath ||
        contentPath[0] == '\0' || !target || !isUuid(target) ||
        !contains(target) ||
        !interaction["bounds"]["x"].is<int32_t>() ||
        !interaction["bounds"]["y"].is<int32_t>() ||
        !interaction["bounds"]["width"].is<int32_t>() ||
        !interaction["bounds"]["height"].is<int32_t>()) {
      return fail(error, "Invalid sidecar interaction");
    }
    inkos::Bounds bounds{
        interaction["bounds"]["x"].as<int32_t>(),
        interaction["bounds"]["y"].as<int32_t>(),
        interaction["bounds"]["width"].as<int32_t>(),
        interaction["bounds"]["height"].as<int32_t>(),
    };
    if (bounds.x < 0 || bounds.y < 0 || bounds.width <= 0 ||
        bounds.height <= 0 ||
        static_cast<int64_t>(bounds.x) + bounds.width > variant.width ||
        static_cast<int64_t>(bounds.y) + bounds.height > variant.height) {
      return fail(error, "Sidecar interaction is outside logical bounds");
    }
    parsed.interactions.push_back({bounds, target});
  }

  const JsonVariantConst dynamicRegionsValue = root["dynamicRegions"];
  if (!dynamicRegionsValue.isUnbound()) {
    JsonArrayConst dynamicRegions = dynamicRegionsValue.as<JsonArrayConst>();
    if (dynamicRegions.isNull() || dynamicRegions.size() > kMaxDynamicRegions) {
      return fail(error, "Sidecar dynamicRegions must be a bounded array");
    }
    for (JsonVariantConst value : dynamicRegions) {
      if (!value.is<JsonObjectConst>()) {
        return fail(error, "Sidecar dynamic region must be an object");
      }
      ClockRegion region;
      if (!parseClockRegion(value.as<JsonObjectConst>(), variant.width,
                            variant.height, region, error)) {
        return false;
      }
      const bool duplicate = std::any_of(
          parsed.dynamicRegions.begin(), parsed.dynamicRegions.end(),
          [&region](const ClockRegion &candidate) {
            return candidate.id == region.id;
          });
      if (duplicate) {
        return fail(error, "Duplicate dynamic clock region ID");
      }
      if (std::any_of(parsed.interactions.begin(), parsed.interactions.end(),
                      [&region](const inkos::HitTarget &interaction) {
                        return overlaps(region.bounds, interaction.bounds);
                      })) {
        return fail(error, "Dynamic clock region overlaps an interaction");
      }
      parsed.dynamicRegions.push_back(std::move(region));
    }
  }
  if (result) {
    *result = std::move(parsed);
  }
  return true;
}

bool PackageCatalog::contains(const std::string &uuid) const {
  return document(uuid) != nullptr;
}

std::string PackageCatalog::parentOf(const std::string &uuid) const {
  const DocumentRef *item = document(uuid);
  return item ? item->parentUuid : "";
}

uint16_t PackageCatalog::pageCount(const std::string &uuid) const {
  const DocumentRef *item = document(uuid);
  if (!item || activeVariantId_.empty()) {
    return 0;
  }
  const VariantFrames *frames = framesFor(*item, activeVariantId_);
  return frames ? static_cast<uint16_t>(frames->pages.size()) : 0;
}

bool PackageCatalog::selectExactVariant(const DisplaySettings &settings,
                                        std::string &error) {
  const auto variant = std::find_if(
      variants_.begin(), variants_.end(),
      [&settings](const DisplayVariant &value) {
        return value.profileId == kProfileId &&
               value.screenProfileVersion == kProfileVersion &&
               value.orientation == settings.orientation &&
               value.fontLevel == settings.fontLevel &&
               value.invert == settings.invert && value.pixelFormat == "gray4" &&
               isPaperS3Geometry(value);
      });
  if (variant == variants_.end()) {
    return fail(error, "VARIANT_UNAVAILABLE: exact PaperS3 variant is absent");
  }
  activeVariantId_ = variant->id;
  return true;
}

const DisplayVariant *PackageCatalog::activeVariant() const {
  const auto variant = std::find_if(
      variants_.begin(), variants_.end(), [this](const DisplayVariant &value) {
        return value.id == activeVariantId_;
      });
  return variant == variants_.end() ? nullptr : &*variant;
}

const DocumentRef *PackageCatalog::document(const std::string &uuid) const {
  const auto item = std::find_if(
      documents_.begin(), documents_.end(),
      [&uuid](const DocumentRef &value) { return value.uuid == uuid; });
  return item == documents_.end() ? nullptr : &*item;
}

const VariantFrames *
PackageCatalog::framesFor(const DocumentRef &document,
                          const std::string &variantId) const {
  const auto frames = std::find_if(
      document.variants.begin(), document.variants.end(),
      [&variantId](const VariantFrames &value) {
        return value.variantId == variantId;
      });
  return frames == document.variants.end() ? nullptr : &*frames;
}

const FrameRef *PackageCatalog::frame(const std::string &uuid,
                                      uint16_t pageIndex) const {
  const DocumentRef *item = document(uuid);
  if (!item || activeVariantId_.empty()) {
    return nullptr;
  }
  const VariantFrames *frames = framesFor(*item, activeVariantId_);
  if (!frames || pageIndex >= frames->pages.size()) {
    return nullptr;
  }
  return &frames->pages[pageIndex];
}

bool PackageCatalog::loadActiveSidecar(const std::string &uuid,
                                       uint16_t pageIndex,
                                       FrameSidecar &sidecar,
                                       std::string &error) const {
  const DocumentRef *item = document(uuid);
  const DisplayVariant *variant = activeVariant();
  const FrameRef *page = frame(uuid, pageIndex);
  if (!item || !variant || !page) {
    return fail(error, "STALE_FRAME: active frame is unavailable");
  }
  if (!verifyLengthAndHash(*fs_, joinPath(rootPath_, page->imagePath),
                           page->imageBytes, page->imageSha256, error) ||
      !verifyLengthAndHash(*fs_, joinPath(rootPath_, page->sidecarPath),
                           page->sidecarBytes, page->sidecarSha256, error)) {
    return false;
  }
  return verifySidecar(*item, *variant, *page, &sidecar, error);
}

} // namespace inkos::paper
