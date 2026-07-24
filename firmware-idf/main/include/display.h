#pragma once

#include "display_refresh_policy.h"
#include "ink_types.h"

#include <cstdint>
#include <string>
#include <vector>

namespace inkos::idf {

enum class InputKind : uint8_t {
  None,
  Tap,
  SwipeLeft,
  SwipeRight,
  SwipeUp,
  SwipeDown,
  SettingsHold,
};

struct InputEvent {
  InputKind kind = InputKind::None;
  int32_t x = 0;
  int32_t y = 0;
};

class PaperS3Display {
public:
  bool begin(std::string &error);
  bool showFrame(const std::vector<uint8_t> &png,
                 const DisplayVariant &variant,
                 const std::string &contentType,
                 FrameRenderProfile renderProfile,
                 FrameRefreshHint refreshHint, std::string &error);
  bool showClock(const ClockRegion &region, const std::string &previousValue,
                 const std::string &value, std::string &error);
  void showLoading(const std::string &detail);
  void showStatus(const std::string &title, const std::string &detail);
  void showSettings(const DeviceSettings &draft,
                    const std::string &packageTitle,
                    const std::string &managementAddress);
  void showPortal(const std::string &ssid, const std::string &address,
                  const std::string &detail);
  InputEvent pollInput();
  void suppressInputUntilRelease();
  bool suggestedOrientation(Orientation &orientation);
  int32_t width() const;
  int32_t height() const;
  void restoreQualityMode();

private:
  bool pressed_ = false;
  bool settingsHoldSent_ = false;
  bool settingsHoldEligible_ = false;
  bool inputSuppressed_ = false;
  int32_t startX_ = 0;
  int32_t startY_ = 0;
  int32_t lastX_ = 0;
  int32_t lastY_ = 0;
  int64_t pressedAtUs_ = 0;
  int64_t inputCooldownUntilUs_ = 0;
  Orientation lastSuggested_ = Orientation::Portrait;
  uint8_t orientationSamples_ = 0;
  int64_t lastImuPollUs_ = 0;
  DisplayRefreshState refreshState_;
};

} // namespace inkos::idf
