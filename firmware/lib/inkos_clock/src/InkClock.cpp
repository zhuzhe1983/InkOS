#include "InkClock.h"

#include <cstdio>

namespace inkos {

bool clockBoundsInside(const ClockBounds &bounds, uint16_t frameWidth,
                       uint16_t frameHeight) {
  return bounds.x >= 0 && bounds.y >= 0 && bounds.width > 0 &&
         bounds.height > 0 &&
         static_cast<int64_t>(bounds.x) + bounds.width <= frameWidth &&
         static_cast<int64_t>(bounds.y) + bounds.height <= frameHeight;
}

bool usableClockEpoch(int64_t unixSeconds) {
  // Match Arduino getLocalTime's validity era without depending on Arduino.
  return unixSeconds >= 1483228800LL; // 2017-01-01T00:00:00Z
}

std::string formatShanghaiHms(int64_t unixSeconds) {
  constexpr int64_t secondsPerDay = 24 * 60 * 60;
  constexpr int64_t shanghaiOffset = 8 * 60 * 60;
  int64_t localSeconds = (unixSeconds + shanghaiOffset) % secondsPerDay;
  if (localSeconds < 0) {
    localSeconds += secondsPerDay;
  }
  const int hours = static_cast<int>(localSeconds / 3600);
  const int minutes = static_cast<int>((localSeconds / 60) % 60);
  const int seconds = static_cast<int>(localSeconds % 60);
  char value[9] = {};
  std::snprintf(value, sizeof(value), "%02d:%02d:%02d", hours, minutes,
                seconds);
  return value;
}

void ClockSchedule::start(uint32_t nowMs, uint32_t refreshMs,
                          uint16_t cleanRefreshEvery) {
  active_ = true;
  nextDueMs_ = nowMs;
  refreshCount_ = 0;
  refreshMs_ = refreshMs == 0 ? kClockTickIntervalMs : refreshMs;
  cleanRefreshEvery_ = cleanRefreshEvery == 0
                           ? kClockCleanRefreshInterval
                           : cleanRefreshEvery;
}

void ClockSchedule::stop() {
  active_ = false;
  refreshCount_ = 0;
}

ClockRefresh ClockSchedule::poll(uint32_t nowMs) {
  if (!active_ || static_cast<int32_t>(nowMs - nextDueMs_) < 0) {
    return ClockRefresh::None;
  }
  nextDueMs_ = nowMs + refreshMs_;
  ++refreshCount_;
  return refreshCount_ % cleanRefreshEvery_ == 0
             ? ClockRefresh::Clean
             : ClockRefresh::Fast;
}

} // namespace inkos
