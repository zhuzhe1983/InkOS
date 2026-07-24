#pragma once

#include <cstdint>
#include <string>

namespace inkos {

inline constexpr uint32_t kClockTickIntervalMs = 1000;
inline constexpr uint16_t kClockCleanRefreshInterval = 60;

struct ClockBounds {
  int32_t x = 0;
  int32_t y = 0;
  int32_t width = 0;
  int32_t height = 0;
};

enum class ClockRefresh : uint8_t {
  None,
  Fast,
  Clean,
};

bool clockBoundsInside(const ClockBounds &bounds, uint16_t frameWidth,
                       uint16_t frameHeight);
bool usableClockEpoch(int64_t unixSeconds);
std::string formatShanghaiHms(int64_t unixSeconds);

// Monotonic, wrap-safe cadence. Delayed loops coalesce missed ticks rather
// than issuing a burst of e-paper refreshes.
class ClockSchedule {
public:
  void start(uint32_t nowMs,
             uint32_t refreshMs = kClockTickIntervalMs,
             uint16_t cleanRefreshEvery = kClockCleanRefreshInterval);
  void stop();
  ClockRefresh poll(uint32_t nowMs);
  bool active() const { return active_; }
  uint16_t refreshCount() const { return refreshCount_; }

private:
  bool active_ = false;
  uint32_t nextDueMs_ = 0;
  uint16_t refreshCount_ = 0;
  uint32_t refreshMs_ = kClockTickIntervalMs;
  uint16_t cleanRefreshEvery_ = kClockCleanRefreshInterval;
};

} // namespace inkos
