#include <FS.h>
#include <SD.h>
#include <M5GFX.h>
#include <M5Unified.h>

#include "papers3_hal.h"

#include <algorithm>
#include <cstdlib>

namespace inkos::paper {
namespace {

bool fail(std::string &error, const std::string &message) {
  error = message;
  return false;
}

bool decodeToCanvas(M5Canvas &canvas, fs::FS &fs, const std::string &path,
                    uint16_t width, uint16_t height, std::string &error) {
  canvas.setPsram(true);
  canvas.setColorDepth(8);
  if (!canvas.createSprite(width, height)) {
    return fail(error, "Cannot allocate PaperS3 frame buffer in PSRAM");
  }
  canvas.fillScreen(TFT_WHITE);
  if (!canvas.drawPngFile(fs, path.c_str(), 0, 0, width, height)) {
    canvas.deleteSprite();
    return fail(error, "M5GFX could not decode the verified PNG frame");
  }
  return true;
}

lgfx::textdatum_t clockDatum(ClockTextAlign horizontal,
                             ClockVerticalAlign vertical) {
  const uint8_t x = horizontal == ClockTextAlign::Center
                        ? 1
                        : horizontal == ClockTextAlign::Right ? 2 : 0;
  const uint8_t y = vertical == ClockVerticalAlign::Middle
                        ? 4
                        : vertical == ClockVerticalAlign::Bottom ? 8 : 0;
  return static_cast<lgfx::textdatum_t>(x + y);
}

} // namespace

bool PaperS3Display::begin(std::string &error) {
  auto config = M5.config();
  config.clear_display = false;
  M5.begin(config);
  if (M5.getBoard() != m5::board_t::board_M5PaperS3) {
    return fail(error, "M5Unified did not detect an M5PaperS3 board");
  }
  if (!psramFound()) {
    return fail(error, "PaperS3 Octal PSRAM is unavailable");
  }
  M5.Display.setRotation(1); // 960 x 540 physical landscape.
  M5.Display.setColorDepth(8);
  // Static package frames carry 16-level gray pixels. Panel_EPD quantizes
  // writes to monochrome in epd_fast/epd_fastest, so full frames must enter
  // the framebuffer in a gray-preserving mode.
  M5.Display.setEpdMode(epd_quality);
  M5.Touch.setFlickThresh(48);
  return true;
}

bool PaperS3Display::configureOrientation(const DisplayVariant &variant,
                                          std::string &error) {
  // M5GFX's PaperS3 panel has offset_rotation=3.  Its public rotations 0 and 1
  // therefore expose the profile's 540x960 (90 degree) and 960x540 (0 degree)
  // logical coordinate systems respectively.
  if (variant.displayRotation == 90) {
    M5.Display.setRotation(0);
  } else if (variant.displayRotation == 0) {
    M5.Display.setRotation(1);
  } else {
    return fail(error, "Unsupported PaperS3 display rotation");
  }
  if (M5.Display.width() != variant.width ||
      M5.Display.height() != variant.height) {
    return fail(error, "PaperS3 driver geometry does not match package variant");
  }
  return true;
}

bool PaperS3Display::probeFrame(fs::FS &fs, const std::string &path,
                               const DisplayVariant &variant,
                               std::string &error) {
  if (!configureOrientation(variant, error)) {
    return false;
  }
  M5Canvas canvas(&M5.Display);
  if (!decodeToCanvas(canvas, fs, path, variant.width, variant.height, error)) {
    return false;
  }
  canvas.deleteSprite();
  return true;
}

bool PaperS3Display::showFrame(fs::FS &fs, const std::string &path,
                              const DisplayVariant &variant,
                              std::string &error) {
  if (!configureOrientation(variant, error)) {
    return false;
  }
  M5Canvas canvas(&M5.Display);
  if (!decodeToCanvas(canvas, fs, path, variant.width, variant.height, error)) {
    return false;
  }
  // The physical e-paper is updated only after a complete decode, preserving
  // the retained previous image when loading fails.
  M5.Display.waitDisplay();
  M5.Display.setEpdMode(epd_quality);
  canvas.pushSprite(0, 0);
  M5.Display.waitDisplay();
  canvas.deleteSprite();
  return true;
}

bool PaperS3Display::showClockRegion(const ClockRegion &region,
                                     const std::string &value,
                                     bool cleanRefresh,
                                     std::string &error) {
  if (value.size() != 8 || region.bounds.width > UINT16_MAX ||
      region.bounds.height > UINT16_MAX) {
    return fail(error, "Invalid local clock draw request");
  }
  M5Canvas canvas(&M5.Display);
  canvas.setPsram(true);
  canvas.setColorDepth(8);
  if (!canvas.createSprite(region.bounds.width, region.bounds.height)) {
    return fail(error, "Cannot allocate local clock sprite");
  }

  const uint32_t foreground = region.style.foregroundWhite ? TFT_WHITE : TFT_BLACK;
  const uint32_t background = region.style.backgroundWhite ? TFT_WHITE : TFT_BLACK;
  canvas.fillSprite(background);
  canvas.setTextColor(foreground, background);
  canvas.setTextWrap(false, false);
  canvas.setFont(region.style.fontWeight == 700
                     ? &fonts::FreeMonoBold24pt7b
                     : &fonts::FreeMono24pt7b);
  canvas.setTextSize(1.0f);
  const int32_t baseHeight = std::max<int32_t>(1, canvas.fontHeight());
  canvas.setTextSize(static_cast<float>(region.style.fontSize) /
                     static_cast<float>(baseHeight));
  canvas.setTextDatum(clockDatum(region.style.textAlign,
                                 region.style.verticalAlign));
  const int32_t x = region.style.textAlign == ClockTextAlign::Center
                        ? region.bounds.width / 2
                        : region.style.textAlign == ClockTextAlign::Right
                              ? region.bounds.width
                              : 0;
  const int32_t y = region.style.verticalAlign == ClockVerticalAlign::Middle
                        ? region.bounds.height / 2
                        : region.style.verticalAlign == ClockVerticalAlign::Bottom
                              ? region.bounds.height
                              : 0;
  canvas.drawString(value.c_str(), x, y);

  // In M5GFX 0.2.24 Panel_EPD records the actual dirty rectangle written by
  // pushSprite. Keeping the outer transaction open coalesces the sprite into
  // one physical update and avoids the rotated display(x,y,w,h) bug in 0.2.24.
  M5.Display.waitDisplay();
  M5.Display.setEpdMode(cleanRefresh ? epd_text : epd_fast);
  M5.Display.startWrite();
  canvas.pushSprite(region.bounds.x, region.bounds.y);
  M5.Display.endWrite();
  M5.Display.waitDisplay();
  canvas.deleteSprite();
  M5.Display.setEpdMode(epd_quality);
  return true;
}

void PaperS3Display::restoreStaticMode() {
  M5.Display.waitDisplay();
  M5.Display.setEpdMode(epd_quality);
}

void PaperS3Display::showStatus(const std::string &title,
                                const std::string &detail) {
  M5.Display.setRotation(1);
  M5.Display.setEpdMode(epd_text);
  M5.Display.fillScreen(TFT_WHITE);
  M5.Display.setTextColor(TFT_BLACK, TFT_WHITE);
  M5.Display.setTextDatum(top_left);
  // The package title and diagnostics may contain CJK text.  Keep the
  // on-device chrome on M5GFX's bundled Unicode bitmap fonts instead of the
  // Latin-only DejaVu subset; package pages themselves are pre-rendered PNGs.
  M5.Display.setFont(&fonts::efontCN_24_b);
  M5.Display.drawString(title.c_str(), 36, 36);
  M5.Display.setFont(&fonts::efontCN_16);
  M5.Display.setTextWrap(true, true);
  M5.Display.setCursor(36, 100);
  M5.Display.println(detail.c_str());
  M5.Display.setEpdMode(epd_quality);
}

void PaperS3Display::showSettings(const DisplaySettings &settings,
                                  const std::string &packageTitle) {
  M5.Display.setEpdMode(epd_text);
  M5.Display.fillScreen(TFT_WHITE);
  M5.Display.setTextColor(TFT_BLACK, TFT_WHITE);
  M5.Display.setTextDatum(top_left);
  M5.Display.setFont(&fonts::efontCN_24_b);
  M5.Display.drawString("InkOS Settings", 36, 28);
  M5.Display.setFont(&fonts::efontCN_16);
  M5.Display.drawString(packageTitle.c_str(), 36, 76);

  const int32_t rowTop = 132;
  const int32_t rowHeight = 96;
  const char *labels[] = {"Font size", "Invert", "Offline only"};
  const std::string values[] = {
      (settings.fontLevel >= 0 ? "+" : "") +
          std::to_string(settings.fontLevel),
      settings.invert ? "On" : "Off",
      settings.offline ? "On" : "Off",
  };
  for (int index = 0; index < 3; ++index) {
    const int32_t y = rowTop + index * rowHeight;
    M5.Display.drawRoundRect(36, y, width() - 72, rowHeight - 14, 10,
                             TFT_BLACK);
    M5.Display.drawString(labels[index], 58, y + 24);
    M5.Display.setTextDatum(top_right);
    M5.Display.drawString(values[index].c_str(), width() - 58, y + 24);
    M5.Display.setTextDatum(top_left);
  }
  M5.Display.setFont(&fonts::efontCN_12);
  M5.Display.drawString("Tap a row to change · long press to close", 36,
                        height() - 42);
  M5.Display.setEpdMode(epd_quality);
}

int32_t PaperS3Display::width() const { return M5.Display.width(); }
int32_t PaperS3Display::height() const { return M5.Display.height(); }

InputEvent PaperS3Touch::poll(int32_t logicalWidth, int32_t logicalHeight) {
  M5.update();
  const auto touch = M5.Touch.getDetail();
  if (touch.wasPressed()) {
    pressed_ = true;
    startX_ = lastX_ = touch.x;
    startY_ = lastY_ = touch.y;
    startedAt_ = millis();
    return {};
  }
  if (pressed_ && touch.isPressed()) {
    lastX_ = touch.x;
    lastY_ = touch.y;
    return {};
  }
  if (!pressed_ || !touch.wasReleased()) {
    return {};
  }

  pressed_ = false;
  const int32_t deltaX = lastX_ - startX_;
  const int32_t deltaY = lastY_ - startY_;
  const int32_t absX = std::abs(deltaX);
  const int32_t absY = std::abs(deltaY);
  const int32_t shorterEdge = std::min(logicalWidth, logicalHeight);
  const int32_t swipeThreshold = std::max<int32_t>(48, shorterEdge * 8 / 100);
  const uint32_t duration = millis() - startedAt_;

  if (duration >= 700 && std::max(absX, absY) <= 16) {
    return {InputType::LongPress, startX_, startY_};
  }
  if (absX >= swipeThreshold && absX * 4 >= absY * 5) {
    // Right swipe is reserved and intentionally remains a no-op.
    return {deltaX < 0 ? InputType::SwipeLeft : InputType::None, lastX_,
            lastY_};
  }
  if (absY >= swipeThreshold && absY * 4 >= absX * 5) {
    return {deltaY < 0 ? InputType::SwipeUp : InputType::SwipeDown, lastX_,
            lastY_};
  }
  if (std::max(absX, absY) <= 16) {
    return {InputType::Tap, startX_, startY_};
  }
  return {};
}

} // namespace inkos::paper
