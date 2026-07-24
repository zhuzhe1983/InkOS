#!/usr/bin/env python3
"""Compile and execute the firmware's source-of-truth PNG policy on the host."""

from __future__ import annotations

import pathlib
import shutil
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class PngFramePolicyHostTest(unittest.TestCase):
    def test_package_stays_gray4_while_apps_accept_rgb_rgba(self) -> None:
        compiler = shutil.which("c++") or shutil.which("g++") or shutil.which("clang++")
        self.assertIsNotNone(compiler, "a host C++ compiler is required")
        with tempfile.TemporaryDirectory() as temporary:
            executable = pathlib.Path(temporary) / "png-frame-policy-test"
            subprocess.run(
                [
                    str(compiler),
                    "-std=c++17",
                    "-Wall",
                    "-Wextra",
                    "-Werror",
                    f"-I{ROOT / 'main' / 'include'}",
                    str(ROOT / "main" / "png_frame_policy.cpp"),
                    str(ROOT / "tools" / "png_frame_policy_test.cpp"),
                    "-o",
                    str(executable),
                ],
                check=True,
            )
            subprocess.run([str(executable)], check=True)

    def test_runtime_call_sites_pin_true_colour_to_apps_execute(self) -> None:
        runtime = (ROOT / "main" / "runtime.cpp").read_text()
        app = runtime.split("bool InkRuntime::renderApp", 1)[1].split(
            "bool InkRuntime::fetchManifest", 1
        )[0]
        self.assertIn("PngFramePolicy::AppDiagnosticTrueColour", app)
        self.assertEqual(runtime.count("PngFramePolicy::AppDiagnosticTrueColour"), 1)

        for begin, end in (
            ("bool InkRuntime::loadPackaged", "bool InkRuntime::activateEmbeddedHome"),
            ("bool InkRuntime::renderCollection", "bool InkRuntime::renderApp"),
            ("bool InkRuntime::renderOnline", "bool InkRuntime::loadOnline"),
            ("bool InkRuntime::loadOnline", "bool InkRuntime::activate"),
        ):
            section = runtime.split(begin, 1)[1].split(end, 1)[0]
            self.assertIn("PngFramePolicy::PackageGray4", section)
            self.assertNotIn("PngFramePolicy::AppDiagnosticTrueColour", section)

        storage = (ROOT / "main" / "device_storage.cpp").read_text()
        verifier = storage.split("bool validPng(", 1)[1].split(
            "bool verifyHomeArchive", 1
        )[0]
        self.assertIn("PngFramePolicy::PackageGray4", verifier)
        self.assertNotIn("PngFramePolicy::AppDiagnosticTrueColour", verifier)

    def test_checked_in_m5gfx_decoder_supports_rgb_and_rgba_png(self) -> None:
        decoder = (
            ROOT
            / "managed_components"
            / "m5stack__m5gfx"
            / "src"
            / "lgfx"
            / "utility"
            / "lgfx_pngle.c"
        ).read_text()
        self.assertIn("case 2: // true color", decoder)
        self.assertIn("case 6: // truecolor with alpha", decoder)


if __name__ == "__main__":
    unittest.main()
