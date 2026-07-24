#!/usr/bin/env python3
"""Host and static checks for privacy-safe PaperS3 navigation telemetry."""

from __future__ import annotations

import pathlib
import shutil
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class NavigationObservabilityTest(unittest.TestCase):
    def test_failure_and_target_classification_is_bounded(self) -> None:
        compiler = shutil.which("c++") or shutil.which("g++") or shutil.which("clang++")
        self.assertIsNotNone(compiler, "a host C++ compiler is required")
        with tempfile.TemporaryDirectory() as temporary:
            executable = pathlib.Path(temporary) / "navigation-observability-test"
            subprocess.run(
                [
                    str(compiler),
                    "-std=c++17",
                    "-Wall",
                    "-Wextra",
                    "-Werror",
                    f"-I{ROOT / 'main' / 'include'}",
                    str(ROOT / "main" / "navigation_observability.cpp"),
                    str(ROOT / "tools" / "navigation_observability_test.cpp"),
                    "-o",
                    str(executable),
                ],
                check=True,
            )
            subprocess.run([str(executable)], check=True)

    def test_rss_navigation_chain_has_correlatable_redacted_events(self) -> None:
        runtime = (ROOT / "main" / "runtime.cpp").read_text()
        navigate = runtime.split("bool InkRuntime::navigateTo", 1)[1].split(
            "bool InkRuntime::resolveSource", 1
        )[0]
        source = runtime.split("bool InkRuntime::resolveSource", 1)[1].split(
            "void InkRuntime::handleInput", 1
        )[0]
        inputs = runtime.split("void InkRuntime::handleInput", 1)[1].split(
            "void InkRuntime::openSettings", 1
        )[0]

        for event in ("NAV_INPUT", "NAV_TARGET", "NAV_START", "NAV_RETRY",
                      "NAV_FALLBACK", "NAV_OK", "NAV_RETAIN", "SOURCE_JOB"):
            self.assertIn(event, runtime)

        for cause in ("collection-open", "source-open", "package-link",
                      "page-next", "page-previous", "history-back",
                      "parent-back", "last-page-back",
                      "last-page-parent-back", "fallback-source"):
            self.assertIn(f'"{cause}"', inputs)

        self.assertIn("returnToPreviousLevel", inputs)
        self.assertIn(
            'returnToPreviousLevel("last-page-back", "last-page-parent-back")',
            inputs,
        )
        self.assertIn("NAV_BOUNDARY action=stay reason=no-previous-level", inputs)

        self.assertIn('"collection-rss"', navigate)
        self.assertIn('"online-reuse"', navigate)
        self.assertIn("content=%s", navigate)
        self.assertIn("page=%u/%u", navigate)
        self.assertIn("parent=%d", navigate)
        self.assertIn("id=%u", navigate)
        self.assertIn("code=%s", navigate)

        self.assertIn("source_ref=%s", source)
        self.assertIn("safeSourceJobStatus(status)", source)
        self.assertIn("safeTelemetryCode(", source)
        self.assertIn("phase=poll status=%s", source)
        self.assertIn("phase=resolve status=ready", source)
        self.assertIn("phase=resolve status=cached", source)

        # Full URLs, labels and remotely supplied free text must never be
        # interpolated into navigation events. Stable 12-hex references provide
        # correlation without exposing credentials, query strings or hosts.
        self.assertIn("const std::string targetReference = telemetryReference(", inputs)
        self.assertIn("interaction->targetUrl", inputs)
        self.assertIn("telemetryReference(interaction->fallbackUrl)", inputs)
        self.assertNotIn("targetUrl=%s", inputs)
        self.assertNotIn("fallback=%s", inputs)
        self.assertNotIn("url=%s", inputs)
        self.assertNotIn("label=%s", inputs)
        self.assertNotIn("packageReason=%s", inputs)
        self.assertNotIn("reason=%s", navigate)
        self.assertNotIn("error.c_str()", navigate)


if __name__ == "__main__":
    unittest.main()
