#include "clock_runtime.h"

#include <Arduino.h>
#include <esp_sntp.h>

#include <ctime>

namespace inkos::paper {
namespace {

constexpr uint32_t kClockWifiTimeoutMs = 8000;
constexpr uint32_t kClockSntpTimeoutMs = 4000;
constexpr const char *kShanghaiPosixTimezone = "CST-8";

bool waitForSntp(uint32_t timeoutMs) {
  const uint32_t started = millis();
  while (millis() - started < timeoutMs) {
    if (esp_sntp_get_sync_status() == SNTP_SYNC_STATUS_COMPLETED) {
      return true;
    }
    delay(50);
  }
  return esp_sntp_get_sync_status() == SNTP_SYNC_STATUS_COMPLETED;
}

} // namespace

void ClockRuntime::activate(const FrameSidecar &sidecar,
                            PaperS3Display &display, NetworkAdapter &network,
                            const char *wifiSsid, const char *wifiPassword,
                            std::string &warning) {
  stop(display);
  warning.clear();
  regions_ = sidecar.dynamicRegions;
  if (regions_.empty()) {
    return;
  }

  // Re-entering a clock page should not repeatedly pay the Wi-Fi/SNTP setup
  // cost after the system clock has become usable. The fixed-offset formatter
  // below does not depend on libc's global timezone state.
  const int64_t currentEpoch = static_cast<int64_t>(std::time(nullptr));
  const bool needsTime = !inkos::usableClockEpoch(currentEpoch);
  bool connected = network.connected();
  if (needsTime && !connected) {
    std::string networkError;
    connected = network.connect(wifiSsid, wifiPassword, kClockWifiTimeoutMs,
                                networkError);
    if (!connected) {
      warning = "clock Wi-Fi unavailable: " + networkError;
    }
  }
  if (needsTime && connected) {
    configTzTime(kShanghaiPosixTimezone, "ntp.aliyun.com", "pool.ntp.org",
                 "time.cloudflare.com");
    if (!waitForSntp(kClockSntpTimeoutMs)) {
      warning = "clock SNTP timed out; retaining local system time";
    }
  }

  const uint32_t nowMs = millis();
  schedules_.reserve(regions_.size());
  for (const ClockRegion &region : regions_) {
    inkos::ClockSchedule schedule;
    schedule.start(nowMs, region.refreshMs, region.fullRefreshEvery);
    schedules_.push_back(schedule);
  }
}

void ClockRuntime::stop(PaperS3Display &display) {
  if (!regions_.empty()) {
    for (auto &schedule : schedules_) {
      schedule.stop();
    }
    regions_.clear();
    schedules_.clear();
    display.restoreStaticMode();
  }
}

bool ClockRuntime::tick(PaperS3Display &display, std::string &error) {
  if (regions_.empty()) {
    return true;
  }
  const uint32_t nowMs = millis();
  const int64_t now = static_cast<int64_t>(std::time(nullptr));
  if (!inkos::usableClockEpoch(now)) {
    // Keep the server-rendered static fallback. configTzTime continues in the
    // background, so a later tick will begin local updates after SNTP succeeds.
    return true;
  }
  const std::string value = inkos::formatShanghaiHms(now);
  for (size_t index = 0; index < regions_.size(); ++index) {
    const inkos::ClockRefresh refresh = schedules_[index].poll(nowMs);
    if (refresh == inkos::ClockRefresh::None) {
      continue;
    }
    if (!display.showClockRegion(regions_[index], value,
                                 refresh == inkos::ClockRefresh::Clean,
                                 error)) {
      return false;
    }
  }
  return true;
}

} // namespace inkos::paper
