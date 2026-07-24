#pragma once

#include <FS.h>

#include <cstdint>
#include <string>

namespace inkos::paper {

class NetworkAdapter {
public:
  bool connect(const char *ssid, const char *password, uint32_t timeoutMs,
               std::string &error);
  bool download(fs::FS &fs, const std::string &url,
                const std::string &destinationPath, uint64_t maximumBytes,
                const char *rootCa, std::string &error);
  bool connected() const;
};

} // namespace inkos::paper
