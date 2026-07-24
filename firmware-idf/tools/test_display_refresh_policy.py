#!/usr/bin/env python3
"""Compile and execute the PaperS3 frame refresh policy on the host."""

from __future__ import annotations

import pathlib
import shutil
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class DisplayRefreshPolicyHostTest(unittest.TestCase):
    def test_semantic_refresh_policy(self) -> None:
        compiler = shutil.which("c++") or shutil.which("g++") or shutil.which("clang++")
        self.assertIsNotNone(compiler, "a host C++ compiler is required")
        with tempfile.TemporaryDirectory() as temporary:
            executable = pathlib.Path(temporary) / "display-refresh-policy-test"
            subprocess.run(
                [
                    str(compiler),
                    "-std=c++17",
                    "-Wall",
                    "-Wextra",
                    "-Werror",
                    f"-I{ROOT / 'main' / 'include'}",
                    str(ROOT / "main" / "fast_text_pixel_policy.cpp"),
                    str(ROOT / "tools" / "display_refresh_policy_test.cpp"),
                    "-o",
                    str(executable),
                ],
                check=True,
            )
            subprocess.run([str(executable)], check=True)

    def test_runtime_propagates_content_type_profile_and_refresh_permission(self) -> None:
        runtime = (ROOT / "main" / "runtime.cpp").read_text()
        display = (ROOT / "main" / "display.cpp").read_text()
        policy = (ROOT / "main" / "include" / "display_refresh_policy.h").read_text()

        self.assertGreaterEqual(runtime.count("result.contentType ="), 5)
        self.assertIn(
            "transaction.png, *variant, transaction.contentType", runtime
        )
        self.assertGreaterEqual(runtime.count("active_.contentType"), 5)
        self.assertIn(
            "transaction.contentType,\n                          "
            "transaction.renderProfile, transaction.refreshHint",
            runtime,
        )
        self.assertGreaterEqual(runtime.count("active_.renderProfile"), 5)
        self.assertGreaterEqual(runtime.count("active_.refreshHint"), 5)
        self.assertGreaterEqual(runtime.count("result.renderProfile ="), 5)
        self.assertIn(
            "page->sourceImage.present ? "
            "FrameRenderProfile::PaperS3PhotoGray16",
            runtime,
        )

        # Static .ink/pre-rendered package frames predate refreshHint and keep
        # the local pixel heuristic. All three runtime-rendered frame routes
        # fail closed unless the manifest explicitly says binary-text.
        self.assertEqual(
            runtime.count(
                "result.refreshHint = FrameRefreshHint::LegacyUnspecified"
            ),
            2,
        )
        self.assertEqual(
            runtime.count(
                "result.refreshHint = "
                "dynamicFrameRefreshHint(frame.refreshHint)"
            ),
            3,
        )
        for start, end in (
            ("bool InkRuntime::renderCollection", "bool InkRuntime::renderApp"),
            ("bool InkRuntime::renderApp", "bool InkRuntime::fetchManifest"),
            ("bool InkRuntime::renderOnline", "bool InkRuntime::loadOnline"),
        ):
            route = runtime.split(start, 1)[1].split(end, 1)[0]
            self.assertIn("parseOnDemandFrame(", route)
            self.assertIn("refreshHintHeaderMatches(response, frame, error)", route)
            self.assertIn(
                "result.refreshHint = dynamicFrameRefreshHint(frame.refreshHint)",
                route,
            )

        frame = display.split("bool PaperS3Display::showFrame", 1)[1].split(
            "bool PaperS3Display::showClock", 1
        )[0]
        self.assertIn("FrameRenderProfile renderProfile", frame)
        self.assertIn("chooseFrameRefresh(", frame)
        self.assertIn("refreshUsesTextWaveform(", frame)
        self.assertIn("refreshPerformsScrub(", frame)
        self.assertIn("FrameRefresh::PhotoThreePass", frame)
        self.assertIn("clearPhotoGhostingToWhite()", frame)
        self.assertIn("reinforcePhotoEndpoints(", frame)
        self.assertIn("M5.Display.setEpdMode(epd_fast)", display)
        self.assertIn("M5.Display.setEpdMode(epd_text)", display)
        self.assertIn("nativeSolidBlack ? epd_text : epd_quality", frame)
        self.assertIn(
            "semanticClass == FrameSemanticClass::Image &&",
            frame,
        )
        self.assertIn(
            "if (semanticClass == FrameSemanticClass::Image)",
            policy,
        )
        self.assertNotIn(
            "decodedPixelsAllowText, isJpeg",
            frame,
        )
        self.assertIn("M5.Display.setEpdMode(epd_quality)", frame)
        self.assertIn("photo phase=1/3 clear-white", frame)
        self.assertIn("photo phase=2/3 body-16gray", frame)
        self.assertIn("photo phase=3/3 reinforce-endpoints", frame)
        self.assertIn("isFastTextPixelAnalysisSafe(", frame)
        self.assertIn("interiorIntermediatePixels", frame)
        self.assertIn("middle_permille=", frame)
        self.assertIn("Unknown frame contentType=", frame)
        self.assertIn(
            "refreshHint != FrameRefreshHint::QualityRequired", frame
        )
        self.assertIn("refreshHintName(refreshHint)", frame)
        self.assertNotIn(
            "variant.meta.orientation == Orientation::Portrait", frame
        )


if __name__ == "__main__":
    unittest.main()
