#!/usr/bin/env python3
"""Host protocol, transcript, and production-gate tests for the RSS harness."""

from __future__ import annotations

import importlib.util
import os
import pathlib
import pty
import select
import shutil
import subprocess
import tempfile
import textwrap
import threading
import time
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
RUNNER_PATH = ROOT / "tools" / "papers3_rss_serial_harness.py"
SPEC = importlib.util.spec_from_file_location("papers3_rss_serial_harness", RUNNER_PATH)
assert SPEC and SPEC.loader
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


class RssSerialHarnessTest(unittest.TestCase):
    def test_command_parser_is_exact_and_challenge_bound(self) -> None:
        compiler = shutil.which("c++") or shutil.which("clang++")
        self.assertIsNotNone(compiler, "a host C++ compiler is required")
        source = textwrap.dedent(
            r"""
            #include "rss_serial_harness_protocol.h"
            #include <cassert>
            #include <string>
            using namespace inkos::idf;
            int main() {
              std::string run;
              assert(parseRssHarnessCommand(
                  "INKOS_TEST/1 RSS_NAV 0123abcd 0011223344556677",
                  "0123abcd", run) == RssHarnessCommandResult::Ok);
              assert(run == "0011223344556677");
              assert(parseRssHarnessCommand(
                  "INKOS_TEST/1 RSS_NAV ffffffff 0011223344556677",
                  "0123abcd", run) ==
                  RssHarnessCommandResult::ChallengeMismatch);
              assert(parseRssHarnessCommand(
                  "INKOS_TEST/1 RSS_NAV 0123abcd 001122334455667",
                  "0123abcd", run) ==
                  RssHarnessCommandResult::InvalidFormat);
              assert(parseRssHarnessCommand(
                  "INKOS_TEST/1 RSS_NAV 0123ABCD 0011223344556677",
                  "0123abcd", run) ==
                  RssHarnessCommandResult::InvalidFormat);
              assert(parseRssHarnessCommand(
                  "INKOS_TEST/1  RSS_NAV 0123abcd 0011223344556677",
                  "0123abcd", run) ==
                  RssHarnessCommandResult::InvalidFormat);
              assert(parseRssHarnessCommand(
                  "INKOS_TEST/1 RSS_NAV 0123abcd 0011223344556677 extra",
                  "0123abcd", run) ==
                  RssHarnessCommandResult::InvalidFormat);
            }
            """
        )
        with tempfile.TemporaryDirectory() as temporary:
            executable = pathlib.Path(temporary) / "rss-harness-protocol-test"
            subprocess.run(
                [
                    str(compiler),
                    "-x",
                    "c++",
                    "-std=c++17",
                    "-Wall",
                    "-Wextra",
                    "-Werror",
                    f"-I{ROOT / 'main' / 'include'}",
                    "-",
                    "-o",
                    str(executable),
                ],
                input=source,
                text=True,
                check=True,
            )
            subprocess.run([str(executable)], check=True)

    def test_clean_correlated_transcript_is_accepted(self) -> None:
        run_id = "0011223344556677"
        lines = [f"I RSS_HARNESS_START run={run_id} scenario=rss-nav-v1"]
        for index, cause in enumerate(RUNNER.EXPECTED_CAUSES):
            lines.append(f"I NAV_INPUT kind=synthetic index={index}")
            if index < 3:
                lines.append("I NAV_TARGET kind=test hit=1")
            lines.append(f"I NAV_START id={index + 1} cause={cause} route=test")
            if cause == "source-open":
                lines.append("I SOURCE_JOB id=1 phase=resolve status=ready")
            lines.append("I EPD frame settled orientation=portrait")
            lines.append(f"I NAV_OK id={index + 1} cause={cause} route=test")
        lines.extend(
            [
                "I EPD frame settled orientation=portrait",
                "I EPD frame settled orientation=portrait",
                (
                    f"I RSS_HARNESS_RESULT run={run_id} status=PASS failure=none "
                    "restored=1 home_unchanged=1 settings_unchanged=1 "
                    "collections_unchanged=1"
                ),
            ]
        )
        result = RUNNER.validate_harness_transcript(lines, run_id)
        self.assertEqual(result["causes"], list(RUNNER.EXPECTED_CAUSES))
        self.assertEqual(result["epdSettledCount"], 8)

    def test_posix_serial_transport_sends_the_challenge_bound_command(self) -> None:
        master, slave = pty.openpty()
        slave_path = os.ttyname(slave)
        os.close(slave)
        device_error: list[BaseException] = []

        def emulate_device() -> None:
            try:
                time.sleep(0.05)
                os.write(
                    master,
                    b"W RSS_HARNESS_READY protocol=1 challenge=0123abcd "
                    b"one_shot=1 transport=usb-serial-jtag\n",
                )
                command = bytearray()
                deadline = time.monotonic() + 2.0
                while b"\n" not in command and time.monotonic() < deadline:
                    readable, _, _ = select.select([master], [], [], 0.1)
                    if readable:
                        command.extend(os.read(master, 256))
                match = (
                    b"INKOS_TEST/1 RSS_NAV 0123abcd "
                    rb"([0-9a-f]{16})\n"
                )
                import re

                parsed = re.fullmatch(match, bytes(command))
                if not parsed:
                    raise AssertionError(f"unexpected host command: {command!r}")
                run_id = parsed.group(1)
                os.write(
                    master,
                    b"W RSS_HARNESS_RESULT run="
                    + run_id
                    + b" status=PASS failure=none restored=1 "
                    b"home_unchanged=1 settings_unchanged=1 "
                    b"collections_unchanged=1\n",
                )
            except BaseException as error:
                device_error.append(error)

        thread = threading.Thread(target=emulate_device)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as temporary:
                lines, run_id, prepared = RUNNER.run_serial(
                    slave_path,
                    pathlib.Path(temporary) / "serial.log",
                    ready_timeout=2.0,
                    run_timeout=2.0,
                )
            self.assertTrue(any(f"run={run_id} " in line for line in lines))
            self.assertIsNone(prepared)
        finally:
            thread.join(timeout=3.0)
            os.close(master)
        self.assertFalse(thread.is_alive())
        if device_error:
            raise device_error[0]

    def test_failure_or_wrong_order_is_rejected(self) -> None:
        run_id = "0011223344556677"
        result = (
            f"I RSS_HARNESS_RESULT run={run_id} status=PASS failure=none "
            "restored=1 home_unchanged=1 settings_unchanged=1 "
            "collections_unchanged=1"
        )
        with self.assertRaises(RUNNER.HarnessError):
            RUNNER.validate_harness_transcript(
                [
                    f"I RSS_HARNESS_START run={run_id} scenario=rss-nav-v1",
                    "W NAV_RETAIN phase=input",
                    result,
                ],
                run_id,
            )

    def test_production_gate_is_default_off_and_has_no_network_route(self) -> None:
        kconfig = (ROOT / "main" / "Kconfig.projbuild").read_text()
        cmake = (ROOT / "main" / "CMakeLists.txt").read_text()
        runtime = (ROOT / "main" / "runtime.cpp").read_text()
        wifi = (ROOT / "main" / "wifi.cpp").read_text()
        production_defaults = (ROOT / "sdkconfig.defaults").read_text()
        harness_defaults = (ROOT / "sdkconfig.rss-harness.defaults").read_text()
        self.assertIn("config INKOS_RSS_SERIAL_HARNESS", kconfig)
        self.assertRegex(kconfig, r"config INKOS_RSS_SERIAL_HARNESS[\s\S]+default n")
        self.assertIn("if(CONFIG_INKOS_RSS_SERIAL_HARNESS)", cmake)
        self.assertIn("esp_driver_usb_serial_jtag", cmake)
        self.assertIn("CONFIG_INKOS_RSS_SERIAL_HARNESS", runtime)
        self.assertIn("rss_serial_harness_protocol.h", runtime)
        self.assertNotIn("CONFIG_INKOS_RSS_SERIAL_HARNESS=y", production_defaults)
        self.assertIn("CONFIG_INKOS_RSS_SERIAL_HARNESS=y", harness_defaults)
        self.assertNotIn("RSS_HARNESS", wifi)
        self.assertNotRegex(runtime, r'"/api/[^"]*rss[^"]*"')


if __name__ == "__main__":
    unittest.main()
