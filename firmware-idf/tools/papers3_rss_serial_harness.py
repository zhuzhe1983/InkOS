#!/usr/bin/env python3
"""Run and validate the guarded PaperS3 RSS navigation serial harness.

This tool never flashes firmware and never writes a device HTTP endpoint. Start
it while a harness-enabled image is booting, then restore the separately
preserved production application image after the run.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import secrets
import select
import sys
import termios
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Iterable, Sequence


EXPECTED_CAUSES = (
    "collection-open",
    "source-open",
    "package-link",
    "page-next",
    "page-previous",
    "history-back",
)
READY_RE = re.compile(r"RSS_HARNESS_READY .*challenge=([0-9a-f]{8})(?: |$)")
CAUSE_RE = re.compile(r"\bcause=([a-z-]+)(?: |$)")


class HarnessError(RuntimeError):
    """A deterministic harness precondition or acceptance failure."""


class TransientHarnessError(HarnessError):
    """A read-only endpoint is not reachable yet during device boot."""


def _get_json(url: str, timeout: float = 10.0) -> Any:
    request = urllib.request.Request(
        url, method="GET", headers={"Accept": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read(2 * 1024 * 1024 + 1)
            if len(body) > 2 * 1024 * 1024:
                raise HarnessError(f"oversized JSON response from {url}")
            if response.status != 200:
                raise HarnessError(f"GET {url} returned HTTP {response.status}")
    except (OSError, urllib.error.URLError) as error:
        raise TransientHarnessError(f"GET {url} failed: {error}") from error
    try:
        return json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HarnessError(f"GET {url} did not return valid JSON") from error


def durable_device_state(state: dict[str, Any]) -> dict[str, Any]:
    """Select persistent/non-secret fields that must survive the scenario."""
    network = state.get("network")
    if not isinstance(network, dict):
        raise HarnessError("device state has no network object")
    home = state.get("uploadedHome")
    collections = state.get("collections")
    if not isinstance(home, dict) or not isinstance(collections, dict):
        raise HarnessError("device state has no home/collections snapshot")
    return {
        "network": {
            "ssid": network.get("ssid"),
            "serverBaseUrl": network.get("serverBaseUrl"),
        },
        "uploadedHome": home,
        "collections": collections,
    }


def snapshot_digest(snapshot: dict[str, Any]) -> str:
    encoded = json.dumps(
        snapshot, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def snapshot_summary(snapshot: dict[str, Any]) -> dict[str, Any]:
    home = snapshot["uploadedHome"]
    collections = snapshot["collections"]
    return {
        "rendererBaseUrl": snapshot["network"]["serverBaseUrl"],
        "uploadedHome": home,
        "collectionsRevision": collections.get("revision"),
        "collectionsDigest": snapshot_digest(collections),
    }


def validate_harness_transcript(lines: Sequence[str], run_id: str) -> dict[str, Any]:
    start_marker = f"RSS_HARNESS_START run={run_id} "
    result_marker = f"RSS_HARNESS_RESULT run={run_id} "
    try:
        start = next(index for index, line in enumerate(lines) if start_marker in line)
        result = next(
            index
            for index, line in enumerate(lines[start:], start=start)
            if result_marker in line
        )
    except StopIteration as error:
        raise HarnessError("transcript lacks the correlated start/result pair") from error

    scoped = list(lines[start : result + 1])
    result_line = scoped[-1]
    result_fields = {
        key: value
        for token in result_line.split()
        if "=" in token
        for key, value in (token.split("=", 1),)
    }
    required_result = {
        "status": "PASS",
        "failure": "none",
        "restored": "1",
        "home_unchanged": "1",
        "settings_unchanged": "1",
        "collections_unchanged": "1",
    }
    incorrect = [
        f"{key}={value}"
        for key, value in required_result.items()
        if result_fields.get(key) != value
    ]
    if incorrect:
        raise HarnessError(
            "harness result is not a clean pass: " + ", ".join(incorrect)
        )
    forbidden = ("NAV_RETAIN", "NAV_FALLBACK", "RSS_HARNESS_REJECT")
    observed_forbidden = [
        marker for marker in forbidden if any(marker in line for line in scoped)
    ]
    if observed_forbidden:
        raise HarnessError(
            "failure/fallback markers observed: " + ", ".join(observed_forbidden)
        )

    def causes(marker: str) -> tuple[str, ...]:
        values: list[str] = []
        for line in scoped:
            if marker not in line:
                continue
            match = CAUSE_RE.search(line)
            if not match:
                raise HarnessError(f"{marker} line has no bounded cause field")
            values.append(match.group(1))
        return tuple(values)

    starts = causes("NAV_START")
    successes = causes("NAV_OK")
    if starts != EXPECTED_CAUSES:
        raise HarnessError(f"unexpected NAV_START causes: {starts!r}")
    if successes != EXPECTED_CAUSES:
        raise HarnessError(f"unexpected NAV_OK causes: {successes!r}")
    input_count = sum("NAV_INPUT " in line for line in scoped)
    target_count = sum(
        "NAV_TARGET " in line and bool(re.search(r"\bhit=1(?: |$)", line))
        for line in scoped
    )
    settled_count = sum("EPD frame settled " in line for line in scoped)
    if input_count != 6:
        raise HarnessError(f"expected 6 NAV_INPUT events, observed {input_count}")
    if target_count != 3:
        raise HarnessError(f"expected 3 hit NAV_TARGET events, observed {target_count}")
    if settled_count < 8:
        raise HarnessError(
            f"expected at least 8 settled display frames, observed {settled_count}"
        )
    if not any(
        "SOURCE_JOB " in line
        and (
            "phase=resolve status=ready " in line
            or "phase=resolve status=cached " in line
            or line.endswith("phase=resolve status=ready")
            or line.endswith("phase=resolve status=cached")
        )
        for line in scoped
    ):
        raise HarnessError("source resolver completion was not observed")
    return {
        "runId": run_id,
        "causes": list(successes),
        "navInputCount": input_count,
        "navTargetHitCount": target_count,
        "epdSettledCount": settled_count,
    }


def _timestamped(line: str) -> str:
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds")
    return f"{now} {line}"


@contextlib.contextmanager
def _serial_port(path: str) -> Iterable[int]:
    try:
        descriptor = os.open(path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    except OSError as error:
        raise HarnessError(f"cannot open serial port {path}: {error}") from error
    try:
        attributes = termios.tcgetattr(descriptor)
        attributes[0] = 0
        attributes[1] = 0
        attributes[2] = (
            termios.CLOCAL | termios.CREAD | termios.CS8
        )
        attributes[3] = 0
        attributes[4] = termios.B115200
        attributes[5] = termios.B115200
        attributes[6][termios.VMIN] = 0
        attributes[6][termios.VTIME] = 0
        termios.tcsetattr(descriptor, termios.TCSANOW, attributes)
        yield descriptor
    except termios.error as error:
        raise HarnessError(f"cannot configure serial port {path}: {error}") from error
    finally:
        os.close(descriptor)


def _serial_read(descriptor: int, timeout: float) -> bytes:
    readable, _, _ = select.select([descriptor], [], [], timeout)
    if not readable:
        return b""
    try:
        return os.read(descriptor, 512)
    except BlockingIOError:
        return b""
    except OSError as error:
        raise HarnessError(f"serial read failed: {error}") from error


def _serial_write(descriptor: int, payload: bytes) -> None:
    pending = memoryview(payload)
    deadline = time.monotonic() + 2.0
    while pending:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise HarnessError("serial command write timed out")
        _, writable, _ = select.select([], [descriptor], [], remaining)
        if not writable:
            continue
        try:
            written = os.write(descriptor, pending)
        except BlockingIOError:
            continue
        except OSError as error:
            raise HarnessError(f"serial command write failed: {error}") from error
        pending = pending[written:]
    termios.tcdrain(descriptor)


def run_serial(
    port: str,
    output: pathlib.Path,
    ready_timeout: float,
    run_timeout: float,
    before_command: Callable[[], dict[str, Any]] | None = None,
) -> tuple[list[str], str, dict[str, Any] | None]:
    output.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    run_id = secrets.token_hex(8)
    command_sent = False
    ready_deadline = time.monotonic() + ready_timeout
    result_deadline: float | None = None
    pending = bytearray()
    prepared: dict[str, Any] | None = None

    with _serial_port(port) as descriptor, output.open(
        "w", encoding="utf-8", newline="\n"
    ) as log:
        while True:
            chunk = _serial_read(descriptor, 0.25)
            if chunk:
                pending.extend(chunk)
            while b"\n" in pending:
                raw, _, remainder = pending.partition(b"\n")
                pending = bytearray(remainder)
                line = raw.rstrip(b"\r").decode("utf-8", errors="replace")
                lines.append(line)
                log.write(_timestamped(line) + "\n")
                log.flush()
                if not command_sent:
                    ready = READY_RE.search(line)
                    if ready:
                        challenge = ready.group(1)
                        if before_command is not None:
                            prepared = before_command()
                            log.write(
                                _timestamped(
                                    "HOST_PREFLIGHT status=pass digest="
                                    + snapshot_digest(prepared)
                                )
                                + "\n"
                            )
                            log.flush()
                        command = f"INKOS_TEST/1 RSS_NAV {challenge} {run_id}\n"
                        log.write(_timestamped(f"HOST_TX {command.rstrip()}") + "\n")
                        log.flush()
                        _serial_write(descriptor, command.encode("ascii"))
                        command_sent = True
                        result_deadline = time.monotonic() + run_timeout
                elif f"RSS_HARNESS_RESULT run={run_id} " in line:
                    return lines, run_id, prepared

            now = time.monotonic()
            if not command_sent and now >= ready_deadline:
                raise HarnessError(
                    "timed out waiting for RSS_HARNESS_READY; start capture "
                    "before the harness image boots"
                )
            if command_sent and result_deadline is not None and now >= result_deadline:
                raise HarnessError("timed out waiting for the correlated harness result")


def preflight(device_base: str, renderer_base: str | None) -> dict[str, Any]:
    state = _get_json(device_base.rstrip("/") + "/api/state")
    collections = _get_json(device_base.rstrip("/") + "/api/collections")
    _get_json(device_base.rstrip("/") + "/api/home/status")
    durable = durable_device_state(state)
    if collections != durable["collections"]:
        raise HarnessError("/api/state and /api/collections disagree")
    if not durable["uploadedHome"].get("active"):
        raise HarnessError("acceptance requires an active uploaded Home to preserve")
    configured_renderer = durable["network"].get("serverBaseUrl")
    renderer = renderer_base or configured_renderer
    if not isinstance(renderer, str) or not renderer:
        raise HarnessError("device has no configured renderer")
    if renderer_base and renderer_base.rstrip("/") != str(configured_renderer).rstrip("/"):
        raise HarnessError("--renderer-base differs from the device configuration")
    _get_json(renderer.rstrip("/") + "/api/ink/v1/openapi.json")
    return durable


def wait_for_preflight(
    device_base: str, renderer_base: str | None, timeout: float
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    last_error: TransientHarnessError | None = None
    while True:
        try:
            return preflight(device_base, renderer_base)
        except TransientHarnessError as error:
            last_error = error
            if time.monotonic() >= deadline:
                raise HarnessError(
                    f"device/renderer did not become ready: {last_error}"
                ) from error
            time.sleep(0.5)


def _write_evidence(path: pathlib.Path, evidence: dict[str, Any]) -> None:
    path.write_text(
        json.dumps(evidence, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True, help="USB-Serial/JTAG device path")
    parser.add_argument(
        "--device-base", required=True, help="read-only PaperS3 manager origin"
    )
    parser.add_argument(
        "--renderer-base",
        help="optional expected renderer origin; must match device state",
    )
    parser.add_argument(
        "--output",
        type=pathlib.Path,
        required=True,
        help="timestamped serial transcript path",
    )
    parser.add_argument("--ready-timeout", type=float, default=120.0)
    parser.add_argument("--run-timeout", type=float, default=900.0)
    return parser.parse_args(argv)


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv)
    evidence_path = args.output.with_suffix(args.output.suffix + ".json")
    before: dict[str, Any] | None = None
    after: dict[str, Any] | None = None
    validation: dict[str, Any] | None = None
    failure: str | None = None
    try:
        lines, run_id, before = run_serial(
            args.port,
            args.output,
            args.ready_timeout,
            args.run_timeout,
            before_command=lambda: wait_for_preflight(
                args.device_base, args.renderer_base, args.ready_timeout
            ),
        )
        validation = validate_harness_transcript(lines, run_id)
    except HarnessError as error:
        failure = str(error)
    finally:
        try:
            current = _get_json(args.device_base.rstrip("/") + "/api/state")
            after = durable_device_state(current)
        except HarnessError as error:
            failure = failure or f"postflight failed: {error}"

    unchanged = before is not None and after is not None and before == after
    if not unchanged:
        failure = failure or "durable device state changed across the run"
    evidence = {
        "schemaVersion": "inkos.papers3-rss-acceptance/v1",
        "status": "PASS" if failure is None else "FAIL",
        "failure": failure,
        "beforeDigest": snapshot_digest(before) if before is not None else None,
        "afterDigest": snapshot_digest(after) if after is not None else None,
        "before": snapshot_summary(before) if before is not None else None,
        "after": snapshot_summary(after) if after is not None else None,
        "durableStateUnchanged": unchanged,
        "validation": validation,
        "transcript": str(args.output),
    }
    _write_evidence(evidence_path, evidence)
    if failure:
        print(f"FAIL: {failure}", file=sys.stderr)
        print(f"Evidence: {evidence_path}", file=sys.stderr)
        return 1
    print(f"PASS: {validation}")
    print(f"Evidence: {evidence_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
