#include "device_storage.h"

#include "ink_protocol.h"
#include "jpeg_frame_policy.h"
#include "png_frame_policy.h"
#include "safe_json.h"

#include <cJSON.h>
#include <esp_attr.h>
#include <esp_heap_caps.h>
#include <esp_log.h>
#include <esp_memory_utils.h>
#include <esp_rom_crc.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/idf_additions.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <mbedtls/sha256.h>
#include <nvs.h>
#include <lwip/inet.h>
#include <lwip/sockets.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <memory>
#include <set>
#include <type_traits>

namespace inkos::idf {
namespace {

constexpr const char *kTag = "inkos-storage";
constexpr const char *kNamespace = "inkos_data";
constexpr const char *kCollectionsKey = "collections";
constexpr const char *kDefaultRandomImageUrl =
    "https://picsum.photos/540/960?random=1";
constexpr const char *kLegacyGrayscaleRandomImageUrl =
    "https://picsum.photos/540/960?grayscale&random=1";
constexpr const char *kRetiredRandomImageAction =
    "inkos://app/random-image";
constexpr const char *kHomeRecordKey = "active_home";
constexpr const char *kHomePartitionA = "home_a";
constexpr const char *kHomePartitionB = "home_b";
constexpr size_t kMaximumCollectionsJsonBytes = 48U * 1024U;
constexpr uint32_t kHomeRecordMagic = 0x31484b49U; // IKH1
constexpr uint16_t kHomeRecordVersion = 1;
constexpr uint32_t kHomeCheckpointMagic = 0x43504b49U; // IKPC
constexpr uint32_t kHomeCheckpointVersion = 1;
constexpr size_t kFlashEraseSectorBytes = 4096;
constexpr size_t kFlashEraseBlockBytes = 64U * 1024U;
constexpr size_t kCooperativeFlashChunkBytes = 2U * 1024U;
constexpr size_t kFlashIoChunkBytes = kCooperativeFlashChunkBytes;
constexpr size_t kHomeUploadProgressBytes = 256U * 1024U;
constexpr uint32_t kHomeVerificationStackBytes = 32U * 1024U;
constexpr TickType_t kFlashNetworkYieldTicks = pdMS_TO_TICKS(10);
static_assert(kFlashIoChunkBytes <= CONFIG_SPI_FLASH_WRITE_CHUNK_SIZE);
static_assert(kFlashIoChunkBytes % sizeof(uint32_t) == 0);

using JsonPtr = std::unique_ptr<cJSON, decltype(&cJSON_Delete)>;

#pragma pack(push, 1)
struct PersistentHomeRecord {
  uint32_t magic = kHomeRecordMagic;
  uint16_t version = kHomeRecordVersion;
  uint8_t slot = 0;
  uint8_t reserved = 0;
  uint32_t archiveBytes = 0;
  uint32_t revision = 0;
  char archiveSha256[65]{};
  char packageId[37]{};
  char entryUuid[37]{};
  uint32_t crc32 = 0;
};

enum class HomeCheckpointPhase : uint32_t {
  Begin = 1,
  Compare,
  Erase,
  Write,
  Stream,
  Map,
  Hash,
  Archive,
  Commit,
  Activated,
  Failed,
  ZipDirectory,
  ManifestExtract,
  ManifestParse,
  References,
  EntryFrames,
  Payloads,
  Receiving,
};

struct PersistentHomeCheckpoint {
  uint32_t magic;
  uint32_t version;
  uint32_t sequence;
  uint32_t phase;
  uint32_t totalBytes;
  uint32_t writtenBytes;
  uint32_t detailOffset;
  uint32_t crc32;
};
static_assert(std::is_trivial_v<PersistentHomeCheckpoint>);
static_assert(std::is_trivially_copyable_v<PersistentHomeCheckpoint>);
static_assert(std::is_standard_layout_v<PersistentHomeCheckpoint>);
#pragma pack(pop)

const esp_partition_t *gHomeA = nullptr;
const esp_partition_t *gHomeB = nullptr;
SemaphoreHandle_t gStorageMutex = nullptr;
bool gCollectionsChanged = false;
bool gHomeChanged = false;
bool gHomeDeleted = false;
portMUX_TYPE gEventMux = portMUX_INITIALIZER_UNLOCKED;
portMUX_TYPE gHomeFlashIoMux = portMUX_INITIALIZER_UNLOCKED;
portMUX_TYPE gHomeCheckpointMux = portMUX_INITIALIZER_UNLOCKED;
static DRAM_ATTR uint32_t
    gHomeFlashIoWords[kFlashIoChunkBytes / sizeof(uint32_t)]{};
bool gHomeFlashIoReserved = false;
static RTC_NOINIT_ATTR PersistentHomeCheckpoint gHomeCheckpoint;

bool fail(std::string &error, const std::string &message) {
  error = message;
  return false;
}

bool sha256HexYielding(const uint8_t *data, size_t size, std::string &result,
                       std::string &error) {
  if (!data || size == 0) return fail(error, "Cannot hash an empty home archive");
  mbedtls_sha256_context context;
  mbedtls_sha256_init(&context);
  std::array<uint8_t, 32> digest{};
  bool ok = mbedtls_sha256_starts(&context, 0) == 0;
  size_t offset = 0;
  while (ok && offset < size) {
    const size_t bytes = std::min(kFlashEraseBlockBytes, size - offset);
    ok = mbedtls_sha256_update(&context, data + offset, bytes) == 0;
    offset += bytes;
    vTaskDelay(1);
  }
  if (ok) ok = mbedtls_sha256_finish(&context, digest.data()) == 0;
  mbedtls_sha256_free(&context);
  if (!ok) return fail(error, "Uploaded home SHA-256 calculation failed");
  static constexpr char hex[] = "0123456789abcdef";
  result.assign(64, '0');
  for (size_t index = 0; index < digest.size(); ++index) {
    result[index * 2] = hex[digest[index] >> 4];
    result[index * 2 + 1] = hex[digest[index] & 0x0f];
  }
  return true;
}

uint8_t *linkedHomeFlashIoBuffer() {
  return reinterpret_cast<uint8_t *>(gHomeFlashIoWords);
}

bool claimLinkedHomeFlashIoBuffer() {
  bool claimed = false;
  portENTER_CRITICAL(&gHomeFlashIoMux);
  if (!gHomeFlashIoReserved) {
    gHomeFlashIoReserved = true;
    claimed = true;
  }
  portEXIT_CRITICAL(&gHomeFlashIoMux);
  return claimed;
}

void releaseLinkedHomeFlashIoBuffer() {
  portENTER_CRITICAL(&gHomeFlashIoMux);
  gHomeFlashIoReserved = false;
  portEXIT_CRITICAL(&gHomeFlashIoMux);
}

void releaseHomeUploadIo(HomeUpload &upload) {
  upload.flashIoBuffer.reset();
  upload.flashIoBufferBytes = 0;
}

void logHomeUploadResources(const HomeUpload &upload, const char *phase) {
  constexpr uint32_t internalCaps = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
  constexpr uint32_t psramCaps = MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT;
  ESP_LOGI(
      kTag,
      "home upload %s=%u/%u erased=%u programmed=%u unchanged=%u "
      "stack_free=%u internal=%u/%u psram=%u/%u",
      phase, static_cast<unsigned>(upload.writtenBytes),
      static_cast<unsigned>(upload.expectedBytes),
      static_cast<unsigned>(upload.erasedBytes),
      static_cast<unsigned>(upload.programmedBytes),
      static_cast<unsigned>(upload.unchangedBytes),
      static_cast<unsigned>(uxTaskGetStackHighWaterMark(nullptr)),
      static_cast<unsigned>(heap_caps_get_free_size(internalCaps)),
      static_cast<unsigned>(heap_caps_get_largest_free_block(internalCaps)),
      static_cast<unsigned>(heap_caps_get_free_size(psramCaps)),
      static_cast<unsigned>(heap_caps_get_largest_free_block(psramCaps)));
}

class StorageLock {
public:
  explicit StorageLock(bool acquire = true) {
    locked_ = acquire && gStorageMutex &&
              xSemaphoreTake(gStorageMutex, pdMS_TO_TICKS(30000)) == pdTRUE;
  }
  ~StorageLock() {
    if (locked_) xSemaphoreGive(gStorageMutex);
  }
  bool locked() const { return locked_; }
  void release() {
    if (locked_) xSemaphoreGive(gStorageMutex);
    locked_ = false;
  }

private:
  bool locked_ = false;
};

uint32_t homeRecordCrc(const PersistentHomeRecord &record) {
  return esp_rom_crc32_le(
      0, reinterpret_cast<const uint8_t *>(&record),
      offsetof(PersistentHomeRecord, crc32));
}

uint32_t homeCheckpointCrc(const PersistentHomeCheckpoint &checkpoint) {
  return esp_rom_crc32_le(
      0, reinterpret_cast<const uint8_t *>(&checkpoint),
      offsetof(PersistentHomeCheckpoint, crc32));
}

bool validHomeCheckpoint(const PersistentHomeCheckpoint &checkpoint) {
  return checkpoint.magic == kHomeCheckpointMagic &&
         checkpoint.version == kHomeCheckpointVersion &&
         checkpoint.phase >=
             static_cast<uint32_t>(HomeCheckpointPhase::Begin) &&
         checkpoint.phase <=
             static_cast<uint32_t>(HomeCheckpointPhase::Receiving) &&
         checkpoint.totalBytes <= kMaximumUploadedHomeBytes &&
         checkpoint.writtenBytes <= checkpoint.totalBytes &&
         checkpoint.crc32 == homeCheckpointCrc(checkpoint);
}

const char *homeCheckpointPhaseName(HomeCheckpointPhase phase) {
  switch (phase) {
  case HomeCheckpointPhase::Begin: return "begin";
  case HomeCheckpointPhase::Compare: return "compare";
  case HomeCheckpointPhase::Erase: return "erase";
  case HomeCheckpointPhase::Write: return "write";
  case HomeCheckpointPhase::Stream: return "stream";
  case HomeCheckpointPhase::Map: return "map";
  case HomeCheckpointPhase::Hash: return "hash";
  case HomeCheckpointPhase::Archive: return "archive";
  case HomeCheckpointPhase::Commit: return "commit";
  case HomeCheckpointPhase::Activated: return "activated";
  case HomeCheckpointPhase::Failed: return "failed";
  case HomeCheckpointPhase::ZipDirectory: return "zip-directory";
  case HomeCheckpointPhase::ManifestExtract: return "manifest-extract";
  case HomeCheckpointPhase::ManifestParse: return "manifest-parse";
  case HomeCheckpointPhase::References: return "references";
  case HomeCheckpointPhase::EntryFrames: return "entry-frames";
  case HomeCheckpointPhase::Payloads: return "payloads";
  case HomeCheckpointPhase::Receiving: return "receiving";
  }
  return "unknown";
}

PersistentHomeCheckpoint homeCheckpointSnapshot() {
  PersistentHomeCheckpoint checkpoint{};
  portENTER_CRITICAL(&gHomeCheckpointMux);
  checkpoint = gHomeCheckpoint;
  portEXIT_CRITICAL(&gHomeCheckpointMux);
  return checkpoint;
}

void saveHomeCheckpoint(HomeCheckpointPhase phase, size_t totalBytes,
                        size_t writtenBytes, size_t detailOffset = 0) {
  PersistentHomeCheckpoint previous = homeCheckpointSnapshot();
  PersistentHomeCheckpoint checkpoint{};
  checkpoint.magic = kHomeCheckpointMagic;
  checkpoint.version = kHomeCheckpointVersion;
  const bool followsCompleteReceive =
      validHomeCheckpoint(previous) &&
      previous.phase ==
          static_cast<uint32_t>(HomeCheckpointPhase::Receiving) &&
      previous.totalBytes == totalBytes &&
      previous.writtenBytes == totalBytes;
  const bool startsReceive =
      phase == HomeCheckpointPhase::Receiving && writtenBytes == 0;
  const bool startsNewSequence =
      startsReceive ||
      (phase == HomeCheckpointPhase::Begin && !followsCompleteReceive) ||
      !validHomeCheckpoint(previous);
  checkpoint.sequence = startsNewSequence
                            ? (validHomeCheckpoint(previous)
                                   ? previous.sequence + 1
                                   : 1)
                            : previous.sequence;
  checkpoint.phase = static_cast<uint32_t>(phase);
  checkpoint.totalBytes = static_cast<uint32_t>(totalBytes);
  checkpoint.writtenBytes = static_cast<uint32_t>(writtenBytes);
  checkpoint.detailOffset = static_cast<uint32_t>(detailOffset);
  checkpoint.crc32 = homeCheckpointCrc(checkpoint);
  portENTER_CRITICAL(&gHomeCheckpointMux);
  gHomeCheckpoint = checkpoint;
  portEXIT_CRITICAL(&gHomeCheckpointMux);
}

void logHomeVerificationStage(const char *stage, int64_t startedAtUs,
                              size_t detail = 0) {
  constexpr uint32_t internalCaps = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
  constexpr uint32_t psramCaps = MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT;
  ESP_LOGI(
      kTag,
      "home verify stage=%s detail=%u elapsed=%lldms stack_free=%u "
      "internal=%u/%u psram=%u/%u",
      stage, static_cast<unsigned>(detail),
      static_cast<long long>((esp_timer_get_time() - startedAtUs) / 1000),
      static_cast<unsigned>(uxTaskGetStackHighWaterMark(nullptr)),
      static_cast<unsigned>(heap_caps_get_free_size(internalCaps)),
      static_cast<unsigned>(heap_caps_get_largest_free_block(internalCaps)),
      static_cast<unsigned>(heap_caps_get_free_size(psramCaps)),
      static_cast<unsigned>(heap_caps_get_largest_free_block(psramCaps)));
}

void logHomePayloadProgress(int64_t startedAtUs, size_t documentsDone,
                            size_t documentTotal, size_t pagesDone,
                            size_t pageTotal) {
  constexpr uint32_t internalCaps = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
  constexpr uint32_t psramCaps = MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT;
  ESP_LOGI(
      kTag,
      "home verify payloads documents=%u/%u pages=%u/%u elapsed=%lldms "
      "stack_free=%u internal=%u/%u psram=%u/%u",
      static_cast<unsigned>(documentsDone),
      static_cast<unsigned>(documentTotal), static_cast<unsigned>(pagesDone),
      static_cast<unsigned>(pageTotal),
      static_cast<long long>((esp_timer_get_time() - startedAtUs) / 1000),
      static_cast<unsigned>(uxTaskGetStackHighWaterMark(nullptr)),
      static_cast<unsigned>(heap_caps_get_free_size(internalCaps)),
      static_cast<unsigned>(heap_caps_get_largest_free_block(internalCaps)),
      static_cast<unsigned>(heap_caps_get_free_size(psramCaps)),
      static_cast<unsigned>(heap_caps_get_largest_free_block(psramCaps)));
}

const esp_partition_t *partitionForSlot(char slot) {
  return slot == 'a' ? gHomeA : slot == 'b' ? gHomeB : nullptr;
}

bool validId(const std::string &id) {
  if (id.empty() || id.size() > 64 ||
      !(std::islower(static_cast<unsigned char>(id.front())) ||
        std::isdigit(static_cast<unsigned char>(id.front())))) {
    return false;
  }
  return std::all_of(id.begin(), id.end(), [](char value) {
    return std::islower(static_cast<unsigned char>(value)) ||
           std::isdigit(static_cast<unsigned char>(value)) || value == '-' ||
           value == '_';
  });
}

bool validLabel(const std::string &label) {
  return !label.empty() && label.size() <= kMaximumCollectionLabelBytes &&
         std::none_of(label.begin(), label.end(), [](char value) {
           const auto byte = static_cast<unsigned char>(value);
           return byte == 0 || byte == 0x7f || byte < 0x20;
         });
}

bool validCollectionHostname(const std::string &host) {
  if (host.empty() || host.size() > 253 || host.front() == '.' ||
      host.back() == '.') {
    return false;
  }
  size_t cursor = 0;
  while (cursor < host.size()) {
    const size_t dot = host.find('.', cursor);
    const size_t end = dot == std::string::npos ? host.size() : dot;
    if (end == cursor || end - cursor > 63 ||
        !std::isalnum(static_cast<unsigned char>(host[cursor])) ||
        !std::isalnum(static_cast<unsigned char>(host[end - 1]))) {
      return false;
    }
    for (size_t index = cursor; index < end; ++index) {
      const char character = host[index];
      if (!std::isalnum(static_cast<unsigned char>(character)) &&
          character != '-') {
        return false;
      }
    }
    if (dot == std::string::npos) break;
    cursor = dot + 1;
  }
  return true;
}

bool validCollectionAuthority(const std::string &authority) {
  if (authority.empty() || authority.find('@') != std::string::npos) {
    return false;
  }
  if (authority.front() == '[') {
    const size_t close = authority.find(']');
    if (close == std::string::npos || close == 1 ||
        authority.find('[', 1) != std::string::npos ||
        authority.find(']', close + 1) != std::string::npos) {
      return false;
    }
    in6_addr parsed{};
    const std::string host = authority.substr(1, close - 1);
    if (inet_pton(AF_INET6, host.c_str(), &parsed) != 1) return false;
    const std::string remainder = authority.substr(close + 1);
    return remainder.empty() || remainder == ":443";
  }
  if (authority.find('[') != std::string::npos ||
      authority.find(']') != std::string::npos ||
      std::count(authority.begin(), authority.end(), ':') > 1) {
    return false;
  }
  const size_t separator = authority.find(':');
  const std::string host = authority.substr(0, separator);
  return validCollectionHostname(host) &&
         (separator == std::string::npos ||
          authority.substr(separator + 1) == "443");
}

bool validCollectionUrl(CollectionKind kind, const std::string &url) {
  if (kind == CollectionKind::Images &&
      url == kRetiredRandomImageAction) {
    // Accepted only so previously stored v2 data can be migrated below. New
    // collection forms and serialized defaults expose an editable HTTPS URL.
    return true;
  }
  if (url.size() < 9 || url.size() > kMaximumCollectionUrlBytes ||
      url.rfind("https://", 0) != 0 ||
      std::any_of(url.begin(), url.end(), [](char value) {
        const auto byte = static_cast<unsigned char>(value);
        return std::isspace(byte) || byte < 0x20 || byte == 0x7f;
      })) {
    return false;
  }
  const size_t authorityEnd = url.find_first_of("/?#", 8);
  const std::string authority = url.substr(
      8, authorityEnd == std::string::npos ? std::string::npos
                                            : authorityEnd - 8);
  return validCollectionAuthority(authority);
}

std::string generatedIdForName(const char *kindName, const std::string &url) {
  const std::string input = std::string(kindName) + "\n" + url;
  return std::string(kindName) + "-" +
         sha256Hex(reinterpret_cast<const uint8_t *>(input.data()), input.size())
             .substr(0, 20);
}

std::string generatedId(CollectionKind kind, const std::string &url) {
  return generatedIdForName(collectionKindName(kind), url);
}

DeviceCollections defaultCollections() {
  DeviceCollections collections;
  const std::array<std::pair<const char *, const char *>, 3> feeds = {{
      {"少数派", "https://sspai.com/feed"},
      {"阮一峰的网络日志", "https://www.ruanyifeng.com/blog/atom.xml"},
      {"Solidot", "https://www.solidot.org/index.rss"},
  }};
  const std::array<std::pair<const char *, const char *>, 5> websites = {{
      {"煎蛋", "https://jandan.net/"},
      {"维基百科", "https://zh.wikipedia.org/"},
      {"人民日报", "https://www.people.com.cn/"},
      {"百度贴吧", "https://tieba.baidu.com/"},
      {"Chiphell", "https://www.chiphell.com/"},
  }};
  for (const auto &[label, url] : feeds) {
    collections.rss.push_back(
        {generatedId(CollectionKind::Rss, url), label, url});
  }
  for (const auto &[label, url] : websites) {
    collections.websites.push_back(
        {generatedId(CollectionKind::Website, url), label, url});
  }
  collections.images.push_back(
      {generatedId(CollectionKind::Images, kDefaultRandomImageUrl), "随机图片",
       kDefaultRandomImageUrl});
  return collections;
}

bool writeCollectionsBlobUnlocked(const std::string &json,
                                  std::string &error) {
  nvs_handle_t handle = 0;
  const esp_err_t opened = nvs_open(kNamespace, NVS_READWRITE, &handle);
  if (opened != ESP_OK) {
    return fail(error, std::string("NVS collections open failed: ") +
                           esp_err_to_name(opened));
  }
  const esp_err_t set =
      nvs_set_blob(handle, kCollectionsKey, json.data(), json.size());
  const esp_err_t committed = set == ESP_OK ? nvs_commit(handle) : set;
  nvs_close(handle);
  if (committed != ESP_OK) {
    return fail(error, std::string("NVS collections commit failed: ") +
                           esp_err_to_name(committed));
  }
  return true;
}

bool parseEntries(const cJSON *root, const char *key, CollectionKind kind,
                  std::vector<CollectionEntry> &result,
                  std::set<std::string> &allIds, size_t maximumEntries,
                  std::string &error,
                  const char *generatedKindName = nullptr) {
  const cJSON *array = cJSON_GetObjectItemCaseSensitive(root, key);
  if (!cJSON_IsArray(array) ||
      static_cast<size_t>(cJSON_GetArraySize(array)) > maximumEntries) {
    return fail(error, std::string("Collection '") + key +
                           "' must be a bounded array");
  }
  std::set<std::string> urls;
  cJSON *value = nullptr;
  cJSON_ArrayForEach(value, array) {
    const cJSON *idValue = cJSON_GetObjectItemCaseSensitive(value, "id");
    const cJSON *labelValue = cJSON_GetObjectItemCaseSensitive(value, "label");
    const cJSON *urlValue = cJSON_GetObjectItemCaseSensitive(value, "url");
    const int memberCount = cJSON_IsObject(value) ? cJSON_GetArraySize(value) : 0;
    if (!cJSON_IsObject(value) || memberCount < 2 || memberCount > 3 ||
        !cJSON_IsString(labelValue) ||
        !labelValue->valuestring || !cJSON_IsString(urlValue) ||
        !urlValue->valuestring ||
        (idValue && !cJSON_IsNull(idValue) && !cJSON_IsString(idValue))) {
      return fail(error, std::string("Collection '") + key +
                             "' contains an invalid entry");
    }
    bool sawId = false;
    bool sawLabel = false;
    bool sawUrl = false;
    for (const cJSON *member = value->child; member; member = member->next) {
      bool duplicate = false;
      if (!member->string) {
        duplicate = true;
      } else if (std::strcmp(member->string, "id") == 0) {
        duplicate = sawId;
        sawId = true;
      } else if (std::strcmp(member->string, "label") == 0) {
        duplicate = sawLabel;
        sawLabel = true;
      } else if (std::strcmp(member->string, "url") == 0) {
        duplicate = sawUrl;
        sawUrl = true;
      } else {
        duplicate = true;
      }
      if (duplicate) {
        return fail(error, std::string("Collection '") + key +
                               "' contains an unknown or duplicate entry field");
      }
    }
    CollectionEntry entry;
    entry.label = labelValue->valuestring;
    entry.url = urlValue->valuestring;
    entry.id = cJSON_IsString(idValue) && idValue->valuestring
                   ? idValue->valuestring
                   : generatedIdForName(
                         generatedKindName ? generatedKindName
                                           : collectionKindName(kind),
                         entry.url);
    if (!validId(entry.id) || !validLabel(entry.label) ||
        !validCollectionUrl(kind, entry.url) ||
        !allIds.insert(entry.id).second ||
        !urls.insert(entry.url).second) {
      return fail(error, std::string("Collection '") + key +
                             "' has an unsafe or duplicate entry");
    }
    result.push_back(std::move(entry));
  }
  return true;
}

bool parseCollectionsJsonImpl(const std::string &json,
                              DeviceCollections &collections,
                              bool &requiresRewrite, std::string &error) {
  requiresRewrite = false;
  if (json.empty() || json.size() > kMaximumCollectionsJsonBytes) {
    return fail(error, "Collections JSON exceeds its device limit");
  }
  JsonPtr root(parseStrictBoundedJson(json, 16), cJSON_Delete);
  const cJSON *schema = root
                            ? cJSON_GetObjectItemCaseSensitive(root.get(),
                                                               "schemaVersion")
                            : nullptr;
  const cJSON *revision = root
                              ? cJSON_GetObjectItemCaseSensitive(root.get(),
                                                                 "revision")
                              : nullptr;
  if (!root || !cJSON_IsObject(root.get()) || !cJSON_IsString(schema) ||
      !schema->valuestring || !cJSON_IsNumber(revision) ||
      revision->valuedouble < 1 || revision->valuedouble > UINT32_MAX ||
      revision->valuedouble != static_cast<double>(revision->valueint)) {
    return fail(error, "Collections JSON has an unsupported schema/revision");
  }
  const bool legacySchema =
      std::strcmp(schema->valuestring, "inkos.device-collections/v1") == 0;
  const bool currentSchema =
      std::strcmp(schema->valuestring, "inkos.device-collections/v2") == 0;
  if (!legacySchema && !currentSchema) {
    return fail(error, "Collections JSON has an unsupported schema/revision");
  }
  const int expectedFields = 5;
  if (cJSON_GetArraySize(root.get()) != expectedFields) {
    return fail(error, "Collections JSON contains unknown or missing fields");
  }
  for (const cJSON *member = root->child; member; member = member->next) {
    if (!member->string ||
        (std::strcmp(member->string, "schemaVersion") != 0 &&
         std::strcmp(member->string, "revision") != 0 &&
         std::strcmp(member->string, "rss") != 0 &&
         std::strcmp(member->string, "websites") != 0 &&
         std::strcmp(member->string, "images") != 0 &&
         (!legacySchema || std::strcmp(member->string, "other") != 0))) {
      return fail(error, "Collections JSON contains unknown or missing fields");
    }
  }

  DeviceCollections parsed;
  parsed.revision = static_cast<uint32_t>(revision->valuedouble);
  std::set<std::string> ids;
  const size_t websiteInputLimit = legacySchema
                                       ? kMaximumRssCollectionEntries
                                       : kMaximumWebsiteCollectionEntries;
  if (!parseEntries(root.get(), "rss", CollectionKind::Rss, parsed.rss, ids,
                    kMaximumRssCollectionEntries, error) ||
      !parseEntries(root.get(), "websites", CollectionKind::Website,
                    parsed.websites, ids, websiteInputLimit, error)) {
    return false;
  }

  if (currentSchema &&
      !parseEntries(root.get(), "images", CollectionKind::Images,
                    parsed.images, ids, kMaximumImageCollectionEntries,
                    error)) {
    return false;
  }

  if (legacySchema) {
    std::vector<CollectionEntry> other;
    if (!parseEntries(root.get(), "other", CollectionKind::Website, other,
                      ids, kMaximumRssCollectionEntries, error, "other")) {
      return false;
    }
    std::set<std::string> websiteUrls;
    for (const auto &entry : parsed.websites) websiteUrls.insert(entry.url);
    for (auto &entry : other) {
      if (!websiteUrls.insert(entry.url).second) continue;
      if (parsed.websites.size() >= kMaximumWebsiteCollectionEntries) {
        return fail(error,
                    "Legacy website/other collections exceed the v2 limit");
      }
      parsed.websites.push_back(std::move(entry));
    }
    parsed.images.push_back(
        {generatedId(CollectionKind::Images, kDefaultRandomImageUrl),
         "随机图片", kDefaultRandomImageUrl});
    requiresRewrite = true;
  }

  // Older v2 firmware stored the app action as a pseudo image URL. Normalize
  // it without moving the row so the manager always exposes ordinary HTTPS
  // entries that users can edit, delete, or extend. Retain the first row when
  // both the retired and canonical spellings already exist.
  std::set<std::string> imageUrls;
  std::vector<CollectionEntry> normalizedImages;
  normalizedImages.reserve(parsed.images.size());
  for (auto &entry : parsed.images) {
    if (entry.url == kRetiredRandomImageAction ||
        entry.url == kLegacyGrayscaleRandomImageUrl) {
      entry.url = kDefaultRandomImageUrl;
      if (entry.label == "随机图片（系统）") entry.label = "随机图片";
      requiresRewrite = true;
    }
    if (!imageUrls.insert(entry.url).second) {
      requiresRewrite = true;
      continue;
    }
    normalizedImages.push_back(std::move(entry));
  }
  parsed.images = std::move(normalizedImages);
  collections = std::move(parsed);
  return true;
}

bool readHomeRecord(PersistentHomeRecord &record, bool &present,
                    std::string &error) {
  present = false;
  nvs_handle_t handle = 0;
  const esp_err_t opened = nvs_open(kNamespace, NVS_READONLY, &handle);
  if (opened == ESP_ERR_NVS_NOT_FOUND) return true;
  if (opened != ESP_OK) {
    return fail(error, std::string("NVS home record open failed: ") +
                           esp_err_to_name(opened));
  }
  size_t bytes = 0;
  esp_err_t status = nvs_get_blob(handle, kHomeRecordKey, nullptr, &bytes);
  if (status == ESP_ERR_NVS_NOT_FOUND) {
    nvs_close(handle);
    return true;
  }
  if (status != ESP_OK || bytes != sizeof(record)) {
    nvs_close(handle);
    return fail(error, "Stored-home activation record has an invalid size");
  }
  status = nvs_get_blob(handle, kHomeRecordKey, &record, &bytes);
  nvs_close(handle);
  if (status != ESP_OK || record.magic != kHomeRecordMagic ||
      record.version != kHomeRecordVersion ||
      record.crc32 != homeRecordCrc(record) ||
      !partitionForSlot(static_cast<char>(record.slot)) ||
      record.archiveBytes < 22 ||
      record.archiveBytes > kMaximumUploadedHomeBytes ||
      record.archiveSha256[64] != '\0' || record.packageId[36] != '\0' ||
      record.entryUuid[36] != '\0' ||
      !isLowerHexSha256(record.archiveSha256) ||
      !isUuid(record.packageId) || !isUuid(record.entryUuid) ||
      record.revision == 0) {
    return fail(error, "Stored-home activation record failed CRC/identity checks");
  }
  present = true;
  return true;
}

bool writeHomeRecord(const StoredHomeInfo &info, std::string &error) {
  PersistentHomeRecord record;
  record.slot = static_cast<uint8_t>(info.slot);
  record.archiveBytes = info.archiveBytes;
  record.revision = info.revision;
  std::memcpy(record.archiveSha256, info.archiveSha256.c_str(), 64);
  std::memcpy(record.packageId, info.packageId.c_str(), 36);
  std::memcpy(record.entryUuid, info.entryUuid.c_str(), 36);
  record.crc32 = homeRecordCrc(record);
  nvs_handle_t handle = 0;
  const esp_err_t opened = nvs_open(kNamespace, NVS_READWRITE, &handle);
  if (opened != ESP_OK) {
    return fail(error, std::string("NVS home record open failed: ") +
                           esp_err_to_name(opened));
  }
  const esp_err_t set =
      nvs_set_blob(handle, kHomeRecordKey, &record, sizeof(record));
  const esp_err_t committed = set == ESP_OK ? nvs_commit(handle) : set;
  nvs_close(handle);
  if (committed != ESP_OK) {
    return fail(error, std::string("NVS home activation commit failed: ") +
                           esp_err_to_name(committed));
  }
  return true;
}

bool byteVectorMatches(const std::vector<uint8_t> &body,
                       uint32_t expectedBytes,
                       const std::string &expectedSha,
                       const std::string &label, std::string &error) {
  if (body.size() != expectedBytes ||
      sha256Hex(body.data(), body.size()) != expectedSha) {
    return fail(error, label + " differs from manifest byte/hash identity");
  }
  return true;
}

bool textMatches(const std::string &body, uint32_t expectedBytes,
                 const std::string &expectedSha, const std::string &label,
                 std::string &error) {
  if (body.size() != expectedBytes ||
      sha256Hex(reinterpret_cast<const uint8_t *>(body.data()), body.size()) !=
          expectedSha) {
    return fail(error, label + " differs from manifest byte/hash identity");
  }
  return true;
}

bool validPng(const std::vector<uint8_t> &png, uint16_t width,
              uint16_t height, std::string &error) {
  return validatePngFrame(png, width, height,
                          PngFramePolicy::PackageGray4, error);
}

bool verifyHomeArchive(const uint8_t *bytes, size_t size, InkArchive &archive,
                       Manifest &manifest, std::string &error) {
  const int64_t startedAtUs = esp_timer_get_time();
  saveHomeCheckpoint(HomeCheckpointPhase::ZipDirectory, size, size);
  logHomeVerificationStage("zip-begin", startedAtUs);
  if (!archive.open(bytes, size, error)) return false;
  logHomeVerificationStage("zip-done", startedAtUs, archive.entryCount());
  saveHomeCheckpoint(HomeCheckpointPhase::ManifestExtract, size, size,
                     archive.entryCount());
  std::string manifestJson;
  if (!archive.extractText("ink-manifest.json", manifestJson,
                           kMaximumManifestBytes, error)) {
    return false;
  }
  logHomeVerificationStage("manifest-extracted", startedAtUs,
                           manifestJson.size());
  const std::string manifestSha = sha256Hex(
      reinterpret_cast<const uint8_t *>(manifestJson.data()),
      manifestJson.size());
  saveHomeCheckpoint(HomeCheckpointPhase::ManifestParse, size, size,
                     manifestJson.size());
  if (!parseManifest(manifestJson, manifestSha, '"' + manifestSha + '"',
                     manifest, error)) {
    return false;
  }
  logHomeVerificationStage("manifest-parsed", startedAtUs,
                           manifest.documents.size());
  DisplayMeta portraitMeta{Orientation::Portrait, 0, false};
  DisplayMeta landscapeMeta{Orientation::Landscape, 0, false};
  const DisplayVariant *portrait = selectVariant(manifest, portraitMeta);
  const DisplayVariant *landscape = selectVariant(manifest, landscapeMeta);
  if (!portrait || !landscape) {
    return fail(error,
                "Uploaded home must contain normal font-0 portrait and landscape variants");
  }
  std::set<std::string> ids;
  for (const auto &document : manifest.documents) ids.insert(document.uuid);
  std::set<std::string> expectedEntries = {"ink-manifest.json"};
  size_t checkedReferences = 0;
  saveHomeCheckpoint(HomeCheckpointPhase::References, size, size,
                     checkedReferences);
  for (const auto &document : manifest.documents) {
    if (document.documentPath != "documents/" + document.uuid + ".json" ||
        document.variants.size() != manifest.variants.size() ||
        !expectedEntries.insert(document.documentPath).second) {
      return fail(error,
                  "Uploaded home document paths/variant sets are incomplete");
    }
    if (!archive.validateEntryMetadata(document.documentPath,
                                       document.documentBytes, error)) {
      return false;
    }
    ++checkedReferences;
    if ((checkedReferences % 16) == 0) vTaskDelay(1);
    if ((checkedReferences % 128) == 0) {
      saveHomeCheckpoint(HomeCheckpointPhase::References, size, size,
                         checkedReferences);
      logHomeVerificationStage("references", startedAtUs,
                               checkedReferences);
    }
    std::set<std::string> ancestors;
    const DocumentRef *cursor = &document;
    while (!cursor->parentUuid.empty()) {
      if (!ancestors.insert(cursor->uuid).second) {
        return fail(error, "Uploaded home manifest contains a parent cycle");
      }
      cursor = findDocument(manifest, cursor->parentUuid);
      if (!cursor) return fail(error, "Uploaded home parent graph is incomplete");
    }
    if (cursor->uuid != manifest.entryUuid) {
      return fail(error, "Uploaded home document does not descend from its entry");
    }
    for (const auto &pageSet : document.variants) {
      const auto variant = std::find_if(
          manifest.variants.begin(), manifest.variants.end(),
          [&pageSet](const DisplayVariant &value) {
            return value.id == pageSet.variantId;
          });
      if (variant == manifest.variants.end() || pageSet.pages.empty()) {
        return fail(error, "Uploaded home references an unknown/empty variant");
      }
      for (const auto &page : pageSet.pages) {
        char pageName[16]{};
        std::snprintf(pageName, sizeof(pageName), "%04u", page.index);
        const std::string canonical = "frames/" + variant->id + "/" +
                                      document.uuid + "/" + pageName;
        const std::string expectedSourcePath =
            "source-images/" + variant->id + "/" + document.uuid + "/" +
            pageName + ".jpg";
        if (page.imagePath != canonical + ".png" ||
            page.sidecarPath != canonical + ".json" ||
            !expectedEntries.insert(page.imagePath).second ||
            !expectedEntries.insert(page.sidecarPath).second ||
            (page.sourceImage.present &&
             (page.sourceImage.path != expectedSourcePath ||
              !expectedEntries.insert(page.sourceImage.path).second))) {
          return fail(error,
                      "Uploaded home uses a non-canonical frame/source/sidecar path");
        }
        if (!archive.validateEntryMetadata(page.imagePath, page.imageBytes,
                                           error) ||
            !archive.validateEntryMetadata(page.sidecarPath,
                                           page.sidecarBytes, error) ||
            (page.sourceImage.present &&
             !archive.validateEntryMetadata(page.sourceImage.path,
                                            page.sourceImage.bytes, error))) {
          return false;
        }
        checkedReferences += page.sourceImage.present ? 3 : 2;
        if ((checkedReferences % 16) < 3) vTaskDelay(1);
        if ((checkedReferences % 128) < 3) {
          saveHomeCheckpoint(HomeCheckpointPhase::References, size, size,
                             checkedReferences);
          logHomeVerificationStage("references", startedAtUs,
                                   checkedReferences);
        }
      }
    }
  }
  saveHomeCheckpoint(HomeCheckpointPhase::References, size, size,
                     checkedReferences);
  logHomeVerificationStage("references-done", startedAtUs,
                           checkedReferences);
  if (expectedEntries.size() != archive.entryCount()) {
    return fail(error, "Uploaded home contains unreferenced archive entries");
  }

  // The active-slot NVS record is a trust boundary: every referenced payload
  // must be inflated/read and content-validated before that record can be
  // committed. Metadata closure alone cannot detect corruption inside a
  // non-entry compressed stream.
  const DocumentRef *entry = findDocument(manifest, manifest.entryUuid);
  if (!entry) return fail(error, "Uploaded home entry document is missing");
  saveHomeCheckpoint(HomeCheckpointPhase::EntryFrames, size, size, 0);
  if (!findPage(*entry, portrait->id, 0) ||
      !findPage(*entry, landscape->id, 0)) {
    return fail(error, "Uploaded home entry lacks a base-orientation frame");
  }
  logHomeVerificationStage("entry-frames-present", startedAtUs, 2);

  size_t totalPages = 0;
  for (const auto &document : manifest.documents) {
    for (const auto &pageSet : document.variants) {
      totalPages += pageSet.pages.size();
    }
  }
  size_t checkedDocuments = 0;
  size_t checkedPages = 0;
  saveHomeCheckpoint(HomeCheckpointPhase::Payloads, size, size, 0);
  logHomePayloadProgress(startedAtUs, checkedDocuments,
                         manifest.documents.size(), checkedPages, totalPages);

  std::string documentJson;
  std::string sidecarJson;
  std::vector<uint8_t> png;
  std::vector<uint8_t> sourceJpeg;
  for (const auto &document : manifest.documents) {
    documentJson.clear();
    if (!archive.extractText(document.documentPath, documentJson,
                             kMaximumDocumentBytes, error) ||
        !textMatches(documentJson, document.documentBytes,
                     document.documentSha256, "Document", error) ||
        !validateDocumentEnvelope(documentJson, document, error)) {
      return false;
    }

    for (const auto &pageSet : document.variants) {
      const auto variant = std::find_if(
          manifest.variants.begin(), manifest.variants.end(),
          [&pageSet](const DisplayVariant &candidate) {
            return candidate.id == pageSet.variantId;
          });
      if (variant == manifest.variants.end()) {
        return fail(error,
                    "Uploaded home payload names an unknown display variant");
      }
      for (const auto &page : pageSet.pages) {
        sidecarJson.clear();
        // Keep the verifier's peak bounded by one raster payload. ZIP entries
        // are attacker-controlled and clear() would retain a previous page's
        // potentially multi-megabyte capacity.
        std::vector<uint8_t>().swap(sourceJpeg);
        png.clear();
        if (!archive.extractText(page.sidecarPath, sidecarJson,
                                 kMaximumSidecarBytes, error) ||
            !textMatches(sidecarJson, page.sidecarBytes,
                         page.sidecarSha256, "Frame sidecar", error) ||
            !archive.extract(page.imagePath, png, kMaximumFrameBytes,
                             error) ||
            !byteVectorMatches(png, page.imageBytes, page.imageSha256,
                               "Frame PNG",
                               error) ||
            !validPng(png, variant->width, variant->height, error)) {
          return false;
        }
        Sidecar sidecar;
        if (!parseSidecar(sidecarJson, manifest.packageId, document.uuid,
                          page.index, variant->id, sidecar, error) ||
            sidecar.parentUuid != document.parentUuid ||
            sidecar.pageCount != pageSet.pages.size() ||
            sidecar.imagePath != page.imagePath ||
            sidecar.imageSha256 != page.imageSha256 ||
            !(sidecar.sourceImage == page.sourceImage) ||
            sidecar.width != variant->width ||
            sidecar.height != variant->height) {
          if (error.empty()) {
            error = "Uploaded home sidecar lineage changed";
          }
          return false;
        }
        if (page.sourceImage.present) {
          std::vector<uint8_t>().swap(png);
          if (!archive.extract(page.sourceImage.path, sourceJpeg,
                               kMaximumSourceImageBytes, error) ||
              !byteVectorMatches(sourceJpeg, page.sourceImage.bytes,
                                 page.sourceImage.sha256, "Source JPEG",
                                 error) ||
              !validateSourceJpeg(sourceJpeg, page.sourceImage.width,
                                  page.sourceImage.height, error)) {
            return false;
          }
        }
        for (const auto &interaction : sidecar.interactions) {
          if (ids.count(interaction.targetUuid) == 0) {
            return fail(
                error,
                "Uploaded home sidecar targets a document outside the archive");
          }
        }
        ++checkedPages;
        saveHomeCheckpoint(HomeCheckpointPhase::Payloads, size, size,
                           checkedPages);
        if ((checkedPages % 16) == 0 || checkedPages == totalPages) {
          logHomePayloadProgress(startedAtUs, checkedDocuments,
                                 manifest.documents.size(), checkedPages,
                                 totalPages);
        }
        // Each page is a bounded verification transaction. Let Wi-Fi/lwIP and
        // the idle tasks run before inflating the next JSON/PNG pair.
        vTaskDelay(1);
      }
    }
    ++checkedDocuments;
    if ((checkedDocuments % 10) == 0 ||
        checkedDocuments == manifest.documents.size()) {
      logHomePayloadProgress(startedAtUs, checkedDocuments,
                             manifest.documents.size(), checkedPages,
                             totalPages);
    }
    vTaskDelay(1);
  }
  if (checkedDocuments != manifest.documents.size() ||
      checkedPages != totalPages) {
    return fail(error, "Uploaded home payload verification count changed");
  }
  logHomeVerificationStage("complete", startedAtUs, expectedEntries.size());
  return true;
}

bool openVerifiedHomeArchive(const uint8_t *bytes, size_t size,
                             const PersistentHomeRecord &record,
                             InkArchive &archive, Manifest &manifest,
                             std::string &error) {
  // The NVS record is written only after verifyHomeArchive() succeeds.  On
  // activation/reboot, matching the complete archive SHA therefore proves we
  // are reopening those exact verified bytes; repeating the full 523-payload
  // CRC/SHA/schema/geometry pass would only double activation latency. Runtime
  // page loading still checks CRC, SHA, sidecar lineage and PNG geometry before
  // display as defense in depth.
  if (!archive.open(bytes, size, error)) return false;
  std::string manifestJson;
  if (!archive.extractText("ink-manifest.json", manifestJson,
                           kMaximumManifestBytes, error)) {
    return false;
  }
  const std::string manifestSha = sha256Hex(
      reinterpret_cast<const uint8_t *>(manifestJson.data()),
      manifestJson.size());
  if (!parseManifest(manifestJson, manifestSha, '"' + manifestSha + '"',
                     manifest, error)) {
    return false;
  }
  return manifest.packageId == record.packageId &&
                 manifest.entryUuid == record.entryUuid &&
                 manifest.revision == record.revision
             ? true
             : fail(error, "Active home record/archive identity changed");
}

struct HomeVerificationWork {
  const uint8_t *bytes = nullptr;
  size_t size = 0;
  InkArchive *archive = nullptr;
  Manifest *manifest = nullptr;
  std::string *archiveSha = nullptr;
  std::string *error = nullptr;
  TaskHandle_t waiter = nullptr;
  bool verified = false;
  UBaseType_t stackHighWater = 0;
};

void homeVerificationTask(void *context) {
  auto *work = static_cast<HomeVerificationWork *>(context);
  saveHomeCheckpoint(HomeCheckpointPhase::Hash, work->size, work->size);
  work->verified = sha256HexYielding(
      work->bytes, work->size, *work->archiveSha, *work->error);
  if (work->verified) {
    saveHomeCheckpoint(HomeCheckpointPhase::Archive, work->size, work->size);
    work->verified =
        verifyHomeArchive(work->bytes, work->size, *work->archive,
                          *work->manifest, *work->error);
  }
  work->stackHighWater = uxTaskGetStackHighWaterMark(nullptr);
  xTaskNotifyGive(work->waiter);
  vTaskDeleteWithCaps(nullptr);
}

bool flushHomeUploadBlock(HomeUpload &upload, std::string &error) {
  if (upload.pendingBlock.empty()) return true;
  const size_t offset = upload.writtenBytes - upload.pendingBlock.size();
  if ((offset % kFlashEraseBlockBytes) != 0 ||
      upload.pendingBlock.size() > kFlashEraseBlockBytes ||
      offset + upload.pendingBlock.size() > upload.expectedBytes) {
    return fail(error, "Uploaded .ink block buffering lost alignment");
  }
  if (!upload.flashIoBuffer ||
      upload.flashIoBufferBytes != kFlashIoChunkBytes ||
      upload.flashIoBufferBytes > CONFIG_SPI_FLASH_WRITE_CHUNK_SIZE ||
      !esp_ptr_internal(upload.flashIoBuffer.get()) ||
      !esp_ptr_in_dram(upload.flashIoBuffer.get())) {
    return fail(error, "Uploaded .ink flash I/O buffer left internal DRAM");
  }
  saveHomeCheckpoint(HomeCheckpointPhase::Compare, upload.expectedBytes,
                     upload.writtenBytes, offset);
  bool unchanged = true;
  bool blank = true;
  for (size_t cursor = 0; cursor < upload.pendingBlock.size();) {
    const size_t chunk =
        std::min({upload.flashIoBufferBytes, kCooperativeFlashChunkBytes,
                  upload.pendingBlock.size() - cursor});
    const esp_err_t read = esp_partition_read(
        upload.partition, offset + cursor, upload.flashIoBuffer.get(), chunk);
    if (read != ESP_OK) {
      return fail(error, std::string("Inactive home slot read failed: ") +
                             esp_err_to_name(read));
    }
    unchanged =
        unchanged &&
        std::memcmp(upload.flashIoBuffer.get(),
                    upload.pendingBlock.data() + cursor, chunk) == 0;
    blank = blank &&
            std::all_of(upload.flashIoBuffer.get(),
                        upload.flashIoBuffer.get() + chunk,
                        [](uint8_t value) { return value == 0xff; });
    cursor += chunk;
  }
  // Reads are short; yield once after the complete 64-KiB comparison pass.
  vTaskDelay(kFlashNetworkYieldTicks);
  if (unchanged) {
    upload.unchangedBytes += upload.pendingBlock.size();
    upload.pendingBlock.clear();
    return true;
  }
  // Reprogramming a non-erased NOR sector is not portable even when every bit
  // transition appears to be 1->0. Only bypass erase for a truly blank sector
  // (or the exact-data retry handled above).
  if (!blank) {
    const size_t eraseBytes =
        (upload.pendingBlock.size() + kFlashEraseSectorBytes - 1) &
        ~(kFlashEraseSectorBytes - 1);
    // A 64-KiB-aligned erase request makes the flash driver issue one block
    // erase command, which can keep both cores and the Wi-Fi stack outside a
    // schedulable cache window for too long. Force sector erases and yield
    // between them so the idle tasks can service the watchdog.
    for (size_t erasedOffset = 0; erasedOffset < eraseBytes;
         erasedOffset += kFlashEraseSectorBytes) {
      saveHomeCheckpoint(HomeCheckpointPhase::Erase, upload.expectedBytes,
                         upload.writtenBytes, offset + erasedOffset);
      const esp_err_t erased = esp_partition_erase_range(
          upload.partition, offset + erasedOffset, kFlashEraseSectorBytes);
      if (erased != ESP_OK) {
        return fail(error,
                    std::string("Inactive home sector erase failed: ") +
                        esp_err_to_name(erased));
      }
      upload.erasedBytes += kFlashEraseSectorBytes;
      vTaskDelay(kFlashNetworkYieldTicks);
    }
  }
  for (size_t cursor = 0; cursor < upload.pendingBlock.size();) {
    const size_t chunk =
        std::min({upload.flashIoBufferBytes, kCooperativeFlashChunkBytes,
                  upload.pendingBlock.size() - cursor});
    // pendingBlock normally lives in PSRAM because it is 64 KiB. Never pass
    // it to the flash driver: a non-DRAM source makes ESP-IDF fall back to a
    // 32-byte stack bounce buffer for every flash operation.
    std::memcpy(upload.flashIoBuffer.get(),
                upload.pendingBlock.data() + cursor, chunk);
    saveHomeCheckpoint(HomeCheckpointPhase::Write, upload.expectedBytes,
                       upload.writtenBytes, offset + cursor);
    const esp_err_t written = esp_partition_write(
        upload.partition, offset + cursor, upload.flashIoBuffer.get(), chunk);
    if (written != ESP_OK) {
      return fail(error, std::string("Inactive home slot write failed: ") +
                             esp_err_to_name(written));
    }
    cursor += chunk;
    vTaskDelay(kFlashNetworkYieldTicks);
  }
  upload.programmedBytes += upload.pendingBlock.size();
  upload.pendingBlock.clear();
  return true;
}

void signalCollectionsChanged() {
  portENTER_CRITICAL(&gEventMux);
  gCollectionsChanged = true;
  portEXIT_CRITICAL(&gEventMux);
}

void signalHomeChanged(bool deleted) {
  portENTER_CRITICAL(&gEventMux);
  gHomeChanged = true;
  gHomeDeleted = deleted;
  portEXIT_CRITICAL(&gEventMux);
}

} // namespace

void recordHomeUploadReceiveCheckpoint(size_t totalBytes,
                                       size_t receivedBytes) {
  if (totalBytes < 22 || totalBytes > kMaximumUploadedHomeBytes ||
      receivedBytes > totalBytes) {
    return;
  }
  // `writtenBytes` is the checkpoint's generic completed-byte counter. During
  // this phase it represents bytes received into PSRAM, before any flash write
  // is allowed to start.
  saveHomeCheckpoint(HomeCheckpointPhase::Receiving, totalBytes,
                     receivedBytes, receivedBytes);
}

void releaseHomeUploadBuffer(uint8_t *buffer) {
  if (!buffer) return;
  if (buffer == linkedHomeFlashIoBuffer()) {
    releaseLinkedHomeFlashIoBuffer();
    return;
  }
  // Kept defensive for compatibility with any HomeUpload value created by an
  // older caller during a rolling source update. New uploads only use DRAM BSS.
  heap_caps_free(buffer);
}

const char *collectionKindName(CollectionKind kind) {
  switch (kind) {
  case CollectionKind::Rss: return "rss";
  case CollectionKind::Website: return "website";
  case CollectionKind::Images: return "images";
  }
  return "website";
}

const char *collectionTitle(CollectionKind kind) {
  switch (kind) {
  case CollectionKind::Rss: return "RSS 阅读器";
  case CollectionKind::Website: return "网络阅读器";
  case CollectionKind::Images: return "图片查看器";
  }
  return "网络阅读器";
}

const std::vector<CollectionEntry> &collectionEntries(
    const DeviceCollections &collections, CollectionKind kind) {
  switch (kind) {
  case CollectionKind::Rss: return collections.rss;
  case CollectionKind::Website: return collections.websites;
  case CollectionKind::Images: return collections.images;
  }
  return collections.websites;
}

bool collectionKindForUrl(const std::string &url, CollectionKind &kind) {
  if (url == "inkos://collection/rss") {
    kind = CollectionKind::Rss;
    return true;
  }
  if (url == "inkos://collection/website" ||
      url == "inkos://collection/other") {
    kind = CollectionKind::Website;
    return true;
  }
  return false;
}

bool initializeDeviceStorage(std::string &error) {
  if (!gStorageMutex) gStorageMutex = xSemaphoreCreateMutex();
  if (!gStorageMutex) return fail(error, "Could not allocate storage mutex");
  gHomeA = esp_partition_find_first(ESP_PARTITION_TYPE_DATA,
                                    ESP_PARTITION_SUBTYPE_ANY, kHomePartitionA);
  gHomeB = esp_partition_find_first(ESP_PARTITION_TYPE_DATA,
                                    ESP_PARTITION_SUBTYPE_ANY, kHomePartitionB);
  if (!gHomeA || !gHomeB || gHomeA->size < kMaximumUploadedHomeBytes ||
      gHomeB->size < kMaximumUploadedHomeBytes ||
      gHomeA->address == gHomeB->address) {
    return fail(error, "A/B uploaded-home partitions are missing or too small");
  }
  ESP_LOGI(kTag, "home A/B capacity=%u/%u bytes",
           static_cast<unsigned>(gHomeA->size),
           static_cast<unsigned>(gHomeB->size));
  HomeUploadDiagnostic diagnostic;
  if (loadHomeUploadDiagnostic(diagnostic)) {
    ESP_LOGW(kTag,
             "retained home checkpoint seq=%u phase=%s written=%u/%u detail=%u",
             static_cast<unsigned>(diagnostic.sequence),
             diagnostic.phase.c_str(),
             static_cast<unsigned>(diagnostic.writtenBytes),
             static_cast<unsigned>(diagnostic.totalBytes),
             static_cast<unsigned>(diagnostic.detailOffset));
  }
  return true;
}

bool loadHomeUploadDiagnostic(HomeUploadDiagnostic &diagnostic) {
  const PersistentHomeCheckpoint checkpoint = homeCheckpointSnapshot();
  if (!validHomeCheckpoint(checkpoint)) {
    diagnostic = {};
    return false;
  }
  diagnostic.valid = true;
  diagnostic.sequence = checkpoint.sequence;
  diagnostic.totalBytes = checkpoint.totalBytes;
  diagnostic.writtenBytes = checkpoint.writtenBytes;
  diagnostic.detailOffset = checkpoint.detailOffset;
  diagnostic.phase = homeCheckpointPhaseName(
      static_cast<HomeCheckpointPhase>(checkpoint.phase));
  return true;
}

bool parseCollectionsJson(const std::string &json,
                          DeviceCollections &collections,
                          std::string &error) {
  bool requiresRewrite = false;
  return parseCollectionsJsonImpl(json, collections, requiresRewrite, error);
}

std::string collectionsJson(const DeviceCollections &collections) {
  cJSON *root = cJSON_CreateObject();
  cJSON_AddStringToObject(root, "schemaVersion",
                          "inkos.device-collections/v2");
  cJSON_AddNumberToObject(root, "revision", collections.revision);
  const auto addEntries = [root](const char *key,
                                 const std::vector<CollectionEntry> &entries) {
    cJSON *array = cJSON_AddArrayToObject(root, key);
    for (const auto &entry : entries) {
      cJSON *value = cJSON_CreateObject();
      cJSON_AddStringToObject(value, "id", entry.id.c_str());
      cJSON_AddStringToObject(value, "label", entry.label.c_str());
      cJSON_AddStringToObject(value, "url", entry.url.c_str());
      cJSON_AddItemToArray(array, value);
    }
  };
  addEntries("rss", collections.rss);
  addEntries("websites", collections.websites);
  addEntries("images", collections.images);
  char *printed = cJSON_PrintUnformatted(root);
  cJSON_Delete(root);
  if (!printed) return {};
  std::string result(printed);
  cJSON_free(printed);
  return result;
}

bool loadCollections(DeviceCollections &collections, std::string &error) {
  StorageLock lock;
  if (!lock.locked()) return fail(error, "Device storage is busy");
  const auto recoverDefaults = [&](const std::string &reason) {
    collections = defaultCollections();
    const std::string seeded = collectionsJson(collections);
    std::string persistError;
    if (seeded.empty() ||
        !writeCollectionsBlobUnlocked(seeded, persistError)) {
      ESP_LOGW(kTag,
               "using in-memory default collections after %s; repair was not "
               "persisted: %s",
               reason.c_str(),
               persistError.empty() ? "serialization failed"
                                    : persistError.c_str());
    } else {
      ESP_LOGW(kTag,
               "recovered default network-reader collection after %s (%u "
               "sites)",
               reason.c_str(),
               static_cast<unsigned>(collections.websites.size()));
    }
    // Stored user input is untrusted. A malformed blob may lose that one
    // collection revision, but it must never block the embedded home, Wi-Fi
    // portal, or the user's ability to replace it with a valid list.
    error.clear();
    return true;
  };
  nvs_handle_t handle = 0;
  const esp_err_t opened = nvs_open(kNamespace, NVS_READONLY, &handle);
  if (opened == ESP_ERR_NVS_NOT_FOUND) {
    return recoverDefaults("first boot");
  }
  if (opened != ESP_OK) {
    return recoverDefaults(std::string("NVS open error ") +
                           esp_err_to_name(opened));
  }
  size_t bytes = 0;
  esp_err_t status = nvs_get_blob(handle, kCollectionsKey, nullptr, &bytes);
  if (status == ESP_ERR_NVS_NOT_FOUND) {
    nvs_close(handle);
    return recoverDefaults("missing collection record");
  }
  if (status != ESP_OK || bytes == 0 || bytes > kMaximumCollectionsJsonBytes) {
    nvs_close(handle);
    return recoverDefaults("invalid stored collection size");
  }
  std::string json(bytes, '\0');
  status = nvs_get_blob(handle, kCollectionsKey, json.data(), &bytes);
  nvs_close(handle);
  if (status != ESP_OK) {
    return recoverDefaults(std::string("NVS collection read error ") +
                           esp_err_to_name(status));
  }
  bool requiresRewrite = false;
  if (!parseCollectionsJsonImpl(json, collections, requiresRewrite, error)) {
    const std::string parseError = error;
    return recoverDefaults(std::string("invalid stored collection JSON: ") +
                           parseError);
  }
  if (requiresRewrite) {
    collections.revision =
        collections.revision == UINT32_MAX ? 1 : collections.revision + 1;
    const std::string migrated = collectionsJson(collections);
    if (migrated.empty() || !writeCollectionsBlobUnlocked(migrated, error)) {
      ESP_LOGW(kTag,
               "collection is usable but its URL/schema migration was not "
               "persisted: %s",
               error.empty() ? "serialization failed" : error.c_str());
      error.clear();
      return true;
    }
    ESP_LOGI(kTag,
             "migrated collections into current readers (%u sites, %u images)",
             static_cast<unsigned>(collections.websites.size()),
             static_cast<unsigned>(collections.images.size()));
  }
  return true;
}

bool saveCollections(const DeviceCollections &collections, std::string &error) {
  const std::string json = collectionsJson(collections);
  DeviceCollections checked;
  if (json.empty() || !parseCollectionsJson(json, checked, error)) return false;
  StorageLock lock;
  if (!lock.locked()) return fail(error, "Device storage is busy");
  if (!writeCollectionsBlobUnlocked(json, error)) return false;
  signalCollectionsChanged();
  return true;
}

bool loadStoredHomeInfo(StoredHomeInfo &info, std::string &error) {
  StorageLock lock;
  if (!lock.locked()) return fail(error, "Device storage is busy");
  PersistentHomeRecord record;
  bool present = false;
  if (!readHomeRecord(record, present, error)) return false;
  if (!present) {
    info = {};
    return true;
  }
  info.active = true;
  info.slot = static_cast<char>(record.slot);
  info.archiveBytes = record.archiveBytes;
  info.revision = record.revision;
  info.archiveSha256 = record.archiveSha256;
  info.packageId = record.packageId;
  info.entryUuid = record.entryUuid;
  return true;
}

bool reserveHomeUploadIo(HomeUpload &upload, std::string &error) {
  if (upload.open) {
    return fail(error, "Cannot replace the buffer of an active home upload");
  }
  releaseHomeUploadIo(upload);
  if (!claimLinkedHomeFlashIoBuffer()) {
    return fail(error, "The static home-upload flash buffer is already in use");
  }
  uint8_t *buffer = linkedHomeFlashIoBuffer();
  if (!esp_ptr_internal(buffer) || !esp_ptr_in_dram(buffer)) {
    releaseLinkedHomeFlashIoBuffer();
    return fail(error, "Linked home-upload buffer is not internal DRAM");
  }
  upload.flashIoBuffer.reset(buffer);
  upload.flashIoBufferBytes = kFlashIoChunkBytes;
  constexpr uint32_t internalCaps = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
  ESP_LOGI(kTag,
           "home upload static I/O claimed bytes=%u free=%u largest=%u",
           static_cast<unsigned>(upload.flashIoBufferBytes),
           static_cast<unsigned>(heap_caps_get_free_size(internalCaps)),
           static_cast<unsigned>(
               heap_caps_get_largest_free_block(internalCaps)));
  return true;
}

bool beginHomeUpload(size_t contentBytes, HomeUpload &upload,
                     std::string &error) {
  if (contentBytes < 22 || contentBytes > kMaximumUploadedHomeBytes) {
    return fail(error, "Uploaded .ink must fit the 4.25-MiB device slot");
  }
  if (!upload.flashIoBuffer ||
      upload.flashIoBufferBytes != kFlashIoChunkBytes ||
      upload.flashIoBufferBytes > CONFIG_SPI_FLASH_WRITE_CHUNK_SIZE ||
      !esp_ptr_internal(upload.flashIoBuffer.get()) ||
      !esp_ptr_in_dram(upload.flashIoBuffer.get())) {
    return fail(error,
                "Flash-safe upload buffer was not reserved before acceptance");
  }
  auto reservedIo = std::move(upload.flashIoBuffer);
  const size_t reservedIoBytes = upload.flashIoBufferBytes;
  upload = {};
  upload.flashIoBuffer = std::move(reservedIo);
  upload.flashIoBufferBytes = reservedIoBytes;
  if (!gStorageMutex ||
      xSemaphoreTake(gStorageMutex, pdMS_TO_TICKS(30000)) != pdTRUE) {
    return fail(error, "Device storage is busy");
  }
  PersistentHomeRecord current;
  bool present = false;
  if (!readHomeRecord(current, present, error)) {
    xSemaphoreGive(gStorageMutex);
    return false;
  }
  upload.slot = present && current.slot == 'a' ? 'b' : 'a';
  upload.partition = partitionForSlot(upload.slot);
  upload.expectedBytes = contentBytes;
  upload.pendingBlock.reserve(kFlashEraseBlockBytes);
  upload.startedAtUs = esp_timer_get_time();
  upload.open = true;
  saveHomeCheckpoint(HomeCheckpointPhase::Begin, upload.expectedBytes, 0);
  ESP_LOGI(kTag,
           "home upload begin slot=%c bytes=%u io=%u internal=%d dram=%d",
           upload.slot, static_cast<unsigned>(upload.expectedBytes),
           static_cast<unsigned>(upload.flashIoBufferBytes),
           esp_ptr_internal(upload.flashIoBuffer.get()),
           esp_ptr_in_dram(upload.flashIoBuffer.get()));
  logHomeUploadResources(upload, "begin");
  return true;
}

bool appendHomeUpload(HomeUpload &upload, const uint8_t *bytes, size_t size,
                      std::string &error) {
  if (!upload.open || !upload.partition || !bytes || size == 0 ||
      size > upload.expectedBytes - upload.writtenBytes) {
    return fail(error, "Uploaded .ink stream exceeds its declared length");
  }
  size_t cursor = 0;
  while (cursor < size) {
    const size_t blockOffset =
        upload.writtenBytes - upload.pendingBlock.size();
    const size_t targetBytes =
        std::min(kFlashEraseBlockBytes, upload.expectedBytes - blockOffset);
    const size_t available = targetBytes - upload.pendingBlock.size();
    const size_t copied = std::min(available, size - cursor);
    upload.pendingBlock.insert(upload.pendingBlock.end(), bytes + cursor,
                               bytes + cursor + copied);
    upload.writtenBytes += copied;
    cursor += copied;
    if (upload.pendingBlock.size() == targetBytes) {
      if (!flushHomeUploadBlock(upload, error)) return false;
      if (upload.writtenBytes == upload.expectedBytes ||
          (upload.writtenBytes % kHomeUploadProgressBytes) == 0) {
        saveHomeCheckpoint(HomeCheckpointPhase::Stream, upload.expectedBytes,
                           upload.writtenBytes);
        logHomeUploadResources(upload, "progress");
      }
    }
  }
  return true;
}

bool finishHomeUpload(HomeUpload &upload, StoredHomeInfo &activated,
                      std::string &error) {
  if (!upload.open || upload.writtenBytes != upload.expectedBytes ||
      !upload.pendingBlock.empty()) {
    abortHomeUpload(upload);
    return fail(error, "Uploaded .ink length differs from Content-Length");
  }
  // The archive is now durable in the inactive slot. Return the streaming
  // buffers before parsing the large manifest and mapping flash.
  std::vector<uint8_t>().swap(upload.pendingBlock);
  releaseHomeUploadIo(upload);
  saveHomeCheckpoint(HomeCheckpointPhase::Map, upload.expectedBytes,
                     upload.writtenBytes);
  const void *mapped = nullptr;
  esp_partition_mmap_handle_t handle = 0;
  const esp_err_t mappedStatus = esp_partition_mmap(
      upload.partition, 0, upload.expectedBytes, ESP_PARTITION_MMAP_DATA,
      &mapped, &handle);
  if (mappedStatus != ESP_OK) {
    abortHomeUpload(upload);
    return fail(error, std::string("Inactive home slot mmap failed: ") +
                           esp_err_to_name(mappedStatus));
  }
  InkArchive archive;
  Manifest manifest;
  const auto *bytes = static_cast<const uint8_t *>(mapped);
  const int64_t verificationStartedAtUs = esp_timer_get_time();
  ESP_LOGI(kTag, "home upload stream complete; validating archive");
  logHomeUploadResources(upload, "verify");
  std::string archiveSha;
  HomeVerificationWork verification{
      .bytes = bytes,
      .size = upload.expectedBytes,
      .archive = &archive,
      .manifest = &manifest,
      .archiveSha = &archiveSha,
      .error = &error,
      .waiter = xTaskGetCurrentTaskHandle(),
  };
  TaskHandle_t verificationTask = nullptr;
  // ZIP/JSON verification is substantially deeper than streaming flash I/O.
  // Keep the writer's cache-safe internal stack small, but run this read-only
  // phase on a 32-KiB PSRAM stack. The internal writer remains blocked and will
  // perform mmap teardown plus the NVS commit after verification returns.
  if (xTaskCreatePinnedToCoreWithCaps(
          homeVerificationTask, "inkos_verify", kHomeVerificationStackBytes,
          &verification, tskIDLE_PRIORITY + 1, &verificationTask, 1,
          MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) != pdPASS) {
    esp_partition_munmap(handle);
    abortHomeUpload(upload);
    return fail(error, "Could not create the PSRAM home verification task");
  }
  ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
  const bool verified = verification.verified;
  const int64_t verificationElapsedMs =
      (esp_timer_get_time() - verificationStartedAtUs) / 1000;
  esp_partition_munmap(handle);
  ESP_LOGI(kTag,
           "home upload verifier finished ok=%d stack_free=%u elapsed=%lldms",
           verified, static_cast<unsigned>(verification.stackHighWater),
           static_cast<long long>(verificationElapsedMs));
  if (!verified) {
    ESP_LOGW(kTag, "home upload validation failed after %lldms: %s",
             static_cast<long long>(verificationElapsedMs), error.c_str());
    abortHomeUpload(upload);
    return false;
  }
  StoredHomeInfo candidate;
  candidate.active = true;
  candidate.slot = upload.slot;
  candidate.archiveBytes = upload.expectedBytes;
  candidate.revision = manifest.revision;
  candidate.archiveSha256 = archiveSha;
  candidate.packageId = manifest.packageId;
  candidate.entryUuid = manifest.entryUuid;
  saveHomeCheckpoint(HomeCheckpointPhase::Commit, upload.expectedBytes,
                     upload.writtenBytes);
  if (!writeHomeRecord(candidate, error)) {
    abortHomeUpload(upload);
    return false;
  }
  const int64_t totalElapsedMs =
      (esp_timer_get_time() - upload.startedAtUs) / 1000;
  ESP_LOGI(kTag,
           "home upload activated slot=%c bytes=%u total=%lldms verify=%lldms "
           "bytes erased=%u programmed=%u unchanged=%u",
           upload.slot, static_cast<unsigned>(upload.expectedBytes),
           static_cast<long long>(totalElapsedMs),
           static_cast<long long>(verificationElapsedMs),
           static_cast<unsigned>(upload.erasedBytes),
           static_cast<unsigned>(upload.programmedBytes),
           static_cast<unsigned>(upload.unchangedBytes));
  upload.open = false;
  xSemaphoreGive(gStorageMutex);
  upload = {};
  activated = std::move(candidate);
  signalHomeChanged(false);
  saveHomeCheckpoint(HomeCheckpointPhase::Activated, activated.archiveBytes,
                     activated.archiveBytes);
  return true;
}

void abortHomeUpload(HomeUpload &upload) {
  if (upload.expectedBytes > 0) {
    saveHomeCheckpoint(HomeCheckpointPhase::Failed, upload.expectedBytes,
                       upload.writtenBytes);
  }
  releaseHomeUploadIo(upload);
  if (upload.open && gStorageMutex) xSemaphoreGive(gStorageMutex);
  upload = {};
}

bool deleteUploadedHome(std::string &error) {
  StorageLock lock;
  if (!lock.locked()) return fail(error, "Device storage is busy");
  nvs_handle_t handle = 0;
  const esp_err_t opened = nvs_open(kNamespace, NVS_READWRITE, &handle);
  if (opened != ESP_OK) {
    return fail(error, std::string("NVS home record open failed: ") +
                           esp_err_to_name(opened));
  }
  const esp_err_t erased = nvs_erase_key(handle, kHomeRecordKey);
  const esp_err_t committed =
      erased == ESP_OK || erased == ESP_ERR_NVS_NOT_FOUND
          ? nvs_commit(handle)
          : erased;
  nvs_close(handle);
  if (committed != ESP_OK) {
    return fail(error, std::string("NVS home delete commit failed: ") +
                           esp_err_to_name(committed));
  }
  signalHomeChanged(true);
  return true;
}

bool mapStoredHome(StoredHomeMapping &mapping, InkArchive &archive,
                   Manifest &manifest, std::string &error) {
  mapping = {};
  StorageLock lock;
  if (!lock.locked()) return fail(error, "Device storage is busy");
  PersistentHomeRecord record;
  bool present = false;
  if (!readHomeRecord(record, present, error)) return false;
  if (!present) return fail(error, "No uploaded home is active");
  const esp_partition_t *partition =
      partitionForSlot(static_cast<char>(record.slot));
  const void *mapped = nullptr;
  esp_partition_mmap_handle_t handle = 0;
  const esp_err_t status = esp_partition_mmap(
      partition, 0, record.archiveBytes, ESP_PARTITION_MMAP_DATA, &mapped,
      &handle);
  if (status != ESP_OK) {
    return fail(error, std::string("Active home mmap failed: ") +
                           esp_err_to_name(status));
  }
  const auto *bytes = static_cast<const uint8_t *>(mapped);
  InkArchive parsedArchive;
  Manifest parsedManifest;
  std::string archiveSha;
  const bool valid =
      sha256HexYielding(bytes, record.archiveBytes, archiveSha, error) &&
      archiveSha == record.archiveSha256 &&
      openVerifiedHomeArchive(bytes, record.archiveBytes, record,
                              parsedArchive, parsedManifest, error);
  if (!valid) {
    esp_partition_munmap(handle);
    if (error.empty()) error = "Active home record/archive identity changed";
    return false;
  }
  mapping.bytes = bytes;
  mapping.size = record.archiveBytes;
  mapping.handle = handle;
  mapping.info = {true,
                  static_cast<char>(record.slot),
                  record.archiveBytes,
                  record.revision,
                  record.archiveSha256,
                  record.packageId,
                  record.entryUuid};
  archive = std::move(parsedArchive);
  manifest = std::move(parsedManifest);
  return true;
}

void unmapStoredHome(StoredHomeMapping &mapping) {
  if (mapping.handle) esp_partition_munmap(mapping.handle);
  mapping = {};
}

bool consumeCollectionsChanged() {
  portENTER_CRITICAL(&gEventMux);
  const bool changed = gCollectionsChanged;
  gCollectionsChanged = false;
  portEXIT_CRITICAL(&gEventMux);
  return changed;
}

bool consumeStoredHomeChanged(bool &deleted) {
  portENTER_CRITICAL(&gEventMux);
  const bool changed = gHomeChanged;
  deleted = gHomeDeleted;
  gHomeChanged = false;
  gHomeDeleted = false;
  portEXIT_CRITICAL(&gEventMux);
  return changed;
}

} // namespace inkos::idf
