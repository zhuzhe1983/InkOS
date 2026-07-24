#include "display_refresh_policy.h"
#include "fast_text_pixel_policy.h"

#include <algorithm>
#include <cassert>
#include <cstdint>
#include <vector>

using inkos::idf::DisplayMeta;
using inkos::idf::DisplayRefreshState;
using inkos::idf::FrameRefresh;
using inkos::idf::FrameRefreshHint;
using inkos::idf::FrameRenderProfile;
using inkos::idf::FrameSemanticClass;
using inkos::idf::Orientation;
using inkos::idf::chooseFrameRefresh;
using inkos::idf::analyzeFastTextPixels;
using inkos::idf::decodedPixelsAreNativeSolidBlack;
using inkos::idf::isFastTextPixelAnalysisSafe;
using inkos::idf::kNativeSolidBlackMaxGray;
using inkos::idf::kMaxFramesBetweenScrubs;
using inkos::idf::stateAfterFrame;
using inkos::idf::stateAfterFullScreenUi;
using inkos::idf::stateAfterPartialOverlay;

int main() {
  const DisplayMeta portrait{Orientation::Portrait, 0, false};
  const DisplayMeta landscape{Orientation::Landscape, 0, false};

  assert(isFastTextPixelAnalysisSafe(4, 0, 100));
  assert(!isFastTextPixelAnalysisSafe(5, 0, 100));
  assert(isFastTextPixelAnalysisSafe(400, 25, 10000));
  assert(!isFastTextPixelAnalysisSafe(400, 26, 10000));
  assert(!isFastTextPixelAnalysisSafe(0, 0, 0));

  constexpr int32_t width = 100;
  constexpr int32_t height = 100;
  std::vector<uint8_t> pixels(width * height, 248);
  auto analysis =
      analyzeFastTextPixels(pixels.data(), pixels.size(), width, height, width);
  assert(analysis.valid);
  assert(analysis.intermediatePixels == 0);
  assert(isFastTextPixelAnalysisSafe(
      analysis.intermediatePixels, analysis.interiorIntermediatePixels,
      analysis.totalPixels));

  // A one-pixel anti-aliased divider has only edge-connected grey and is safe.
  for (int32_t x = 0; x < width; ++x) pixels[50 * width + x] = 128;
  analysis =
      analyzeFastTextPixels(pixels.data(), pixels.size(), width, height, width);
  assert(analysis.intermediatePixels == static_cast<uint32_t>(width));
  assert(analysis.interiorIntermediatePixels == 0);
  assert(isFastTextPixelAnalysisSafe(
      analysis.intermediatePixels, analysis.interiorIntermediatePixels,
      analysis.totalPixels));

  // A small 15x15 photo-like grey patch is only 2.25% globally, but its
  // interior proves that it is not merely an anti-aliased text edge.
  std::fill(pixels.begin(), pixels.end(), 248);
  for (int32_t y = 20; y < 35; ++y) {
    for (int32_t x = 20; x < 35; ++x) pixels[y * width + x] = 128;
  }
  analysis =
      analyzeFastTextPixels(pixels.data(), pixels.size(), width, height, width);
  assert(analysis.intermediatePixels == 225);
  assert(analysis.interiorIntermediatePixels == 169);
  assert(!isFastTextPixelAnalysisSafe(
      analysis.intermediatePixels, analysis.interiorIntermediatePixels,
      analysis.totalPixels));

  analysis = analyzeFastTextPixels(pixels.data(), pixels.size() - 1, width,
                                   height, width);
  assert(!analysis.valid);

  // Only values guaranteed to quantize to native level 0 may bypass the
  // normal sprite submission path. Padding bytes are not visible pixels.
  constexpr int32_t blackWidth = 4;
  constexpr int32_t blackHeight = 3;
  constexpr size_t blackStride = 6;
  std::vector<uint8_t> blackPixels(blackStride * blackHeight, 255);
  for (int32_t y = 0; y < blackHeight; ++y) {
    std::fill_n(blackPixels.begin() + y * blackStride, blackWidth,
                kNativeSolidBlackMaxGray);
  }
  assert(decodedPixelsAreNativeSolidBlack(
      blackPixels.data(), blackPixels.size(), blackWidth, blackHeight,
      blackStride));
  blackPixels[blackStride + 2] = kNativeSolidBlackMaxGray + 1;
  assert(!decodedPixelsAreNativeSolidBlack(
      blackPixels.data(), blackPixels.size(), blackWidth, blackHeight,
      blackStride));
  blackPixels[blackStride + 2] = 0;
  assert(decodedPixelsAreNativeSolidBlack(
      blackPixels.data(), blackPixels.size(), blackWidth, blackHeight,
      blackStride));
  assert(!decodedPixelsAreNativeSolidBlack(
      nullptr, blackPixels.size(), blackWidth, blackHeight, blackStride));
  assert(!decodedPixelsAreNativeSolidBlack(
      blackPixels.data(), blackPixels.size() - 1, blackWidth, blackHeight,
      blackStride));
  assert(!decodedPixelsAreNativeSolidBlack(
      blackPixels.data(), blackPixels.size(), blackWidth, blackHeight,
      blackWidth - 1));

  // The first decoded near-binary page scrubs, then settles with epd_text.
  assert(chooseFrameRefresh({}, portrait,
                            FrameSemanticClass::NonImageDocument,
                            FrameRefreshHint::BinaryText, true) ==
         FrameRefresh::ScrubThenTextHighContrast);
  DisplayRefreshState stable =
      stateAfterFrame({}, portrait,
                      FrameRefresh::ScrubThenTextHighContrast,
                      FrameSemanticClass::NonImageDocument, true);
  assert(stable.hasFrame);
  assert(stable.framesSinceScrub == 0);
  assert(stable.textFramesSinceScrub == 1);
  assert(stable.lastFrameUsedTextWaveform);

  // Semantics only veto. A non-image document still needs pixel approval.
  assert(chooseFrameRefresh(stable, portrait,
                            FrameSemanticClass::NonImageDocument,
                            FrameRefreshHint::BinaryText, true) ==
         FrameRefresh::TextHighContrast);
  assert(refreshUsesTextWaveform(FrameRefresh::TextHighContrast));
  assert(refreshUsesTextWaveform(
      FrameRefresh::ScrubThenTextHighContrast));
  assert(!refreshUsesTextWaveform(FrameRefresh::Quality));
  assert(chooseFrameRefresh(stable, portrait,
                            FrameSemanticClass::NonImageDocument,
                            FrameRefreshHint::LegacyUnspecified, true) ==
         FrameRefresh::TextHighContrast);
  assert(chooseFrameRefresh(stable, portrait,
                            FrameSemanticClass::NonImageDocument,
                            FrameRefreshHint::QualityRequired, true) ==
         FrameRefresh::ScrubThenQuality);
  assert(chooseFrameRefresh(stable, portrait,
                            FrameSemanticClass::NonImageDocument,
                            FrameRefreshHint::BinaryText, false) ==
         FrameRefresh::ScrubThenQuality);
  assert(chooseFrameRefresh(stable, portrait, FrameSemanticClass::Image,
                            FrameRefreshHint::BinaryText, true) ==
         FrameRefresh::PhotoThreePass);
  const DisplayRefreshState settledImage =
      stateAfterFrame(stable, portrait, FrameRefresh::PhotoThreePass,
                      FrameSemanticClass::Image, false);
  assert(chooseFrameRefresh(settledImage, portrait,
                            FrameSemanticClass::Image,
                            FrameRefreshHint::QualityRequired, false) ==
         FrameRefresh::PhotoThreePass);
  assert(chooseFrameRefresh(stable, portrait, FrameSemanticClass::Unknown,
                            FrameRefreshHint::BinaryText, true) ==
         FrameRefresh::ScrubThenQuality);
  const DisplayRefreshState greyDocument =
      stateAfterFrame(stable, portrait, FrameRefresh::Quality,
                      FrameSemanticClass::NonImageDocument, false);
  assert(chooseFrameRefresh(greyDocument, portrait,
                            FrameSemanticClass::NonImageDocument,
                            FrameRefreshHint::BinaryText, true) ==
         FrameRefresh::ScrubThenTextHighContrast);

  // Image -> text and text -> image both scrub before changing waveform.
  const DisplayRefreshState image =
      stateAfterFrame(stable, portrait, FrameRefresh::Quality,
                      FrameSemanticClass::Image, false);
  assert(chooseFrameRefresh(image, portrait,
                            FrameSemanticClass::NonImageDocument,
                            FrameRefreshHint::BinaryText, true) ==
         FrameRefresh::ScrubThenTextHighContrast);
  DisplayRefreshState textBaseline =
      stateAfterFrame(image, portrait,
                      FrameRefresh::ScrubThenTextHighContrast,
                      FrameSemanticClass::NonImageDocument, true);
  assert(chooseFrameRefresh(textBaseline, portrait,
                            FrameSemanticClass::NonImageDocument,
                            FrameRefreshHint::BinaryText, true) ==
         FrameRefresh::TextHighContrast);

  // epd_text contains its own eraser stage, so consecutive text pages do not
  // need the old epd_fast four-frame quality budget.
  for (uint8_t index = 0; index < 5; ++index) {
    const FrameRefresh refresh =
        chooseFrameRefresh(textBaseline, portrait,
                           FrameSemanticClass::NonImageDocument,
                           FrameRefreshHint::BinaryText, true);
    assert(refresh == FrameRefresh::TextHighContrast);
    textBaseline =
        stateAfterFrame(textBaseline, portrait, refresh,
                        FrameSemanticClass::NonImageDocument, true);
  }
  assert(textBaseline.textFramesSinceScrub == 6);
  assert(chooseFrameRefresh(textBaseline, portrait,
                            FrameSemanticClass::NonImageDocument,
                            FrameRefreshHint::BinaryText, true) ==
         FrameRefresh::TextHighContrast);

  // Loading is bounded and keeps the underlying differential baseline.
  assert(chooseFrameRefresh(stateAfterPartialOverlay(textBaseline), portrait,
                            FrameSemanticClass::NonImageDocument,
                            FrameRefreshHint::BinaryText, true) ==
         FrameRefresh::TextHighContrast);

  // Rotation and true full-screen UI invalidate it.
  assert(chooseFrameRefresh(textBaseline, landscape,
                            FrameSemanticClass::NonImageDocument,
                            FrameRefreshHint::BinaryText, true) ==
         FrameRefresh::ScrubThenTextHighContrast);
  assert(chooseFrameRefresh(stateAfterFullScreenUi(textBaseline), portrait,
                            FrameSemanticClass::NonImageDocument,
                            FrameRefreshHint::BinaryText, true) ==
         FrameRefresh::ScrubThenTextHighContrast);

  // Every semantic image uses the explicit slideshow three-pass sequence.
  // The profile may change server-side pixels, but it never weakens the
  // device-side clear/body/endpoint refresh.
  assert(chooseFrameRefresh({}, portrait, FrameSemanticClass::Image,
                            FrameRefreshHint::QualityRequired, false) ==
         FrameRefresh::PhotoThreePass);
  const DisplayRefreshState sourceImage =
      stateAfterFrame({}, portrait,
                      FrameRefresh::PhotoThreePass,
                      FrameSemanticClass::Image, false);
  assert(sourceImage.framesSinceScrub == 0);
  assert(!sourceImage.lastFrameUsedTextWaveform);
  assert(chooseFrameRefresh(sourceImage, portrait,
                            FrameSemanticClass::Image,
                            FrameRefreshHint::QualityRequired, false) ==
         FrameRefresh::PhotoThreePass);
  assert(chooseFrameRefresh(sourceImage, portrait,
                            FrameSemanticClass::Image,
                            FrameRefreshHint::BinaryText, true) ==
         FrameRefresh::PhotoThreePass);
  assert(chooseFrameRefresh(sourceImage, portrait,
                            FrameSemanticClass::NonImageDocument,
                            FrameRefreshHint::QualityRequired, false) ==
         FrameRefresh::Quality);

  // The independent long maintenance budget eventually forces a scrub.
  while (textBaseline.framesSinceScrub < kMaxFramesBetweenScrubs) {
    textBaseline =
        stateAfterFrame(textBaseline, portrait,
                        FrameRefresh::TextHighContrast,
                        FrameSemanticClass::NonImageDocument, true);
  }
  assert(chooseFrameRefresh(textBaseline, portrait,
                            FrameSemanticClass::NonImageDocument,
                            FrameRefreshHint::BinaryText, true) ==
         FrameRefresh::ScrubThenTextHighContrast);
  return 0;
}
