#include "ink_archive.h"

#include <esp_rom_crc.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <miniz.h>

#include <algorithm>
#include <cstring>
#include <set>

namespace inkos::idf {
namespace {

constexpr uint32_t kCentralSignature = 0x02014b50;
constexpr uint32_t kLocalSignature = 0x04034b50;
constexpr uint32_t kEocdSignature = 0x06054b50;
constexpr size_t kMaximumEntries = 8192;
constexpr size_t kMaximumExpandedArchive = 64U * 1024U * 1024U;

bool fail(std::string &error, const std::string &message) {
  error = message;
  return false;
}

uint16_t read16(const uint8_t *value) {
  return static_cast<uint16_t>(value[0]) |
         static_cast<uint16_t>(value[1]) << 8;
}

uint32_t read32(const uint8_t *value) {
  return static_cast<uint32_t>(value[0]) |
         static_cast<uint32_t>(value[1]) << 8 |
         static_cast<uint32_t>(value[2]) << 16 |
         static_cast<uint32_t>(value[3]) << 24;
}

bool normalizedPath(const std::string &path) {
  if (path.empty() || path.size() > 1024 || path.front() == '/' ||
      path.back() == '/' || path.find('\\') != std::string::npos ||
      path.find('\0') != std::string::npos || path.find(':') != std::string::npos) {
    return false;
  }
  size_t cursor = 0;
  while (cursor < path.size()) {
    const size_t slash = path.find('/', cursor);
    const std::string part = path.substr(
        cursor, slash == std::string::npos ? std::string::npos : slash - cursor);
    if (part.empty() || part == "." || part == "..") return false;
    if (slash == std::string::npos) break;
    cursor = slash + 1;
  }
  return true;
}

} // namespace

bool InkArchive::open(const uint8_t *bytes, size_t size, std::string &error) {
  entries_.clear();
  bytes_ = nullptr;
  size_ = 0;
  if (!bytes || size < 22) return fail(error, "Embedded .ink is truncated");

  const size_t scanStart = size > 65557 ? size - 65557 : 0;
  size_t eocd = SIZE_MAX;
  for (size_t cursor = size - 22;; --cursor) {
    if (read32(bytes + cursor) == kEocdSignature) {
      eocd = cursor;
      break;
    }
    if (cursor == scanStart) break;
  }
  if (eocd == SIZE_MAX || eocd + 22 > size) {
    return fail(error, "Embedded .ink has no ZIP end record");
  }
  const uint16_t disk = read16(bytes + eocd + 4);
  const uint16_t centralDisk = read16(bytes + eocd + 6);
  const uint16_t entriesOnDisk = read16(bytes + eocd + 8);
  const uint16_t entryCount = read16(bytes + eocd + 10);
  const uint32_t centralBytes = read32(bytes + eocd + 12);
  const uint32_t centralOffset = read32(bytes + eocd + 16);
  const uint16_t commentBytes = read16(bytes + eocd + 20);
  if (disk != 0 || centralDisk != 0 || entriesOnDisk != entryCount ||
      entryCount == 0 || entryCount > kMaximumEntries ||
      eocd + 22 + commentBytes != size || centralOffset > size ||
      centralBytes > size - centralOffset ||
      centralOffset + centralBytes > eocd) {
    return fail(error, "Embedded .ink uses unsupported ZIP/ZIP64 layout");
  }

  size_t cursor = centralOffset;
  uint64_t expandedTotal = 0;
  std::set<std::string> paths;
  entries_.reserve(entryCount);
  for (uint16_t index = 0; index < entryCount; ++index) {
    if (cursor + 46 > size || read32(bytes + cursor) != kCentralSignature) {
      return fail(error, "Embedded .ink central directory is corrupt");
    }
    Entry entry;
    entry.flags = read16(bytes + cursor + 8);
    entry.method = read16(bytes + cursor + 10);
    entry.crc32 = read32(bytes + cursor + 16);
    entry.compressedBytes = read32(bytes + cursor + 20);
    entry.expandedBytes = read32(bytes + cursor + 24);
    const uint16_t nameBytes = read16(bytes + cursor + 28);
    const uint16_t extraBytes = read16(bytes + cursor + 30);
    const uint16_t itemCommentBytes = read16(bytes + cursor + 32);
    const uint16_t startDisk = read16(bytes + cursor + 34);
    entry.localOffset = read32(bytes + cursor + 42);
    const size_t recordBytes = static_cast<size_t>(46) + nameBytes + extraBytes +
                               itemCommentBytes;
    if (nameBytes == 0 || cursor + recordBytes > size || startDisk != 0 ||
        entry.compressedBytes == UINT32_MAX ||
        entry.expandedBytes == UINT32_MAX || entry.localOffset == UINT32_MAX ||
        (entry.flags & 0x0001U) != 0 ||
        (entry.method != 0 && entry.method != 8)) {
      return fail(error, "Embedded .ink contains an unsupported ZIP entry");
    }
    entry.path.assign(reinterpret_cast<const char *>(bytes + cursor + 46),
                      nameBytes);
    if (!normalizedPath(entry.path) || !paths.insert(entry.path).second) {
      return fail(error, "Embedded .ink has an unsafe or duplicate path");
    }
    expandedTotal += entry.expandedBytes;
    if (expandedTotal > kMaximumExpandedArchive) {
      return fail(error, "Embedded .ink exceeds expanded size limit");
    }
    entries_.push_back(std::move(entry));
    cursor += recordBytes;
    if ((index & 0x3fU) == 0x3fU) vTaskDelay(1);
  }
  if (cursor != centralOffset + centralBytes) {
    return fail(error, "Embedded .ink central directory length changed");
  }
  bytes_ = bytes;
  size_ = size;
  return true;
}

const InkArchive::Entry *InkArchive::find(const std::string &path) const {
  const auto found = std::find_if(entries_.begin(), entries_.end(),
                                  [&path](const Entry &entry) {
                                    return entry.path == path;
                                  });
  return found == entries_.end() ? nullptr : &*found;
}

bool InkArchive::extract(const std::string &path, std::vector<uint8_t> &result,
                         size_t maximumBytes, std::string &error) const {
  const Entry *entry = find(path);
  if (!entry) return fail(error, "Embedded .ink is missing " + path);
  if (entry->expandedBytes == 0 || entry->expandedBytes > maximumBytes) {
    return fail(error, "Embedded .ink entry exceeds runtime limit: " + path);
  }
  if (!validateEntryMetadata(path, entry->expandedBytes, error)) return false;
  if (entry->localOffset > size_ || entry->localOffset + 30 > size_ ||
      read32(bytes_ + entry->localOffset) != kLocalSignature) {
    return fail(error, "Embedded .ink local header is corrupt: " + path);
  }
  const uint16_t localFlags = read16(bytes_ + entry->localOffset + 6);
  const uint16_t localMethod = read16(bytes_ + entry->localOffset + 8);
  const uint16_t nameBytes = read16(bytes_ + entry->localOffset + 26);
  const uint16_t extraBytes = read16(bytes_ + entry->localOffset + 28);
  const size_t dataOffset = static_cast<size_t>(entry->localOffset) + 30 +
                            nameBytes + extraBytes;
  if ((localFlags & 0x0001U) != 0 || localMethod != entry->method ||
      dataOffset > size_ || entry->compressedBytes > size_ - dataOffset) {
    return fail(error, "Embedded .ink local entry changed: " + path);
  }
  result.assign(entry->expandedBytes, 0);
  if (entry->method == 0) {
    if (entry->compressedBytes != entry->expandedBytes) {
      result.clear();
      return fail(error, "Stored ZIP entry has mismatched lengths: " + path);
    }
    std::memcpy(result.data(), bytes_ + dataOffset, entry->expandedBytes);
  } else {
    const size_t expanded = tinfl_decompress_mem_to_mem(
        result.data(), result.size(), bytes_ + dataOffset,
        entry->compressedBytes, TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF);
    if (expanded != entry->expandedBytes) {
      result.clear();
      return fail(error, "Deflate failed for embedded .ink entry: " + path);
    }
  }
  const uint32_t actualCrc = esp_rom_crc32_le(0, result.data(), result.size());
  if (actualCrc != entry->crc32) {
    result.clear();
    return fail(error, "CRC-32 mismatch in embedded .ink entry: " + path);
  }
  return true;
}

bool InkArchive::validateEntryMetadata(const std::string &path,
                                       size_t expectedBytes,
                                       std::string &error) const {
  const Entry *entry = find(path);
  if (!entry) return fail(error, "Embedded .ink is missing " + path);
  if (expectedBytes == 0 || entry->expandedBytes != expectedBytes) {
    return fail(error, "Embedded .ink entry length changed: " + path);
  }
  if (entry->localOffset > size_ || entry->localOffset + 30 > size_ ||
      read32(bytes_ + entry->localOffset) != kLocalSignature) {
    return fail(error, "Embedded .ink local header is corrupt: " + path);
  }
  const uint16_t localFlags = read16(bytes_ + entry->localOffset + 6);
  const uint16_t localMethod = read16(bytes_ + entry->localOffset + 8);
  const uint32_t localCrc = read32(bytes_ + entry->localOffset + 14);
  const uint32_t localCompressed = read32(bytes_ + entry->localOffset + 18);
  const uint32_t localExpanded = read32(bytes_ + entry->localOffset + 22);
  const uint16_t nameBytes = read16(bytes_ + entry->localOffset + 26);
  const uint16_t extraBytes = read16(bytes_ + entry->localOffset + 28);
  const size_t nameOffset = static_cast<size_t>(entry->localOffset) + 30;
  const size_t dataOffset = nameOffset + nameBytes + extraBytes;
  if (localFlags != entry->flags || (localFlags & 0x0009U) != 0 ||
      localMethod != entry->method || nameBytes != path.size() ||
      nameOffset > size_ || nameBytes > size_ - nameOffset ||
      std::memcmp(bytes_ + nameOffset, path.data(), nameBytes) != 0 ||
      dataOffset > size_ || entry->compressedBytes > size_ - dataOffset ||
      localCrc != entry->crc32 || localCompressed != entry->compressedBytes ||
      localExpanded != entry->expandedBytes) {
    return fail(error, "Embedded .ink local entry changed: " + path);
  }
  return true;
}

bool InkArchive::extractText(const std::string &path, std::string &result,
                             size_t maximumBytes, std::string &error) const {
  std::vector<uint8_t> bytes;
  if (!extract(path, bytes, maximumBytes, error)) return false;
  if (std::find(bytes.begin(), bytes.end(), 0) != bytes.end()) {
    return fail(error, "Embedded JSON contains a NUL byte: " + path);
  }
  result.assign(reinterpret_cast<const char *>(bytes.data()), bytes.size());
  return true;
}

} // namespace inkos::idf
