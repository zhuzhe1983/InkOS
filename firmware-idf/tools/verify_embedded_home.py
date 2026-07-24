#!/usr/bin/env python3
"""Verify the PaperS3 home .ink before it is linked into the firmware."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import struct
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ARCHIVE = ROOT / "main" / "assets" / "home.ink"
DEFAULT_METADATA = ROOT / "main" / "assets" / "home.version.json"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
SEMVER_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$")
CLIENT_VERSION = "1.0.0"


class VerificationError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise VerificationError(message)


def is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_json(data: bytes, label: str) -> dict[str, Any]:
    try:
        value = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise VerificationError(f"{label}: invalid UTF-8 JSON: {error}") from error
    require(isinstance(value, dict), f"{label}: JSON root must be an object")
    return value


def safe_archive_name(name: str) -> bool:
    path = PurePosixPath(name)
    return bool(name) and not name.startswith("/") and "\\" not in name and ":" not in name and all(
        part not in ("", ".", "..") for part in path.parts
    )


DEVICE_COLLECTION_URLS = {
    "inkos://collection/rss",
    "inkos://collection/website",
    "inkos://collection/other",
    "inkos://app/random-image",
    "inkos://app/baidu-map",
    "inkos://device/settings",
}


def safe_target_url(value: object) -> bool:
    return isinstance(value, str) and (
        value.startswith("https://") or value in DEVICE_COLLECTION_URLS
    )


def valid_uuid(value: object) -> bool:
    return isinstance(value, str) and UUID_RE.fullmatch(value) is not None


def valid_sha(value: object) -> bool:
    return isinstance(value, str) and SHA256_RE.fullmatch(value) is not None


def semantic_version_parts(value: object) -> tuple[int, int, int]:
    require(isinstance(value, str), "semantic version must be a string")
    match = SEMVER_RE.fullmatch(value)
    require(match is not None, f"invalid semantic version: {value!r}")
    parts = tuple(int(item) for item in match.groups())
    require(all(item <= 0xFFFFFFFF for item in parts), f"semantic version component overflows: {value!r}")
    return parts


def bounds(value: object, width: int, height: int, label: str) -> tuple[int, int, int, int]:
    require(isinstance(value, dict), f"{label}: bounds must be an object")
    require(set(value) == {"x", "y", "width", "height"}, f"{label}: invalid bounds keys")
    x, y, w, h = (value.get(key) for key in ("x", "y", "width", "height"))
    require(all(is_int(item) for item in (x, y, w, h)), f"{label}: bounds must be integers")
    require(x >= 0 and y >= 0 and w > 0 and h > 0, f"{label}: invalid bounds")
    require(x + w <= width and y + h <= height, f"{label}: bounds exceed logical size")
    return x, y, w, h


def overlaps(left: tuple[int, int, int, int], right: tuple[int, int, int, int]) -> bool:
    lx, ly, lw, lh = left
    rx, ry, rw, rh = right
    return not (lx + lw <= rx or rx + rw <= lx or ly + lh <= ry or ry + rh <= ly)


def png_info(data: bytes, label: str) -> tuple[int, int]:
    require(data.startswith(b"\x89PNG\r\n\x1a\n"), f"{label}: invalid PNG signature")
    require(len(data) >= 33, f"{label}: truncated PNG")
    length, chunk = struct.unpack(">I4s", data[8:16])
    require(length == 13 and chunk == b"IHDR", f"{label}: missing PNG IHDR")
    width, height, depth, color_type = struct.unpack(">IIBB", data[16:26])
    require(depth == 4 and color_type == 3, f"{label}: expected indexed gray4 PNG")

    offset = 8
    palette: bytes | None = None
    saw_end = False
    while offset + 12 <= len(data):
        size = struct.unpack(">I", data[offset : offset + 4])[0]
        end = offset + 12 + size
        require(end <= len(data), f"{label}: truncated PNG chunk")
        kind = data[offset + 4 : offset + 8]
        payload = data[offset + 8 : offset + 8 + size]
        if kind == b"PLTE":
            palette = payload
        if kind == b"IEND":
            saw_end = True
            require(size == 0 and end == len(data), f"{label}: malformed PNG IEND")
            break
        offset = end
    require(saw_end, f"{label}: PNG has no IEND")
    require(palette is not None and len(palette) == 16 * 3, f"{label}: expected 16 gray entries")
    require(
        all(palette[index] == palette[index + 1] == palette[index + 2] for index in range(0, 48, 3)),
        f"{label}: palette contains non-gray colors",
    )
    return width, height


def verify_region(
    region: object,
    logical_width: int,
    logical_height: int,
    interaction_bounds: list[tuple[int, int, int, int]],
    label: str,
) -> str:
    require(isinstance(region, dict), f"{label}: dynamic region must be an object")
    require(
        set(region)
        == {"id", "kind", "bounds", "format", "timezone", "refreshMs", "fullRefreshEvery", "style"},
        f"{label}: invalid dynamic-region keys",
    )
    region_id = region.get("id")
    require(
        isinstance(region_id, str)
        and 1 <= len(region_id) <= 64
        and re.fullmatch(r"[a-z0-9][a-z0-9._-]*", region_id) is not None,
        f"{label}: invalid dynamic-region id",
    )
    require(region.get("kind") == "clock", f"{label}: only clock regions are supported")
    require(region.get("format") == "HH:mm:ss", f"{label}: unsupported clock format")
    require(region.get("timezone") == "Asia/Shanghai", f"{label}: unsupported clock timezone")
    refresh = region.get("refreshMs")
    full_refresh = region.get("fullRefreshEvery")
    require(is_int(refresh) and 1000 <= refresh <= 60000, f"{label}: invalid refreshMs")
    require(is_int(full_refresh) and 1 <= full_refresh <= 3600, f"{label}: invalid fullRefreshEvery")
    region_bounds = bounds(region.get("bounds"), logical_width, logical_height, label)
    require(
        all(not overlaps(region_bounds, item) for item in interaction_bounds),
        f"{label}: dynamic region overlaps an interaction",
    )

    style = region.get("style")
    require(isinstance(style, dict), f"{label}: style must be an object")
    require(
        set(style)
        == {"fontFamily", "fontSize", "fontWeight", "textAlign", "verticalAlign", "foreground", "background"},
        f"{label}: invalid style keys",
    )
    require(style.get("fontFamily") == "monospace", f"{label}: unsupported font family")
    require(is_int(style.get("fontSize")) and 8 <= style["fontSize"] <= 256, f"{label}: invalid font size")
    require(style.get("fontWeight") in (400, 700), f"{label}: invalid font weight")
    require(style.get("textAlign") in ("left", "center", "right"), f"{label}: invalid text alignment")
    require(style.get("verticalAlign") in ("top", "middle", "bottom"), f"{label}: invalid vertical alignment")
    require(style.get("foreground") in ("black", "white"), f"{label}: invalid foreground")
    require(style.get("background") in ("black", "white"), f"{label}: invalid background")
    require(style["foreground"] != style["background"], f"{label}: invisible clock style")
    return region_id


def verify_embedded_home(
    archive_path: Path = DEFAULT_ARCHIVE,
    metadata_path: Path = DEFAULT_METADATA,
) -> dict[str, int | str]:
    archive = archive_path.read_bytes()
    metadata = read_json(metadata_path.read_bytes(), str(metadata_path))
    require(metadata.get("schemaVersion") == "inkos.embedded-home/v1", "invalid home metadata schema")
    require(metadata.get("archiveBytes") == len(archive), "home archive byte count differs from metadata")
    require(metadata.get("archiveSha256") == sha256(archive), "home archive SHA-256 differs from metadata")

    referenced = {"ink-manifest.json"}
    dynamic_count = 0
    page_total = 0
    with zipfile.ZipFile(io.BytesIO(archive)) as package:
        infos = package.infolist()
        names = [info.filename for info in infos]
        require(len(names) == len(set(names)), "archive contains duplicate paths")
        for info in infos:
            require(safe_archive_name(info.filename), f"unsafe archive path: {info.filename!r}")
            require(not info.is_dir(), f"archive contains a directory entry: {info.filename}")
            require(not info.flag_bits & 1, f"encrypted archive entry: {info.filename}")
            require(
                info.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED),
                f"unsupported ZIP compression for {info.filename}",
            )

        require("ink-manifest.json" in names, "archive has no ink-manifest.json")
        manifest = read_json(package.read("ink-manifest.json"), "ink-manifest.json")
        require(manifest.get("schemaVersion") == "inkos.package/v1", "invalid package schema")
        require(valid_uuid(manifest.get("packageId")), "invalid package UUID")
        require(valid_uuid(manifest.get("entryUuid")), "invalid entry UUID")
        require(is_int(manifest.get("revision")) and manifest["revision"] > 0, "invalid revision")
        require(metadata.get("packageId") == manifest["packageId"], "metadata packageId mismatch")
        require(metadata.get("entryUuid") == manifest["entryUuid"], "metadata entryUuid mismatch")
        require(metadata.get("revision") == manifest["revision"], "metadata revision mismatch")
        generator = manifest.get("generator")
        require(isinstance(generator, dict), "manifest generator is missing")
        generator_name = f"{generator.get('name')}/{generator.get('version')}"
        require(metadata.get("generator") == generator_name, "metadata generator mismatch")

        compatibility = manifest.get("compatibility")
        require(isinstance(compatibility, dict) and compatibility.get("formatMajor") == 1, "unsupported formatMajor")
        minimum_clients = compatibility.get("minimumClientVersions")
        require(isinstance(minimum_clients, dict), "minimumClientVersions is missing")
        minimum_papers3 = minimum_clients.get("paperS3")
        require(
            semantic_version_parts(CLIENT_VERSION) >= semantic_version_parts(minimum_papers3),
            f"PaperS3 client {CLIENT_VERSION} is older than required {minimum_papers3}",
        )
        variants = manifest.get("variants")
        require(isinstance(variants, list), "manifest variants must be an array")
        expected_geometry = {
            "portrait": (540, 960, 90),
            "landscape": (960, 540, 0),
        }
        variant_by_id: dict[str, dict[str, Any]] = {}
        seen_orientations: set[str] = set()
        for variant in variants:
            require(isinstance(variant, dict), "variant must be an object")
            variant_id = variant.get("id")
            require(isinstance(variant_id, str) and variant_id and variant_id not in variant_by_id, "invalid/duplicate variant id")
            require(variant.get("profileId") == "m5stack-paper-s3-portrait", f"{variant_id}: wrong profile")
            require(variant.get("screenProfileVersion") == 2, f"{variant_id}: wrong profile version")
            require(variant.get("pixelFormat") == "gray4" and variant.get("codec") == "png", f"{variant_id}: wrong frame format")
            display = variant.get("displayMeta")
            require(isinstance(display, dict), f"{variant_id}: displayMeta is missing")
            orientation = display.get("orientation")
            require(orientation in expected_geometry and orientation not in seen_orientations, f"{variant_id}: invalid orientation")
            require(display.get("fontLevel") == 0 and display.get("invert") is False, f"{variant_id}: embedded base tuple changed")
            logical = variant.get("logicalSize")
            width, height, rotation = expected_geometry[orientation]
            require(logical == {"width": width, "height": height}, f"{variant_id}: wrong logical size")
            require(variant.get("displayRotation") == rotation, f"{variant_id}: wrong display rotation")
            seen_orientations.add(orientation)
            variant_by_id[variant_id] = variant
        require(seen_orientations == set(expected_geometry), "embedded home must contain portrait and landscape variants")

        documents = manifest.get("documents")
        require(isinstance(documents, list) and 1 <= len(documents) <= 2048, "invalid documents array")
        document_ids = {item.get("uuid") for item in documents if isinstance(item, dict)}
        require(len(document_ids) == len(documents) and all(valid_uuid(item) for item in document_ids), "invalid/duplicate document UUID")
        require(manifest["entryUuid"] in document_ids, "entry document is not packaged")

        widgets_by_document: dict[str, set[str]] = {}
        for document in documents:
            document_id = document["uuid"]
            label = f"document {document_id}"
            parent = document.get("parentUuid")
            if document_id == manifest["entryUuid"]:
                require(parent is None, f"{label}: entry must not have a parent")
            else:
                require(parent in document_ids, f"{label}: parent is not packaged")
            path = document.get("documentPath")
            require(path == f"documents/{document_id}.json", f"{label}: non-canonical document path")
            require(path in names, f"{label}: document payload is missing")
            raw_document = package.read(path)
            require(document.get("documentBytes") == len(raw_document), f"{label}: byte count mismatch")
            require(valid_sha(document.get("documentSha256")) and document["documentSha256"] == sha256(raw_document), f"{label}: SHA-256 mismatch")
            referenced.add(path)
            envelope = read_json(raw_document, path)
            require(envelope.get("schemaVersion") == "inkos.document/v1", f"{label}: invalid envelope schema")
            require(envelope.get("uuid") == document_id, f"{label}: envelope UUID mismatch")
            require(envelope.get("parentUuid") == parent, f"{label}: envelope parent mismatch")
            content = envelope.get("content")
            require(isinstance(content, dict), f"{label}: content is missing")
            require(content.get("schemaVersion") == "inkos.content/v2" and content.get("id") == document_id, f"{label}: content identity mismatch")
            widgets = envelope.get("localWidgets", [])
            require(isinstance(widgets, list), f"{label}: localWidgets must be an array")
            widgets_by_document[document_id] = {widget.get("id") for widget in widgets if isinstance(widget, dict)}

            document_variants = document.get("variants")
            require(isinstance(document_variants, list) and len(document_variants) == len(variant_by_id), f"{label}: incomplete variant set")
            require({item.get("variantId") for item in document_variants} == set(variant_by_id), f"{label}: duplicate/unknown variant set")
            for page_set in document_variants:
                variant_id = page_set["variantId"]
                variant = variant_by_id[variant_id]
                logical_width = variant["logicalSize"]["width"]
                logical_height = variant["logicalSize"]["height"]
                pages = page_set.get("pages")
                require(isinstance(pages, list) and pages, f"{label}/{variant_id}: pages are missing")
                require(page_set.get("pageCount") == len(pages), f"{label}/{variant_id}: pageCount mismatch")
                for index, page in enumerate(pages):
                    page_total += 1
                    frame_label = f"{label}/{variant_id}/page-{index}"
                    require(isinstance(page, dict) and page.get("pageIndex") == index, f"{frame_label}: non-contiguous page index")
                    image_path = page.get("imagePath")
                    sidecar_path = page.get("sidecarPath")
                    expected_prefix = f"frames/{variant_id}/{document_id}/{index:04d}"
                    require(image_path == expected_prefix + ".png", f"{frame_label}: non-canonical image path")
                    require(sidecar_path == expected_prefix + ".json", f"{frame_label}: non-canonical sidecar path")
                    require(image_path in names and sidecar_path in names, f"{frame_label}: payload is missing")
                    image = package.read(image_path)
                    sidecar_raw = package.read(sidecar_path)
                    require(page.get("imageBytes") == len(image), f"{frame_label}: image byte count mismatch")
                    require(valid_sha(page.get("imageSha256")) and page["imageSha256"] == sha256(image), f"{frame_label}: image SHA-256 mismatch")
                    require(page.get("sidecarBytes") == len(sidecar_raw), f"{frame_label}: sidecar byte count mismatch")
                    require(valid_sha(page.get("sidecarSha256")) and page["sidecarSha256"] == sha256(sidecar_raw), f"{frame_label}: sidecar SHA-256 mismatch")
                    require(png_info(image, image_path) == (logical_width, logical_height), f"{frame_label}: PNG geometry mismatch")
                    referenced.update((image_path, sidecar_path))

                    sidecar = read_json(sidecar_raw, sidecar_path)
                    allowed = {"schemaVersion", "packageId", "documentUuid", "parentUuid", "variantId", "pageIndex", "pageCount", "imagePath", "imageSha256", "logicalSize", "interactions", "dynamicRegions"}
                    require(set(sidecar) <= allowed, f"{frame_label}: unknown sidecar keys")
                    require(sidecar.get("schemaVersion") == "inkos.frame-sidecar/v1", f"{frame_label}: wrong sidecar schema")
                    require(sidecar.get("packageId") == manifest["packageId"], f"{frame_label}: package lineage mismatch")
                    require(sidecar.get("documentUuid") == document_id and sidecar.get("parentUuid") == parent, f"{frame_label}: document lineage mismatch")
                    require(sidecar.get("variantId") == variant_id, f"{frame_label}: variant mismatch")
                    require(sidecar.get("pageIndex") == index and sidecar.get("pageCount") == len(pages), f"{frame_label}: pagination mismatch")
                    require(sidecar.get("imagePath") == image_path and sidecar.get("imageSha256") == page["imageSha256"], f"{frame_label}: image lineage mismatch")
                    require(sidecar.get("logicalSize") == {"width": logical_width, "height": logical_height}, f"{frame_label}: logical size mismatch")
                    interactions = sidecar.get("interactions")
                    require(isinstance(interactions, list) and len(interactions) <= 256, f"{frame_label}: invalid interactions")
                    hitboxes: list[tuple[int, int, int, int]] = []
                    for interaction_index, interaction in enumerate(interactions):
                        interaction_label = f"{frame_label}/interaction-{interaction_index}"
                        require(isinstance(interaction, dict), f"{interaction_label}: interaction must be an object")
                        require(valid_uuid(interaction.get("targetUuid")) and interaction["targetUuid"] in document_ids, f"{interaction_label}: target is not packaged")
                        target_url = interaction.get("targetUrl")
                        require(target_url is None or safe_target_url(target_url), f"{interaction_label}: unsafe target URL")
                        hitboxes.append(bounds(interaction.get("bounds"), logical_width, logical_height, interaction_label))

                    dynamic = sidecar.get("dynamicRegions", [])
                    require(isinstance(dynamic, list) and len(dynamic) <= 8, f"{frame_label}: invalid dynamicRegions")
                    dynamic_ids: set[str] = set()
                    for region_index, region in enumerate(dynamic):
                        region_id = verify_region(region, logical_width, logical_height, hitboxes, f"{frame_label}/region-{region_index}")
                        require(region_id not in dynamic_ids, f"{frame_label}: duplicate dynamic-region id")
                        require(region_id in widgets_by_document[document_id], f"{frame_label}: region has no document widget")
                        dynamic_ids.add(region_id)
                        dynamic_count += 1
                    if index == 0 and widgets_by_document[document_id]:
                        require(dynamic_ids == widgets_by_document[document_id], f"{frame_label}: local widget has no dynamic region")

        require(dynamic_count >= 2, "embedded home does not contain portrait/landscape clock regions")
        require(set(names) == referenced, f"archive contains unreferenced entries: {sorted(set(names) - referenced)}")

    return {
        "archiveBytes": len(archive),
        "documents": len(documents),
        "pages": page_total,
        "dynamicRegions": dynamic_count,
        "packageId": manifest["packageId"],
        "revision": manifest["revision"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, default=DEFAULT_ARCHIVE)
    parser.add_argument("--metadata", type=Path, default=DEFAULT_METADATA)
    arguments = parser.parse_args()
    try:
        summary = verify_embedded_home(arguments.archive, arguments.metadata)
    except (OSError, zipfile.BadZipFile, VerificationError) as error:
        print(f"embedded-home verification failed: {error}")
        return 1
    print(
        "embedded-home verified: "
        f"package={summary['packageId']} revision={summary['revision']} "
        f"bytes={summary['archiveBytes']} documents={summary['documents']} "
        f"pages={summary['pages']} dynamicRegions={summary['dynamicRegions']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
