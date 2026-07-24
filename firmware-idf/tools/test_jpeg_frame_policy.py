#!/usr/bin/env python3
"""Compile and execute the firmware source-JPEG validator on the host."""

from __future__ import annotations

import pathlib
import shutil
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class JpegFramePolicyHostTest(unittest.TestCase):
    def test_baseline_geometry_and_decoder_subset_are_strict(self) -> None:
        compiler = shutil.which("c++") or shutil.which("g++") or shutil.which("clang++")
        self.assertIsNotNone(compiler, "a host C++ compiler is required")
        with tempfile.TemporaryDirectory() as temporary:
            executable = pathlib.Path(temporary) / "jpeg-frame-policy-test"
            subprocess.run(
                [
                    str(compiler),
                    "-std=c++17",
                    "-Wall",
                    "-Wextra",
                    "-Werror",
                    f"-I{ROOT / 'main' / 'include'}",
                    str(ROOT / "main" / "jpeg_frame_policy.cpp"),
                    str(ROOT / "tools" / "jpeg_frame_policy_test.cpp"),
                    "-o",
                    str(executable),
                ],
                check=True,
            )
            subprocess.run([str(executable)], check=True)

    def test_runtime_prefers_source_but_keeps_png_fallback(self) -> None:
        runtime = (ROOT / "main" / "runtime.cpp").read_text()
        loader = runtime.split("bool InkRuntime::loadPackaged", 1)[1].split(
            "bool InkRuntime::activateEmbeddedHome", 1
        )[0]
        self.assertIn("page->sourceImage.present ? page->sourceImage.path : page->imagePath", loader)
        self.assertIn("validateSourceJpeg", loader)
        self.assertIn("PngFramePolicy::PackageGray4", loader)

        display = (ROOT / "main" / "display.cpp").read_text()
        self.assertIn("canvas.drawJpg", display)
        self.assertIn("source JPEG contain decode", display)
        self.assertIn("canvas.fillSprite(TFT_WHITE)", display)


if __name__ == "__main__":
    unittest.main()
