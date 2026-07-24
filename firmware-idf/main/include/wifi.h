#pragma once

#include "ink_types.h"

#include <cstdint>
#include <string>

namespace inkos::idf {

bool initializeWifi(std::string &error);
bool connectStation(const DeviceSettings &settings, uint32_t timeoutMs,
                    std::string &error);
bool wifiConnected();
std::string stationAddress();
std::string configurationApSsid();

class CaptivePortal {
public:
  // Starts only the persistent HTTP manager on the station interface. The
  // same server remains alive when the captive AP is later stopped.
  bool startManager(const DeviceSettings &current, std::string &error);
  bool start(const DeviceSettings &current, std::string &error);
  // Stops the AP/DNS redirect but intentionally keeps the LAN manager alive.
  void stop();
  bool running() const { return running_; }
  bool managerRunning() const { return server_ != nullptr; }
  bool consumeSaved(DeviceSettings &settings);

private:
  bool running_ = false;
  void *server_ = nullptr;
  void *dnsTask_ = nullptr;
};

} // namespace inkos::idf
