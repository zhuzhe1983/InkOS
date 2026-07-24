#include "display.h"

#include "clock_refresh_policy.h"
#include "fast_text_pixel_policy.h"
#include "jpeg_frame_policy.h"

#include <M5GFX.h>
#include <M5Unified.h>
#include <esp_log.h>
#include <esp_psram.h>
#include <esp_timer.h>
#include <lgfx/v1/platforms/esp32/Panel_EPD.hpp>

#include <algorithm>
#include <cmath>
#include <vector>

namespace inkos::idf {
namespace {

constexpr int32_t kUiBorderWidth = 3;
constexpr const char *kTag = "inkos_display";

struct ClockDirtyRect {
  int32_t x = 0;
  int32_t y = 0;
  int32_t width = 0;
  int32_t height = 0;
};

bool fail(std::string &error, const std::string &message) {
  error = message;
  return false;
}

lgfx::textdatum_t clockDatum(TextAlign horizontal, VerticalAlign vertical) {
  const uint8_t x = horizontal == TextAlign::Center
                        ? 1
                        : horizontal == TextAlign::Right ? 2 : 0;
  const uint8_t y = vertical == VerticalAlign::Middle
                        ? 4
                        : vertical == VerticalAlign::Bottom ? 8 : 0;
  return static_cast<lgfx::textdatum_t>(x + y);
}

void drawRoundBorder(int32_t x, int32_t y, int32_t width, int32_t height,
                     int32_t radius, uint32_t color,
                     int32_t thickness = kUiBorderWidth) {
  for (int32_t inset = 0; inset < thickness; ++inset) {
    const int32_t innerWidth = width - inset * 2;
    const int32_t innerHeight = height - inset * 2;
    if (innerWidth <= 0 || innerHeight <= 0) break;
    M5.Display.drawRoundRect(x + inset, y + inset, innerWidth, innerHeight,
                             std::max<int32_t>(1, radius - inset), color);
  }
}

void selectOrientation(Orientation orientation) {
  // Panel_M5PaperS3 has offset_rotation=3. Public rotation 0 is the profile's
  // 540x960 portrait coordinate space; rotation 1 is 960x540 landscape.
  M5.Display.setRotation(orientation == Orientation::Portrait ? 0 : 1);
}

void scrubPanelToWhite() {
  M5.Display.waitDisplay();
  M5.Display.setEpdMode(epd_quality);
  // M5GFX implements clearDisplay() specially for EPD: it first drives the
  // opposite polarity, waits, then drives the requested base colour. This is
  // intentionally reserved for orientation/overlay transitions and bounded
  // periodic maintenance because it visibly flashes twice.
  M5.Display.clearDisplay(TFT_WHITE);
  M5.Display.waitDisplay();
}

void clearPhotoGhostingToWhite() {
  // Match the validated slideshow sequence exactly. This is intentionally
  // separate from the generic quality clearDisplay() maintenance path.
  M5.Display.waitDisplay();
  M5.Display.setEpdMode(epd_text);
  M5.Display.startWrite();
  M5.Display.fillScreen(TFT_WHITE);
  M5.Display.endWrite();
  M5.Display.waitDisplay();
}

void reinforcePhotoEndpoints(int32_t width, int32_t height) {
  // Do not push the canvas again in epd_fast: doing so would Bayer-binarize
  // the driver's 4-bit target framebuffer. Replay its existing targets with
  // the fast LUT instead; levels 1..14 are no-op and only 0/15 are reinforced.
  M5.Display.waitDisplay();
  M5.Display.setEpdMode(epd_fast);
  auto *panel =
      static_cast<lgfx::Panel_EPD *>(M5.Display.getPanel());
  panel->displayEndpointReinforcement(0, 0, width, height);
  M5.Display.waitDisplay();
}

FrameSemanticClass classifyFrameSemantic(const std::string &contentType) {
  if (contentType == "detail" || contentType == "list" ||
      contentType == "reader") {
    return FrameSemanticClass::NonImageDocument;
  }
  if (contentType == "image") return FrameSemanticClass::Image;
  return FrameSemanticClass::Unknown;
}

const char *refreshName(FrameRefresh refresh) {
  switch (refresh) {
    case FrameRefresh::TextHighContrast:
      return "text-high-contrast";
    case FrameRefresh::Quality:
      return "quality";
    case FrameRefresh::PhotoThreePass:
      return "photo-three-pass";
    case FrameRefresh::ScrubThenTextHighContrast:
      return "scrub+text-high-contrast";
    case FrameRefresh::ScrubThenQuality:
      return "scrub+quality";
  }
  return "unknown";
}

const char *waveformName(FrameRefresh refresh, bool photoUsesTextBody) {
  if (refresh == FrameRefresh::PhotoThreePass) {
    return photoUsesTextBody
               ? "epd_text-clear>epd_text-solid-black>epd_fast-endpoints"
               : "epd_text-clear>epd_quality-16gray>epd_fast-endpoints";
  }
  return refreshUsesTextWaveform(refresh) ? "epd_text-16gray"
                                         : "epd_quality-16gray";
}

const char *refreshHintName(FrameRefreshHint hint) {
  switch (hint) {
    case FrameRefreshHint::LegacyUnspecified:
      return "legacy-unspecified";
    case FrameRefreshHint::BinaryText:
      return "binary-text";
    case FrameRefreshHint::QualityRequired:
      return "quality-required";
  }
  return "unknown";
}

const char *renderProfileName(FrameRenderProfile profile) {
  switch (profile) {
    case FrameRenderProfile::Generic:
      return "generic";
    case FrameRenderProfile::PaperS3PhotoGray16:
      return "papers3-photo-gray16";
  }
  return "unknown";
}

DecodedFastTextAnalysis analyzeFastTextCanvas(const M5Canvas &canvas,
                                              int32_t width, int32_t height) {
  const auto *pixels = static_cast<const uint8_t *>(canvas.getBuffer());
  const size_t bufferLength = canvas.bufferLength();
  const size_t stride =
      height > 0 ? bufferLength / static_cast<size_t>(height) : 0;
  return analyzeFastTextPixels(pixels, bufferLength, width, height, stride);
}

bool isNativeSolidBlackCanvas(const M5Canvas &canvas, int32_t width,
                              int32_t height) {
  const auto *pixels = static_cast<const uint8_t *>(canvas.getBuffer());
  const size_t bufferLength = canvas.bufferLength();
  const size_t stride =
      height > 0 ? bufferLength / static_cast<size_t>(height) : 0;
  return decodedPixelsAreNativeSolidBlack(pixels, bufferLength, width, height,
                                          stride);
}

void drawValueRow(int32_t top, int32_t left, int32_t width, int32_t height,
                  const char *label, const std::string &value,
                  bool disabled = false) {
  const uint32_t color = disabled ? 0xBDF7 : TFT_BLACK;
  drawRoundBorder(left, top, width, height, 11, color);
  M5.Display.setTextColor(color, TFT_WHITE);
  M5.Display.setTextDatum(middle_left);
  M5.Display.drawString(label, left + 22, top + height / 2);
  M5.Display.setTextDatum(middle_right);
  M5.Display.drawString(value.c_str(), left + width - 22, top + height / 2);
  M5.Display.setTextDatum(top_left);
}

bool utf8Continuation(unsigned char value) {
  return (value & 0xC0) == 0x80;
}

std::string nextDisplayGlyph(const std::string &text, size_t offset,
                             size_t &bytes) {
  const unsigned char lead = static_cast<unsigned char>(text[offset]);
  if (lead < 0x80) {
    bytes = 1;
    return text.substr(offset, bytes);
  }

  size_t expected = 0;
  if (lead >= 0xC2 && lead <= 0xDF) {
    expected = 2;
  } else if (lead >= 0xE0 && lead <= 0xEF) {
    expected = 3;
  } else if (lead >= 0xF0 && lead <= 0xF4) {
    expected = 4;
  }
  bool valid = expected != 0 && offset + expected <= text.size();
  for (size_t index = 1; valid && index < expected; ++index) {
    valid = utf8Continuation(static_cast<unsigned char>(text[offset + index]));
  }
  if (valid && expected == 3) {
    const unsigned char second = static_cast<unsigned char>(text[offset + 1]);
    valid = (lead != 0xE0 || second >= 0xA0) &&
            (lead != 0xED || second <= 0x9F);
  } else if (valid && expected == 4) {
    const unsigned char second = static_cast<unsigned char>(text[offset + 1]);
    valid = (lead != 0xF0 || second >= 0x90) &&
            (lead != 0xF4 || second <= 0x8F);
  }
  if (!valid) {
    // M5GFX keeps UTF-8 decoder state between calls. Never pass it a partial
    // sequence: one malformed input could otherwise corrupt every later row.
    bytes = 1;
    return "?";
  }
  bytes = expected;
  return text.substr(offset, bytes);
}

std::vector<std::string> wrapDisplayText(const std::string &text,
                                         int32_t maxWidth) {
  std::vector<std::string> lines;
  std::string line;
  size_t offset = 0;
  auto flush = [&]() {
    if (!line.empty()) {
      lines.push_back(line);
      line.clear();
    }
  };
  while (offset < text.size()) {
    if (text[offset] == '\n') {
      // Preserve intentional blank lines between status sections (for
      // example, the Wi-Fi SSID and management URL in portal mode).
      lines.push_back(line);
      line.clear();
      ++offset;
      continue;
    }
    size_t bytes = 0;
    const std::string glyph = nextDisplayGlyph(text, offset, bytes);
    const std::string candidate = line + glyph;
    if (!line.empty() && M5.Display.textWidth(candidate.c_str()) > maxWidth) {
      flush();
    }
    if (!(line.empty() && glyph == " ")) line += glyph;
    offset += bytes;
  }
  flush();
  return lines;
}

std::string fitCanvasLine(M5Canvas &canvas, const std::string &text,
                          int32_t maxWidth) {
  std::string line;
  bool truncated = false;
  size_t offset = 0;
  while (offset < text.size()) {
    size_t bytes = 0;
    std::string glyph;
    if (text[offset] == '\n' || text[offset] == '\r' || text[offset] == '\t') {
      glyph = " ";
      bytes = 1;
    } else {
      glyph = nextDisplayGlyph(text, offset, bytes);
    }
    if (glyph == " " && (line.empty() || line.back() == ' ')) {
      offset += bytes;
      continue;
    }
    if (canvas.textWidth((line + glyph).c_str()) > maxWidth) {
      truncated = true;
      break;
    }
    line += glyph;
    offset += bytes;
  }
  if (!truncated && offset == text.size()) return line;
  while (!line.empty() && canvas.textWidth((line + "…").c_str()) > maxWidth) {
    size_t glyphStart = line.size() - 1;
    while (glyphStart > 0 &&
           (static_cast<unsigned char>(line[glyphStart]) & 0xC0) == 0x80) {
      --glyphStart;
    }
    line.erase(glyphStart);
  }
  return line + "…";
}

bool clockInkBounds(const M5Canvas &canvas, int32_t width, int32_t height,
                    ClockDirtyRect &result) {
  const auto *pixels = static_cast<const uint8_t *>(canvas.getBuffer());
  if (!pixels || width <= 0 || height <= 0) return false;
  const size_t bufferLength = canvas.bufferLength();
  const size_t stride = bufferLength / static_cast<size_t>(height);
  if (stride < static_cast<size_t>(width)) return false;
  const uint8_t background = pixels[0];
  int32_t left = width;
  int32_t top = height;
  int32_t right = -1;
  int32_t bottom = -1;
  for (int32_t y = 0; y < height; ++y) {
    const uint8_t *row = pixels + static_cast<size_t>(y) * stride;
    for (int32_t x = 0; x < width; ++x) {
      if (row[x] == background) continue;
      left = std::min(left, x);
      right = std::max(right, x);
      top = std::min(top, y);
      bottom = std::max(bottom, y);
    }
  }
  if (right < left || bottom < top) return false;
  result = {left, top, right - left + 1, bottom - top + 1};
  return true;
}

bool binarizeClockCanvas(M5Canvas &canvas, int32_t width, int32_t height) {
  auto *pixels = static_cast<uint8_t *>(canvas.getBuffer());
  if (!pixels || width <= 0 || height <= 0) return false;
  const size_t bufferLength = canvas.bufferLength();
  const size_t stride = bufferLength / static_cast<size_t>(height);
  if (stride < static_cast<size_t>(width)) return false;
  for (int32_t y = 0; y < height; ++y) {
    uint8_t *row = pixels + static_cast<size_t>(y) * stride;
    for (int32_t x = 0; x < width; ++x) {
      row[x] = clockBinaryLevel(row[x]);
    }
  }
  return true;
}

ClockDirtyRect expandedClockRect(const ClockDirtyRect &rect,
                                 const ClockRegion &region,
                                 int32_t horizontalSafety,
                                 int32_t verticalSafety) {
  const int32_t left = std::max<int32_t>(0, rect.x - horizontalSafety);
  const int32_t top = std::max<int32_t>(0, rect.y - verticalSafety);
  const int32_t right = std::min<int32_t>(
      region.bounds.width, rect.x + rect.width + horizontalSafety);
  const int32_t bottom = std::min<int32_t>(
      region.bounds.height, rect.y + rect.height + verticalSafety);
  return {left, top, std::max<int32_t>(0, right - left),
          std::max<int32_t>(0, bottom - top)};
}

ClockDirtyRect unionClockRects(const std::vector<ClockDirtyRect> &rects) {
  int32_t left = INT32_MAX;
  int32_t top = INT32_MAX;
  int32_t right = 0;
  int32_t bottom = 0;
  for (const ClockDirtyRect &rect : rects) {
    left = std::min(left, rect.x);
    top = std::min(top, rect.y);
    right = std::max(right, rect.x + rect.width);
    bottom = std::max(bottom, rect.y + rect.height);
  }
  return {left, top, right - left, bottom - top};
}

} // namespace

bool PaperS3Display::begin(std::string &error) {
  auto config = M5.config();
  config.clear_display = false;
  config.internal_imu = true;
  M5.begin(config);
  if (M5.getBoard() != m5::board_t::board_M5PaperS3) {
    return fail(error, "M5Unified did not detect M5Stack PaperS3");
  }
  if (!esp_psram_is_initialized()) {
    return fail(error, "PaperS3 Octal PSRAM is not initialized");
  }
  selectOrientation(Orientation::Portrait);
  M5.Display.setColorDepth(lgfx::color_depth_t::grayscale_8bit);
  M5.Display.setEpdMode(epd_quality);
  M5.Touch.setFlickThresh(48);
  return true;
}

bool PaperS3Display::showFrame(const std::vector<uint8_t> &png,
                               const DisplayVariant &variant,
                               const std::string &contentType,
                               FrameRenderProfile renderProfile,
                               FrameRefreshHint refreshHint,
                               std::string &error) {
  const bool isPng =
      png.size() >= 24 && png[0] == 0x89 && png[1] == 'P' &&
      png[2] == 'N' && png[3] == 'G';
  const bool isJpeg = png.size() >= 14 && png[0] == 0xff && png[1] == 0xd8;
  if (!isPng && !isJpeg) {
    return fail(error, "Verified frame is neither PNG nor source JPEG");
  }
  if (variant.meta.invert) {
    return fail(error, "PaperS3 inverted display mode is no longer supported");
  }
  // Rotation changes the mapping between logical and physical panel pixels.
  // Never alter it while a previous EPD waveform is still active.
  M5.Display.waitDisplay();
  selectOrientation(variant.meta.orientation);
  if (M5.Display.width() != variant.width ||
      M5.Display.height() != variant.height) {
    return fail(error, "PaperS3 display geometry differs from the variant");
  }
  M5Canvas canvas(&M5.Display);
  canvas.setPsram(true);
  canvas.setColorDepth(lgfx::color_depth_t::grayscale_8bit);
  if (!canvas.createSprite(variant.width, variant.height)) {
    return fail(error, "Cannot allocate a full PaperS3 frame in PSRAM");
  }
  canvas.fillSprite(TFT_WHITE);
  bool decoded = false;
  if (isPng) {
    decoded = canvas.drawPng(png.data(), png.size(), 0, 0, variant.width,
                             variant.height);
  } else {
    JpegFrameInfo source;
    if (!inspectSourceJpeg(png, source, error)) {
      canvas.deleteSprite();
      return false;
    }
    const float scale = std::min(
        static_cast<float>(variant.width) / source.width,
        static_cast<float>(variant.height) / source.height);
    const int32_t drawnWidth = std::max<int32_t>(
        1, static_cast<int32_t>(std::lround(source.width * scale)));
    const int32_t drawnHeight = std::max<int32_t>(
        1, static_cast<int32_t>(std::lround(source.height * scale)));
    const int32_t x = (static_cast<int32_t>(variant.width) - drawnWidth) / 2;
    const int32_t y = (static_cast<int32_t>(variant.height) - drawnHeight) / 2;
    decoded = canvas.drawJpg(png.data(), png.size(), x, y, drawnWidth,
                             drawnHeight, 0, 0, scale, scale);
    ESP_LOGI(kTag,
             "source JPEG contain decode source=%ux%u target=%ux%u "
             "draw=%ldx%ld offset=%ld,%ld scale=%.4f",
             static_cast<unsigned>(source.width),
             static_cast<unsigned>(source.height),
             static_cast<unsigned>(variant.width),
             static_cast<unsigned>(variant.height),
             static_cast<long>(drawnWidth), static_cast<long>(drawnHeight),
             static_cast<long>(x), static_cast<long>(y),
             static_cast<double>(scale));
  }
  if (!decoded) {
    canvas.deleteSprite();
    return fail(error, isPng ? "M5GFX could not decode the verified PNG"
                             : "M5GFX could not decode the source JPEG");
  }
  const FrameSemanticClass semanticClass =
      classifyFrameSemantic(contentType);
  const bool nativeSolidBlack =
      semanticClass == FrameSemanticClass::Image &&
      isNativeSolidBlackCanvas(canvas, variant.width, variant.height);
  DecodedFastTextAnalysis pixelAnalysis;
  bool decodedPixelsAllowText = false;
  if (semanticClass == FrameSemanticClass::NonImageDocument &&
      refreshHint != FrameRefreshHint::QualityRequired) {
    pixelAnalysis =
        analyzeFastTextCanvas(canvas, variant.width, variant.height);
    decodedPixelsAllowText =
        pixelAnalysis.valid &&
        isFastTextPixelAnalysisSafe(
            pixelAnalysis.intermediatePixels,
            pixelAnalysis.interiorIntermediatePixels,
            pixelAnalysis.totalPixels);
    const uint32_t intermediatePermille =
        pixelAnalysis.totalPixels == 0
            ? 1000U
            : static_cast<uint32_t>(
                  static_cast<uint64_t>(pixelAnalysis.intermediatePixels) *
                  1000U / pixelAnalysis.totalPixels);
    const uint32_t interiorBasisPoints =
        pixelAnalysis.totalPixels == 0
            ? 10000U
            : static_cast<uint32_t>(
                  static_cast<uint64_t>(
                      pixelAnalysis.interiorIntermediatePixels) *
                  10000U / pixelAnalysis.totalPixels);
    ESP_LOGI(kTag,
             "EPD decoded heuristic content=%s hint=%s middle_permille=%u "
             "interior_basis_points=%u pixel_decision=%s",
             contentType.c_str(), refreshHintName(refreshHint),
             static_cast<unsigned>(intermediatePermille),
             static_cast<unsigned>(interiorBasisPoints),
             decodedPixelsAllowText ? "near-binary" : "quality-required");
  }
  FrameRefresh refresh =
      chooseFrameRefresh(refreshState_, variant.meta, semanticClass,
                         refreshHint, decodedPixelsAllowText);
  if (nativeSolidBlack) {
    ESP_LOGI(kTag,
             "EPD solid-black source canvas selected epd_text body "
             "pixels=%u max_gray=%u orientation=%s refresh=%s",
             static_cast<unsigned>(
                 static_cast<uint32_t>(variant.width) * variant.height),
             static_cast<unsigned>(kNativeSolidBlackMaxGray),
             orientationName(variant.meta.orientation),
             refreshName(refresh));
  }
  if (semanticClass == FrameSemanticClass::Unknown) {
    ESP_LOGW(kTag,
             "Unknown frame contentType='%s'; using conservative quality mode",
             contentType.c_str());
  }
  const int64_t refreshStartedUs = esp_timer_get_time();
  uint32_t clearMs = 0;
  uint32_t bodyMs = 0;
  uint32_t endpointsMs = 0;
  if (refresh == FrameRefresh::PhotoThreePass) {
    ESP_LOGI(kTag,
             "EPD photo phase=1/3 clear-white mode=epd_text "
             "orientation=%s",
             orientationName(variant.meta.orientation));
    int64_t phaseStartedUs = esp_timer_get_time();
    clearPhotoGhostingToWhite();
    clearMs = static_cast<uint32_t>(
        (esp_timer_get_time() - phaseStartedUs) / 1000);

    const char *bodyMode = nativeSolidBlack ? "epd_text" : "epd_quality";
    ESP_LOGI(kTag,
             "EPD photo phase=2/3 body-16gray mode=%s orientation=%s",
             bodyMode, orientationName(variant.meta.orientation));
    phaseStartedUs = esp_timer_get_time();
    M5.Display.setEpdMode(nativeSolidBlack ? epd_text : epd_quality);
    M5.Display.startWrite();
    canvas.pushSprite(0, 0);
    M5.Display.endWrite();
    M5.Display.waitDisplay();
    bodyMs = static_cast<uint32_t>(
        (esp_timer_get_time() - phaseStartedUs) / 1000);

    ESP_LOGI(kTag,
             "EPD photo phase=3/3 reinforce-endpoints mode=epd_fast "
             "orientation=%s",
             orientationName(variant.meta.orientation));
    phaseStartedUs = esp_timer_get_time();
    reinforcePhotoEndpoints(variant.width, variant.height);
    endpointsMs = static_cast<uint32_t>(
        (esp_timer_get_time() - phaseStartedUs) / 1000);
    M5.Display.setEpdMode(epd_quality);
  } else if (refreshPerformsScrub(refresh)) {
    ESP_LOGI(kTag,
             "EPD scrub before settled %s frame content=%s hint=%s",
             orientationName(variant.meta.orientation), contentType.c_str(),
             refreshHintName(refreshHint));
    scrubPanelToWhite();
    M5.Display.setEpdMode(refreshUsesTextWaveform(refresh) ? epd_text
                                                          : epd_quality);
    M5.Display.startWrite();
    canvas.pushSprite(0, 0);
    M5.Display.endWrite();
    M5.Display.waitDisplay();
  } else {
    ESP_LOGI(kTag,
             "EPD direct %s %s frame content=%s hint=%s (no pre-scrub)",
             refreshName(refresh), orientationName(variant.meta.orientation),
             contentType.c_str(), refreshHintName(refreshHint));
    M5.Display.setEpdMode(refreshUsesTextWaveform(refresh) ? epd_text
                                                          : epd_quality);
    M5.Display.startWrite();
    canvas.pushSprite(0, 0);
    M5.Display.endWrite();
    M5.Display.waitDisplay();
  }
  const uint32_t elapsedMs = static_cast<uint32_t>(
      (esp_timer_get_time() - refreshStartedUs) / 1000);
  const DisplayRefreshState nextRefreshState =
      stateAfterFrame(refreshState_, variant.meta, refresh, semanticClass,
                      decodedPixelsAllowText);
  ESP_LOGI(kTag,
           "EPD frame settled orientation=%s content=%s profile=%s hint=%s "
           "refresh=%s "
           "waveform=%s "
           "png_bytes=%u elapsed_ms=%u scrub_budget=%u/%u "
           "text_frames_since_scrub=%u photo_phases_ms=%u/%u/%u",
           orientationName(variant.meta.orientation),
           contentType.c_str(), renderProfileName(renderProfile),
           refreshHintName(refreshHint),
           refreshName(refresh),
           waveformName(refresh, nativeSolidBlack),
           static_cast<unsigned>(png.size()), static_cast<unsigned>(elapsedMs),
           static_cast<unsigned>(nextRefreshState.framesSinceScrub),
           static_cast<unsigned>(kMaxFramesBetweenScrubs),
           static_cast<unsigned>(nextRefreshState.textFramesSinceScrub),
           static_cast<unsigned>(clearMs), static_cast<unsigned>(bodyMs),
           static_cast<unsigned>(endpointsMs));
  canvas.deleteSprite();
  refreshState_ = nextRefreshState;
  return true;
}

bool PaperS3Display::showClock(const ClockRegion &region,
                               const std::string &previousValue,
                               const std::string &value, std::string &error) {
  if (!validClockText(value) ||
      (!previousValue.empty() && !validClockText(previousValue)) ||
      region.bounds.width <= 0 ||
      region.bounds.height <= 0) {
    return fail(error, "Invalid local clock draw request");
  }
  const ClockGlyphChanges changes =
      changedClockGlyphs(previousValue, value);
  if (!changes.fullText && changes.count == 0) return true;
  M5Canvas canvas(&M5.Display);
  canvas.setPsram(true);
  canvas.setColorDepth(lgfx::color_depth_t::grayscale_8bit);
  if (!canvas.createSprite(region.bounds.width, region.bounds.height)) {
    return fail(error, "Cannot allocate the local clock sprite");
  }
  const uint32_t foreground = region.style.foregroundWhite ? TFT_WHITE
                                                            : TFT_BLACK;
  const uint32_t background = region.style.backgroundWhite ? TFT_WHITE
                                                            : TFT_BLACK;
  canvas.fillSprite(background);
  canvas.setTextColor(foreground, background);
  canvas.setTextWrap(false, false);
  // Draw close to a native 72-pixel face. Enlarging the old 24-point bitmap
  // about 2x made the clock visibly stair-stepped on PaperS3's dense panel.
  canvas.setFont(&fonts::DejaVu72);
  const int32_t baseHeight = std::max<int32_t>(1, canvas.fontHeight());
  float scale = static_cast<float>(region.style.fontSize) /
                static_cast<float>(baseHeight);
  canvas.setTextSize(scale);
  const int32_t measuredWidth = std::max<int32_t>(1, canvas.textWidth(value.c_str()));
  const int32_t measuredHeight = std::max<int32_t>(1, canvas.fontHeight());
  // GFX metrics do not include every glyph overhang. A physical inset keeps
  // the widest possible value (88:88:88) clear of all sprite edges.
  const int32_t horizontalInset =
      std::max<int32_t>(16, region.bounds.width / 24);
  const int32_t verticalInset =
      std::max<int32_t>(14, region.bounds.height / 9);
  const float widthLimit =
      std::max<int32_t>(1, region.bounds.width - horizontalInset * 2) /
                           static_cast<float>(measuredWidth);
  const float heightLimit =
      std::max<int32_t>(1, region.bounds.height - verticalInset * 2) /
                            static_cast<float>(measuredHeight);
  scale *= std::min(1.0F, std::min(widthLimit, heightLimit));
  canvas.setTextSize(scale);
  const int32_t drawnWidth =
      std::max<int32_t>(1, canvas.textWidth(value.c_str()));
  canvas.setTextDatum(clockDatum(region.style.textAlign,
                                 region.style.verticalAlign));
  const int32_t x = region.style.textAlign == TextAlign::Center
                        ? region.bounds.width / 2
                        : region.style.textAlign == TextAlign::Right
                              ? region.bounds.width - horizontalInset
                              : horizontalInset;
  const int32_t y = region.style.verticalAlign == VerticalAlign::Middle
                        ? region.bounds.height / 2
                        : region.style.verticalAlign == VerticalAlign::Bottom
                              ? region.bounds.height - verticalInset
                              : verticalInset;
  canvas.drawString(value.c_str(), x, y);
  // Fast PaperS3 waveforms only have black/white targets. Quantize the
  // antialiased font once with a stable threshold before it reaches M5GFX;
  // otherwise Panel_EPD applies a Bayer threshold to every grey edge sample
  // and creates the photographed mesh around the glyphs.
  if (!binarizeClockCanvas(canvas, region.bounds.width,
                           region.bounds.height)) {
    canvas.deleteSprite();
    return fail(error, "Local clock has an invalid grayscale sprite");
  }
  ClockDirtyRect inkBounds;
  if (!clockInkBounds(canvas, region.bounds.width, region.bounds.height,
                      inkBounds)) {
    canvas.deleteSprite();
    return fail(error, "Local clock produced no drawable glyphs");
  }
  // Scan the rendered sprite once to use the actual glyph height instead of
  // the much taller semantic title box. The horizontal boxes below are then
  // split per changed character. Panel_EPD still receives a rectangular range,
  // but its fast path compares the packed target levels (not the LUT identity),
  // so unchanged white gaps between glyphs are not physically driven.
  const int32_t horizontalSafety = std::max<int32_t>(4, drawnWidth / 96);
  const int32_t verticalSafety =
      std::max<int32_t>(4, inkBounds.height / 18);
  inkBounds = expandedClockRect(inkBounds, region, horizontalSafety,
                                verticalSafety);
  const int32_t textLeft = region.style.textAlign == TextAlign::Center
                               ? (region.bounds.width - drawnWidth) / 2
                               : region.style.textAlign == TextAlign::Right
                                     ? region.bounds.width - horizontalInset -
                                           drawnWidth
                                     : horizontalInset;
  std::vector<ClockDirtyRect> dirtyRects;
  if (changes.fullText) {
    // Register the complete reserved clock region in fast mode once. This
    // reliably removes a placeholder from older/custom .ink packages and
    // gives every future glyph cell the same mode identity. Subsequent ticks
    // update only changed character cells and therefore never pulse a backing
    // rectangle. The built-in package now leaves this region blank.
    dirtyRects.push_back(
        {0, 0, region.bounds.width, region.bounds.height});
  } else {
    dirtyRects.reserve(changes.count);
    for (uint8_t changed = 0; changed < changes.count; ++changed) {
      const size_t index = changes.indices[changed];
      const std::string prefix = value.substr(0, index);
      const std::string throughGlyph = value.substr(0, index + 1);
      const int32_t glyphLeft = textLeft + canvas.textWidth(prefix.c_str());
      const int32_t glyphRight =
          textLeft + canvas.textWidth(throughGlyph.c_str());
      ClockDirtyRect glyphRect{
          glyphLeft, inkBounds.y,
          std::max<int32_t>(1, glyphRight - glyphLeft), inkBounds.height};
      dirtyRects.push_back(expandedClockRect(
          glyphRect, region, horizontalSafety, 0));
    }
  }

  M5.Display.waitDisplay();
  // The quality LUT has 32 panel scans and intentionally moves changed pixels
  // through an eraser grey before settling. At a one-second cadence another
  // update starts almost immediately, leaving the clock visibly grey/flashing
  // for most of its lifetime. The fast LUT has no eraser phase. Because the
  // sprite above is already strict black/white and the first paint registers
  // the whole reserved region in this mode, later writes drive only pixels
  // belonging to changed glyphs.
  M5.Display.setEpdMode(epd_fast);
  const ClockDirtyRect commitRect = unionClockRects(dirtyRects);
  // Panel_EPD's automatic endWrite path calls display(0, 0, 0, 0). Its
  // cross-core PSRAM cache write-back currently uses those zero arguments,
  // not _range_mod, so the EPD task can observe stale sprite pixels. Disable
  // auto-display for this transaction and submit the exact logical dirty
  // bounds explicitly; display() then flushes a non-zero physical row range.
  M5.Display.setAutoDisplay(false);
  M5.Display.startWrite();
  for (const ClockDirtyRect &rect : dirtyRects) {
    M5.Display.setClipRect(region.bounds.x + rect.x,
                           region.bounds.y + rect.y, rect.width, rect.height);
    canvas.pushSprite(region.bounds.x, region.bounds.y);
  }
  M5.Display.clearClipRect();
  M5.Display.endWrite();
  M5.Display.display(region.bounds.x + commitRect.x,
                     region.bounds.y + commitRect.y, commitRect.width,
                     commitRect.height);
  M5.Display.waitDisplay();
  M5.Display.setAutoDisplay(true);
  canvas.deleteSprite();
  return true;
}

void PaperS3Display::showStatus(const std::string &title,
                                const std::string &detail) {
  M5.Display.waitDisplay();
  M5.Display.setEpdMode(epd_text);
  M5.Display.startWrite();
  M5.Display.fillScreen(TFT_WHITE);
  M5.Display.setTextColor(TFT_BLACK, TFT_WHITE);
  const int32_t screenWidth = M5.Display.width();
  const int32_t screenHeight = M5.Display.height();
  const bool landscape = screenWidth > screenHeight;
  const int32_t cardWidth =
      std::min<int32_t>(screenWidth - 56, landscape ? 720 : 484);
  const int32_t innerWidth = cardWidth - 64;

  M5.Display.setFont(&fonts::efontCN_24);
  M5.Display.setTextSize(1.0f);
  std::vector<std::string> detailLines = wrapDisplayText(detail, innerWidth);
  const size_t maxLines = landscape ? 4 : 7;
  if (detailLines.size() > maxLines) {
    detailLines.resize(maxLines);
    std::string &last = detailLines.back();
    while (!last.empty() &&
           M5.Display.textWidth((last + "…").c_str()) > innerWidth) {
      size_t glyphStart = last.size() - 1;
      while (glyphStart > 0 &&
             (static_cast<unsigned char>(last[glyphStart]) & 0xC0) == 0x80) {
        --glyphStart;
      }
      last.erase(glyphStart);
    }
    last += "…";
  }
  if (detailLines.empty()) detailLines.emplace_back();

  const int32_t lineHeight = 38;
  const int32_t cardHeight = std::min<int32_t>(
      screenHeight - 64,
      152 + static_cast<int32_t>(detailLines.size()) * lineHeight);
  const int32_t cardLeft = (screenWidth - cardWidth) / 2;
  const int32_t cardTop = (screenHeight - cardHeight) / 2;
  drawRoundBorder(cardLeft, cardTop, cardWidth, cardHeight, 16, TFT_BLACK);

  // A compact static progress mark gives slow Chromium pages an unmistakable
  // loading state without pretending that an e-paper screen can animate.
  constexpr int32_t markerWidth = 54;
  M5.Display.fillRect((screenWidth - markerWidth) / 2, cardTop + 32,
                      markerWidth, 5, TFT_BLACK);
  M5.Display.setTextDatum(top_center);
  M5.Display.setFont(&fonts::efontCN_24_b);
  M5.Display.setTextSize(1.25f);
  M5.Display.drawString(title.c_str(), screenWidth / 2, cardTop + 55);
  M5.Display.drawFastHLine(cardLeft + 32, cardTop + 108, innerWidth,
                           TFT_BLACK);

  M5.Display.setFont(&fonts::efontCN_24);
  M5.Display.setTextSize(1.0f);
  int32_t lineTop = cardTop + 126;
  for (const std::string &line : detailLines) {
    M5.Display.drawString(line.c_str(), screenWidth / 2, lineTop);
    lineTop += lineHeight;
  }
  M5.Display.setTextWrap(false, false);
  M5.Display.setTextDatum(top_left);
  M5.Display.setTextSize(1.0f);
  M5.Display.endWrite();
  M5.Display.waitDisplay();
  M5.Display.setEpdMode(epd_quality);
  refreshState_ = stateAfterFullScreenUi(refreshState_);
}

void PaperS3Display::showLoading(const std::string &detail) {
  M5.Display.waitDisplay();
  const int32_t screenWidth = M5.Display.width();
  const int32_t screenHeight = M5.Display.height();
  const bool landscape = screenWidth > screenHeight;
  const int32_t left = landscape ? 24 : 16;
  const int32_t bottom = landscape ? 18 : 22;
  const int32_t stripWidth = screenWidth - left * 2;
  // One specific progress sentence is enough on e-paper. Keep the strip just
  // tall enough for a high-DPI 24 px glyph plus a strong edge, rather than
  // covering the bottom 104/120 px with a generic title and a second line.
  const int32_t stripHeight = landscape ? 56 : 64;
  const int32_t top = screenHeight - bottom - stripHeight;

  M5Canvas canvas(&M5.Display);
  canvas.setPsram(true);
  canvas.setColorDepth(lgfx::color_depth_t::grayscale_8bit);
  if (!canvas.createSprite(stripWidth, stripHeight)) {
    showStatus("请稍候", detail);
    return;
  }
  canvas.fillSprite(TFT_WHITE);
  canvas.fillRect(0, 0, stripWidth, 4, TFT_BLACK);
  canvas.fillRect(0, 12, 6, stripHeight - 24, TFT_BLACK);
  canvas.setTextColor(TFT_BLACK, TFT_WHITE);
  canvas.setTextWrap(false, false);
  canvas.setTextDatum(middle_left);
  canvas.setFont(&fonts::efontCN_24_b);
  canvas.setTextSize(1.0f);
  canvas.drawString(fitCanvasLine(canvas, detail, stripWidth - 42).c_str(),
                    24, stripHeight / 2 + 2);

  // Loading is one compact bottom-strip update, not a modal full-screen
  // repaint. It contains only the concrete current operation; there is no
  // separate generic "正在载入" row. Do not classify this as full-screen UI:
  // doing so made every navigation run clearDisplay(TFT_WHITE) immediately
  // before the requested frame. If the following update was delayed or lost,
  // the panel was visibly stranded at that white scrub stage. The next
  // following frame begins with waitDisplay(), then its selected fast/quality
  // write erases and settles every changed pixel in this strip. First boot,
  // rotation, settings/status screens and bounded maintenance still scrub.
  M5.Display.setEpdMode(epd_fast);
  M5.Display.startWrite();
  canvas.pushSprite(left, top);
  M5.Display.endWrite();
  canvas.deleteSprite();
  // The queued update_data_t retains epd_fast. Restore the default immediately
  // without blocking; every subsequent display entry point waits before draw.
  M5.Display.setEpdMode(epd_quality);
  refreshState_ = stateAfterPartialOverlay(refreshState_);
}

void PaperS3Display::showSettings(const DeviceSettings &draft,
                                  const std::string &packageTitle,
                                  const std::string &managementAddress) {
  M5.Display.waitDisplay();
  M5.Display.setEpdMode(epd_text);
  M5.Display.startWrite();
  M5.Display.fillScreen(TFT_WHITE);
  M5.Display.setTextColor(TFT_BLACK, TFT_WHITE);
  M5.Display.setTextDatum(top_left);
  M5.Display.setFont(&fonts::efontCN_24_b);
  M5.Display.setTextSize(1.25f);
  M5.Display.drawString("InkOS 设置", 24, 20);
  M5.Display.setFont(&fonts::efontCN_24);
  M5.Display.setTextSize(1.0f);
  M5.Display.drawString(packageTitle.c_str(), 24, 66);

  const int32_t left = 24;
  const int32_t width = M5.Display.width() - left * 2;
  const int32_t bottomButtons = 72;
  const int32_t rowAreaTop = 96;
  const int32_t available =
      M5.Display.height() - rowAreaTop - bottomButtons - 18;
  const int32_t gap = 8;
  const int32_t rowHeight = std::min<int32_t>(
      132, (available - gap * 3) / 4);
  const int32_t rowTop = rowAreaTop +
      (available - rowHeight * 4 - gap * 3) / 2;
  M5.Display.setFont(&fonts::efontCN_24_b);
  M5.Display.setTextSize(1.0f);
  const std::string mode = draft.orientationMode == OrientationMode::Automatic
                               ? "自动"
                               : "手动";
  const std::string direction =
      draft.manualOrientation == Orientation::Portrait ? "竖屏" : "横屏";
  const std::string font =
      (draft.fontLevel >= 0 ? "+" : "") + std::to_string(draft.fontLevel);
  const std::string network = managementAddress.empty()
                                  ? "开启配置热点"
                                  : managementAddress;
  drawValueRow(rowTop, left, width, rowHeight, "旋转", mode);
  drawValueRow(rowTop + (rowHeight + gap), left, width, rowHeight, "方向",
               direction,
               draft.orientationMode == OrientationMode::Automatic);
  drawValueRow(rowTop + (rowHeight + gap) * 2, left, width, rowHeight, "字号",
               font);
  drawValueRow(rowTop + (rowHeight + gap) * 3, left, width, rowHeight,
               "管理后台", network);

  const int32_t buttonTop = M5.Display.height() - bottomButtons + 8;
  const int32_t buttonWidth = (width - gap) / 2;
  drawRoundBorder(left, buttonTop, buttonWidth, 56, 10, TFT_BLACK);
  drawRoundBorder(left + buttonWidth + gap, buttonTop, buttonWidth, 56, 10,
                  TFT_BLACK);
  M5.Display.setTextDatum(middle_center);
  M5.Display.drawString("取消", left + buttonWidth / 2, buttonTop + 28);
  M5.Display.drawString("应用", left + buttonWidth + gap + buttonWidth / 2,
                        buttonTop + 28);
  M5.Display.setTextDatum(top_left);
  M5.Display.setTextSize(1.0f);
  M5.Display.endWrite();
  M5.Display.waitDisplay();
  M5.Display.setEpdMode(epd_quality);
  refreshState_ = stateAfterFullScreenUi(refreshState_);
}

void PaperS3Display::showPortal(const std::string &ssid,
                                const std::string &address,
                                const std::string &detail) {
  showStatus("配置网络", "手机连接热点：\n" + ssid + "\n\n打开：\nhttp://" +
                             address + "/\n\n" + detail);
}

InputEvent PaperS3Display::pollInput() {
  M5.update();
  const auto touch = M5.Touch.getDetail();
  const int64_t now = esp_timer_get_time();
  if (inputSuppressed_) {
    pressed_ = false;
    settingsHoldSent_ = false;
    settingsHoldEligible_ = false;
    if (touch.isPressed()) return {};
    inputSuppressed_ = false;
    inputCooldownUntilUs_ = now + 250'000;
    return {};
  }
  if (now < inputCooldownUntilUs_) return {};
  if (touch.wasPressed()) {
    pressed_ = true;
    settingsHoldSent_ = false;
    settingsHoldEligible_ = touch.y < height() / 5;
    startX_ = lastX_ = touch.x;
    startY_ = lastY_ = touch.y;
    pressedAtUs_ = now;
    return {};
  }
  if (pressed_ && touch.isPressed()) {
    lastX_ = touch.x;
    lastY_ = touch.y;
    const int32_t dx = lastX_ - startX_;
    const int32_t dy = lastY_ - startY_;
    if (std::abs(dx) > 12 || std::abs(dy) > 12 || lastY_ >= height() / 5) {
      settingsHoldEligible_ = false;
    }
    if (!settingsHoldSent_ && settingsHoldEligible_ &&
        now - pressedAtUs_ >= 5'000'000) {
      settingsHoldSent_ = true;
      return {InputKind::SettingsHold, startX_, startY_};
    }
    return {};
  }
  if (!pressed_ || !touch.wasReleased()) return {};
  pressed_ = false;
  if (settingsHoldSent_) return {};
  const int32_t dx = lastX_ - startX_;
  const int32_t dy = lastY_ - startY_;
  const int32_t absX = std::abs(dx);
  const int32_t absY = std::abs(dy);
  const int64_t gestureUs = now - pressedAtUs_;
  const int32_t threshold =
      std::max<int32_t>(56, std::min(width(), height()) * 10 / 100);
  constexpr int64_t kMinimumSwipeUs = 60'000;
  constexpr int64_t kMaximumSwipeUs = 2'000'000;
  const bool swipeDuration = gestureUs >= kMinimumSwipeUs &&
                             gestureUs <= kMaximumSwipeUs;
  if (swipeDuration && absX >= threshold && absX * 100 >= absY * 140) {
    return {dx < 0 ? InputKind::SwipeLeft : InputKind::SwipeRight, lastX_,
            lastY_};
  }
  if (swipeDuration && absY >= threshold && absY * 100 >= absX * 140) {
    return {dy < 0 ? InputKind::SwipeUp : InputKind::SwipeDown, lastX_,
            lastY_};
  }
  if (gestureUs <= 750'000 && absX <= 16 && absY <= 16) {
    return {InputKind::Tap, startX_, startY_};
  }
  return {};
}

void PaperS3Display::suppressInputUntilRelease() {
  // Navigation and EPD writes are synchronous on app_main. Discard any touch
  // that starts while that task is blocked, then require a quiet release and a
  // short debounce before accepting the next gesture.
  inputSuppressed_ = true;
  pressed_ = false;
  settingsHoldSent_ = false;
  settingsHoldEligible_ = false;
}

bool PaperS3Display::suggestedOrientation(Orientation &orientation) {
  const int64_t now = esp_timer_get_time();
  if (now - lastImuPollUs_ < 400'000) return false;
  lastImuPollUs_ = now;
  float x = 0;
  float y = 0;
  float z = 0;
  if (!M5.Imu.isEnabled() || !M5.Imu.getAccel(&x, &y, &z)) return false;
  (void)z;
  if (std::fabs(std::fabs(x) - std::fabs(y)) < 0.18f) {
    orientationSamples_ = 0;
    return false;
  }
  const Orientation candidate = std::fabs(x) > std::fabs(y)
                                    ? Orientation::Landscape
                                    : Orientation::Portrait;
  if (candidate != lastSuggested_) {
    lastSuggested_ = candidate;
    orientationSamples_ = 1;
    return false;
  }
  if (orientationSamples_ < 3) ++orientationSamples_;
  if (orientationSamples_ != 3) return false;
  orientationSamples_ = 4;
  orientation = candidate;
  return true;
}

int32_t PaperS3Display::width() const { return M5.Display.width(); }
int32_t PaperS3Display::height() const { return M5.Display.height(); }

void PaperS3Display::restoreQualityMode() {
  M5.Display.waitDisplay();
  M5.Display.setEpdMode(epd_quality);
}

} // namespace inkos::idf
