#!/usr/bin/env python3
"""Compile the production manifest/sidecar parser and test sourceImage."""

from __future__ import annotations

import os
import pathlib
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


class SourceImageManifestParserHostTest(unittest.TestCase):
    def test_source_image_schema_capability_and_sidecar_binding(self) -> None:
        cc = shutil.which("cc") or shutil.which("clang")
        cxx = shutil.which("c++") or shutil.which("clang++")
        self.assertIsNotNone(cc, "a host C compiler is required")
        self.assertIsNotNone(cxx, "a host C++ compiler is required")
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            cjson_object = directory / "cJSON.o"
            executable = directory / "source-image-manifest-parser-test"
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
                    str(ROOT / "main" / "ink_protocol.cpp"),
                    str(ROOT / "tools" / "source_image_manifest_parser_test.cpp"),
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
