#pragma once

#include "ink_archive.h"
#include "ink_types.h"

#include <esp_partition.h>

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace inkos::idf {

void releaseHomeUploadBuffer(uint8_t *buffer);

inline constexpr size_t kMaximumRssCollectionEntries = 16;
// A valid v1 blob could contain 16 website plus 16 `other` entries. v2 folds
// both into this one list without dropping user data.
inline constexpr size_t kMaximumWebsiteCollectionEntries = 32;
inline constexpr size_t kMaximumImageCollectionEntries = 16;
inline constexpr size_t kMaximumCollectionLabelBytes = 96;
inline constexpr size_t kMaximumCollectionUrlBytes = 1024;
inline constexpr size_t kMaximumUploadedHomeBytes = 0x440000;

enum class CollectionKind : uint8_t { Rss, Website, Images };

struct CollectionEntry {
  std::string id;
  std::string label;
  std::string url;
};

struct DeviceCollections {
  uint32_t revision = 1;
  std::vector<CollectionEntry> rss;
  std::vector<CollectionEntry> websites;
  std::vector<CollectionEntry> images;
};

struct StoredHomeInfo {
  bool active = false;
  char slot = 0;
  uint32_t archiveBytes = 0;
  uint32_t revision = 0;
  std::string archiveSha256;
  std::string packageId;
  std::string entryUuid;
};

struct StoredHomeMapping {
  const uint8_t *bytes = nullptr;
  size_t size = 0;
  esp_partition_mmap_handle_t handle = 0;
  StoredHomeInfo info;
};

struct HomeUploadDiagnostic {
  bool valid = false;
  uint32_t sequence = 0;
  uint32_t totalBytes = 0;
  uint32_t writtenBytes = 0;
  uint32_t detailOffset = 0;
  std::string phase;
};

struct HomeUpload {
  const esp_partition_t *partition = nullptr;
  char slot = 0;
  size_t expectedBytes = 0;
  size_t writtenBytes = 0;
  std::vector<uint8_t> pendingBlock;
  std::unique_ptr<uint8_t, decltype(&releaseHomeUploadBuffer)> flashIoBuffer{
      nullptr, &releaseHomeUploadBuffer};
  size_t flashIoBufferBytes = 0;
  uint32_t erasedBytes = 0;
  uint32_t programmedBytes = 0;
  uint32_t unchangedBytes = 0;
  int64_t startedAtUs = 0;
  bool open = false;
};

bool initializeDeviceStorage(std::string &error);
// Record upload-body progress only in RTC no-init memory. This is safe to call
// from the HTTP receive path: it performs no NVS or partition I/O.
void recordHomeUploadReceiveCheckpoint(size_t totalBytes,
                                       size_t receivedBytes);
bool loadCollections(DeviceCollections &collections, std::string &error);
bool saveCollections(const DeviceCollections &collections, std::string &error);
bool parseCollectionsJson(const std::string &json,
                          DeviceCollections &collections,
                          std::string &error);
std::string collectionsJson(const DeviceCollections &collections);
const std::vector<CollectionEntry> &collectionEntries(
    const DeviceCollections &collections, CollectionKind kind);
const char *collectionKindName(CollectionKind kind);
const char *collectionTitle(CollectionKind kind);
bool collectionKindForUrl(const std::string &url, CollectionKind &kind);

// Claim the statically linked flash-driver-safe internal DRAM bounce buffer
// before an upload is accepted. The single active upload owns this lease until
// finish/abort/destruction.
bool reserveHomeUploadIo(HomeUpload &upload, std::string &error);
bool beginHomeUpload(size_t contentBytes, HomeUpload &upload,
                     std::string &error);
bool appendHomeUpload(HomeUpload &upload, const uint8_t *bytes, size_t size,
                      std::string &error);
bool finishHomeUpload(HomeUpload &upload, StoredHomeInfo &activated,
                      std::string &error);
void abortHomeUpload(HomeUpload &upload);
bool deleteUploadedHome(std::string &error);
bool loadStoredHomeInfo(StoredHomeInfo &info, std::string &error);
bool loadHomeUploadDiagnostic(HomeUploadDiagnostic &diagnostic);
bool mapStoredHome(StoredHomeMapping &mapping, InkArchive &archive,
                   Manifest &manifest, std::string &error);
void unmapStoredHome(StoredHomeMapping &mapping);

// HTTP callbacks set these flags only after the corresponding NVS commit.
// The display/runtime task consumes them and performs the visible activation.
bool consumeCollectionsChanged();
bool consumeStoredHomeChanged(bool &deleted);

} // namespace inkos::idf
