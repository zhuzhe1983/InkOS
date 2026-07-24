#pragma once

#include "ink_types.h"

#include <cstdint>

namespace inkos::idf {

// The semantic class is only a veto, never proof that a frame is binary text.
// detail/list/reader pages may still contain photos. A decoded-pixel validator
// must independently approve them before the text waveform can be selected.
enum class FrameSemanticClass : uint8_t {
  NonImageDocument,
  Image,
  Unknown
};

enum class FrameRefresh : uint8_t {
  TextHighContrast,
  Quality,
  PhotoThreePass,
  ScrubThenTextHighContrast,
  ScrubThenQuality
};

struct DisplayRefreshState {
  bool hasFrame = false;
  bool fullScreenUiVisible = false;
  Orientation orientation = Orientation::Portrait;
  uint8_t framesSinceScrub = 0;
  uint8_t textFramesSinceScrub = 0;
  FrameSemanticClass lastSemanticClass = FrameSemanticClass::Unknown;
  bool lastFrameUsedTextWaveform = false;
};

// Full-screen text uses epd_text, not binary epd_fast. It retains 16 target
// levels and includes an eraser stage, so it does not need the old four-frame
// fast-waveform budget. Every twelfth stable frame still receives a full white
// scrub followed by the content-appropriate settled waveform.
inline constexpr uint8_t kMaxFramesBetweenScrubs = 12;

// The high-contrast text LUT still retains 16 levels, but it is intended for
// predominantly black/white pages. The decoded canvas is allowed at most 4%
// intermediate pixels (anti-aliased edges), and at most 0.25% of all pixels
// may be intermediate pixels that are not immediately adjacent to a dark/light
// target. That second bound rejects small photos and solid grey cards.
inline constexpr uint8_t kMaxFastIntermediatePercent = 4;
inline constexpr uint16_t kMaxFastInteriorIntermediateBasisPoints = 25;

constexpr bool isFastTextPixelAnalysisSafe(
    uint32_t intermediatePixels, uint32_t interiorIntermediatePixels,
    uint32_t totalPixels) {
  if (totalPixels == 0 || interiorIntermediatePixels > intermediatePixels) {
    return false;
  }
  return static_cast<uint64_t>(intermediatePixels) * 100U <=
             static_cast<uint64_t>(totalPixels) *
                 kMaxFastIntermediatePercent &&
         static_cast<uint64_t>(interiorIntermediatePixels) * 10000U <=
             static_cast<uint64_t>(totalPixels) *
                 kMaxFastInteriorIntermediateBasisPoints;
}

constexpr FrameRefresh chooseFrameRefresh(
    const DisplayRefreshState &state, const DisplayMeta &next,
    FrameSemanticClass semanticClass, FrameRefreshHint refreshHint,
    bool decodedPixelsAllowText) {
  // Every semantic image uses the slideshow-proven sequence:
  // epd_text white clear, epd_quality 16-gray body (epd_text for pure black),
  // then an explicit epd_fast endpoint replay. The render profile controls
  // server-side pixel preparation only; it must not weaken panel refresh.
  if (semanticClass == FrameSemanticClass::Image) {
    return FrameRefresh::PhotoThreePass;
  }
  const bool wantsTextWaveform =
      semanticClass == FrameSemanticClass::NonImageDocument &&
       refreshHint != FrameRefreshHint::QualityRequired &&
       decodedPixelsAllowText;
  if (!state.hasFrame || state.orientation != next.orientation ||
      state.fullScreenUiVisible ||
      state.framesSinceScrub >= kMaxFramesBetweenScrubs) {
    return wantsTextWaveform ? FrameRefresh::ScrubThenTextHighContrast
                             : FrameRefresh::ScrubThenQuality;
  }

  // Switching waveform families starts from a known white state. Otherwise
  // the first photo after a text page can inherit charge, while the first text
  // page after a photo can retain lifted blacks.
  if (wantsTextWaveform != state.lastFrameUsedTextWaveform) {
    return wantsTextWaveform ? FrameRefresh::ScrubThenTextHighContrast
                             : FrameRefresh::ScrubThenQuality;
  }

  // A normal grayscale image entered from another non-image quality page also
  // receives one known white starting state. Image-to-image paging stays
  // direct so only the transition pays for the visible preconditioning cycle.
  if (semanticClass == FrameSemanticClass::Image &&
      state.lastSemanticClass != FrameSemanticClass::Image) {
    return FrameRefresh::ScrubThenQuality;
  }

  return wantsTextWaveform ? FrameRefresh::TextHighContrast
                           : FrameRefresh::Quality;
}

constexpr bool refreshUsesTextWaveform(FrameRefresh refresh) {
  return refresh == FrameRefresh::TextHighContrast ||
         refresh == FrameRefresh::ScrubThenTextHighContrast;
}

constexpr bool refreshPerformsScrub(FrameRefresh refresh) {
  return refresh == FrameRefresh::PhotoThreePass ||
         refresh == FrameRefresh::ScrubThenTextHighContrast ||
         refresh == FrameRefresh::ScrubThenQuality;
}

constexpr DisplayRefreshState stateAfterFrame(
    DisplayRefreshState state, const DisplayMeta &shown,
    FrameRefresh refresh, FrameSemanticClass semanticClass,
    bool decodedPixelsAllowedText) {
  state.hasFrame = true;
  state.fullScreenUiVisible = false;
  state.orientation = shown.orientation;
  state.lastSemanticClass = semanticClass;
  state.lastFrameUsedTextWaveform = refreshUsesTextWaveform(refresh);
  if (refreshPerformsScrub(refresh)) {
    state.framesSinceScrub = 0;
    state.textFramesSinceScrub =
        state.lastFrameUsedTextWaveform ? 1 : 0;
    return state;
  }
  if (state.framesSinceScrub < UINT8_MAX) ++state.framesSinceScrub;
  if (state.lastFrameUsedTextWaveform && decodedPixelsAllowedText) {
    if (state.textFramesSinceScrub < UINT8_MAX) {
      ++state.textFramesSinceScrub;
    }
  } else {
    state.textFramesSinceScrub = 0;
  }
  return state;
}

constexpr DisplayRefreshState stateAfterFullScreenUi(
    DisplayRefreshState state) {
  state.fullScreenUiVisible = true;
  return state;
}

// The compact loading strip is already in Panel_EPD's target framebuffer.
// It does not invalidate the stable full-screen semantic frame.
constexpr DisplayRefreshState stateAfterPartialOverlay(
    DisplayRefreshState state) {
  return state;
}

// These checks also compile in the ESP-IDF target build.
static_assert(isFastTextPixelAnalysisSafe(4, 0, 100));
static_assert(!isFastTextPixelAnalysisSafe(5, 0, 100));
static_assert(isFastTextPixelAnalysisSafe(400, 25, 10000));
static_assert(!isFastTextPixelAnalysisSafe(400, 26, 10000));
static_assert(!isFastTextPixelAnalysisSafe(0, 0, 0));
static_assert(chooseFrameRefresh(
                  {}, {}, FrameSemanticClass::NonImageDocument,
                  FrameRefreshHint::BinaryText, true) ==
              FrameRefresh::ScrubThenTextHighContrast);
static_assert(chooseFrameRefresh(
                  {true, false, Orientation::Portrait, 0, 1,
                   FrameSemanticClass::NonImageDocument, true},
                  {Orientation::Portrait, 0, false},
                  FrameSemanticClass::NonImageDocument,
                  FrameRefreshHint::BinaryText, true) ==
              FrameRefresh::TextHighContrast);
static_assert(chooseFrameRefresh(
                  {true, false, Orientation::Portrait, 0, 1,
                   FrameSemanticClass::NonImageDocument, true},
                  {Orientation::Portrait, 0, false},
                  FrameSemanticClass::NonImageDocument,
                  FrameRefreshHint::LegacyUnspecified, true) ==
              FrameRefresh::TextHighContrast);
static_assert(chooseFrameRefresh(
                  {true, false, Orientation::Portrait, 0, 1,
                   FrameSemanticClass::NonImageDocument, true},
                  {Orientation::Portrait, 0, false},
                  FrameSemanticClass::NonImageDocument,
                  FrameRefreshHint::QualityRequired, true) ==
              FrameRefresh::ScrubThenQuality);
static_assert(chooseFrameRefresh(
                  {true, false, Orientation::Portrait, 0, 0,
                   FrameSemanticClass::Image, false},
                  {Orientation::Portrait, 0, false},
                  FrameSemanticClass::NonImageDocument,
                  FrameRefreshHint::BinaryText, true) ==
              FrameRefresh::ScrubThenTextHighContrast);
static_assert(chooseFrameRefresh(
                  {true, false, Orientation::Portrait, 0, 1,
                   FrameSemanticClass::NonImageDocument, true},
                  {Orientation::Portrait, 0, false},
                  FrameSemanticClass::Image,
                  FrameRefreshHint::BinaryText, true) ==
              FrameRefresh::PhotoThreePass);
static_assert(chooseFrameRefresh(
                  {true, false, Orientation::Portrait, 1, 0,
                   FrameSemanticClass::Image, false},
                  {Orientation::Portrait, 0, false},
                  FrameSemanticClass::Image,
                  FrameRefreshHint::QualityRequired, false) ==
              FrameRefresh::PhotoThreePass);
static_assert(chooseFrameRefresh(
                  {true, false, Orientation::Portrait, 0, 0,
                   FrameSemanticClass::NonImageDocument, false},
                  {Orientation::Portrait, 0, false},
                  FrameSemanticClass::NonImageDocument,
                  FrameRefreshHint::BinaryText, false) ==
              FrameRefresh::Quality);
static_assert(chooseFrameRefresh(
                  {true, false, Orientation::Portrait, 0, 0,
                   FrameSemanticClass::Image, false},
                  {Orientation::Portrait, 0, false},
                  FrameSemanticClass::Image,
                  FrameRefreshHint::QualityRequired, false) ==
              FrameRefresh::PhotoThreePass);
static_assert(chooseFrameRefresh(
                  {true, false, Orientation::Portrait,
                   kMaxFramesBetweenScrubs, 1,
                   FrameSemanticClass::NonImageDocument, true},
                  {Orientation::Portrait, 0, false},
                  FrameSemanticClass::NonImageDocument,
                  FrameRefreshHint::BinaryText, true) ==
              FrameRefresh::ScrubThenTextHighContrast);
static_assert(chooseFrameRefresh(
                  stateAfterPartialOverlay(
                      {true, false, Orientation::Portrait, 0, 1,
                       FrameSemanticClass::NonImageDocument, true}),
                  {Orientation::Portrait, 0, false},
                  FrameSemanticClass::NonImageDocument,
                  FrameRefreshHint::BinaryText, true) ==
              FrameRefresh::TextHighContrast);
static_assert(refreshUsesTextWaveform(FrameRefresh::TextHighContrast));
static_assert(
    refreshUsesTextWaveform(FrameRefresh::ScrubThenTextHighContrast));
static_assert(!refreshUsesTextWaveform(FrameRefresh::Quality));
static_assert(!refreshUsesTextWaveform(FrameRefresh::PhotoThreePass));
static_assert(
    refreshPerformsScrub(FrameRefresh::ScrubThenTextHighContrast));
static_assert(refreshPerformsScrub(FrameRefresh::ScrubThenQuality));
static_assert(refreshPerformsScrub(FrameRefresh::PhotoThreePass));
static_assert(!refreshPerformsScrub(FrameRefresh::TextHighContrast));

} // namespace inkos::idf
