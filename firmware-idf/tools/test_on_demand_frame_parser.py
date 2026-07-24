#!/usr/bin/env python3
"""Compile the production on-demand manifest parser and exercise refreshHint."""

from __future__ import annotations

import pathlib
import os
import shutil
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
IDF_CJSON = (
    pathlib.Path(os.environ.get("IDF_PATH", pathlib.Path.home() / "esp-idf-v5.4"))
    / "components"
    / "json"
    / "cJSON"
)


class OnDemandFrameParserHostTest(unittest.TestCase):
    def test_refresh_hint_is_optional_but_strict(self) -> None:
        cc = shutil.which("cc") or shutil.which("clang")
        cxx = shutil.which("c++") or shutil.which("clang++")
        self.assertIsNotNone(cc, "a host C compiler is required")
        self.assertIsNotNone(cxx, "a host C++ compiler is required")
        self.assertTrue((IDF_CJSON / "cJSON.c").is_file())

        with tempfile.TemporaryDirectory() as temporary:
            temporary_path = pathlib.Path(temporary)
            cjson_object = temporary_path / "cJSON.o"
            executable = temporary_path / "on-demand-frame-parser-test"
            subprocess.run(
                [
                    str(cc),
                    "-std=c11",
                    "-Wall",
                    "-Wextra",
                    "-Werror",
                    f"-I{IDF_CJSON}",
                    "-c",
                    str(IDF_CJSON / "cJSON.c"),
                    "-o",
                    str(cjson_object),
                ],
                check=True,
            )
            subprocess.run(
                [
                    str(cxx),
                    "-std=c++17",
                    "-Wall",
                    "-Wextra",
                    "-Werror",
                    f"-I{ROOT / 'tools' / 'host_stubs'}",
                    f"-I{ROOT / 'main' / 'include'}",
                    f"-I{IDF_CJSON}",
                    str(ROOT / "main" / "frame_refresh_hint_policy.cpp"),
                    str(ROOT / "main" / "ink_protocol.cpp"),
                    str(ROOT / "tools" / "on_demand_frame_parser_test.cpp"),
                    str(cjson_object),
                    "-lm",
                    "-o",
                    str(executable),
                ],
                check=True,
            )
            subprocess.run([str(executable)], check=True)


if __name__ == "__main__":
    unittest.main()
