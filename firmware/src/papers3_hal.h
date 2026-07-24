#pragma once

#include "package_catalog.h"

#include <FS.h>

#include <cstdint>
#include <string>

namespace inkos::paper {

enum class InputType : uint8_t {
  None,
  Tap,
  SwipeLeft,
  SwipeUp,
  SwipeDown,
  LongPress,
};

struct InputEvent {
  InputType type = InputType::None;
  int32_t x = 0;
  int32_t y = 0;
};

class PaperS3Display {
public:
  bool begin(std::string &error);
  bool probeFrame(fs::FS &fs, const std::string &path,
                  const DisplayVariant &variant, std::string &error);
  bool showFrame(fs::FS &fs, const std::string &path,
                 const DisplayVariant &variant, std::string &error);
  bool showClockRegion(const ClockRegion &region, const std::string &value,
                       bool cleanRefresh, std::string &error);
  void restoreStaticMode();
  void showStatus(const std::string &title, const std::string &detail);
  void showSettings(const DisplaySettings &settings,
                    const std::string &packageTitle);
  int32_t width() const;
  int32_t height() const;

private:
  bool configureOrientation(const DisplayVariant &variant,
                            std::string &error);
};

class PaperS3Touch {
public:
  InputEvent poll(int32_t logicalWidth, int32_t logicalHeight);
  bool active() const { return pressed_; }

private:
  bool pressed_ = false;
  int32_t startX_ = 0;
  int32_t startY_ = 0;
  int32_t lastX_ = 0;
  int32_t lastY_ = 0;
  uint32_t startedAt_ = 0;
};

} // namespace inkos::paper
