#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace inkos::idf {

class InkArchive {
public:
  bool open(const uint8_t *bytes, size_t size, std::string &error);
  bool extract(const std::string &path, std::vector<uint8_t> &result,
               size_t maximumBytes, std::string &error) const;
  bool extractText(const std::string &path, std::string &result,
                   size_t maximumBytes, std::string &error) const;
  // Checks the central-directory entry and its matching local header without
  // inflating the payload. This is used when activating a large uploaded home:
  // every manifest reference is proven present, bounded and canonical up
  // front, while CRC/SHA/content parsing remains mandatory when a page is
  // actually opened.
  bool validateEntryMetadata(const std::string &path, size_t expectedBytes,
                             std::string &error) const;
  size_t entryCount() const { return entries_.size(); }

  const uint8_t *bytes() const { return bytes_; }
  size_t size() const { return size_; }

private:
  struct Entry {
    std::string path;
    uint16_t flags = 0;
    uint16_t method = 0;
    uint32_t crc32 = 0;
    uint32_t compressedBytes = 0;
    uint32_t expandedBytes = 0;
    uint32_t localOffset = 0;
  };

  const Entry *find(const std::string &path) const;
  const uint8_t *bytes_ = nullptr;
  size_t size_ = 0;
  std::vector<Entry> entries_;
};

} // namespace inkos::idf
