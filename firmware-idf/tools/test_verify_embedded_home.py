#!/usr/bin/env python3

import json
import csv
import hashlib
import struct
import tempfile
import unittest
import zipfile
import zlib
from pathlib import Path

from verify_embedded_home import (
    DEFAULT_ARCHIVE,
    DEFAULT_METADATA,
    VerificationError,
    safe_archive_name,
    safe_target_url,
    semantic_version_parts,
    verify_embedded_home,
)


class EmbeddedHomeVerificationTest(unittest.TestCase):
    def test_checked_in_archive_is_complete(self) -> None:
        summary = verify_embedded_home()
        self.assertGreaterEqual(summary["documents"], 1)
        self.assertEqual(summary["dynamicRegions"], 2)

    def test_checked_in_home_uses_unified_reader_and_eight_current_apps(self) -> None:
        with zipfile.ZipFile(DEFAULT_ARCHIVE) as package:
            manifest = json.loads(package.read("ink-manifest.json"))
            entry = next(
                document for document in manifest["documents"]
                if document["uuid"] == manifest["entryUuid"]
            )
            home = json.loads(package.read(entry["documentPath"]))
        items = home["content"]["page"]["items"]
        self.assertEqual(len(items), 8)
        self.assertEqual(
            [item["title"] for item in items],
            [
                "网络阅读器",
                "RSS 阅读器",
                "老黄历",
                "图片查看器",
                "百度地图",
                "墨水屏测试",
                "使用指南",
                "时钟",
            ],
        )
        serialized = json.dumps(home, ensure_ascii=False)
        self.assertNotIn("inkos://collection/other", serialized)
        self.assertIn("inkos://collection/website", serialized)
        self.assertIn("inkos://app/random-image", serialized)
        self.assertIn("inkos://app/baidu-map", serialized)
        self.assertIn("inkos://device/settings", serialized)

    def test_archive_identity_mismatch_is_rejected(self) -> None:
        metadata = json.loads(DEFAULT_METADATA.read_text())
        metadata["archiveBytes"] += 1
        with tempfile.TemporaryDirectory() as directory:
            bad_metadata = Path(directory) / "home.version.json"
            bad_metadata.write_text(json.dumps(metadata))
            with self.assertRaisesRegex(VerificationError, "byte count"):
                verify_embedded_home(DEFAULT_ARCHIVE, bad_metadata)

    def test_traversal_and_absolute_zip_paths_are_rejected(self) -> None:
        self.assertFalse(safe_archive_name("../secret"))
        self.assertFalse(safe_archive_name("frames/../secret"))
        self.assertFalse(safe_archive_name("/absolute"))
        self.assertFalse(safe_archive_name(r"frames\\windows"))
        self.assertFalse(safe_archive_name("frames/C:drive"))
        self.assertTrue(safe_archive_name("frames/variant/document/0000.png"))

    def test_only_https_and_exact_device_action_urls_are_actions(self) -> None:
        self.assertTrue(safe_target_url("https://example.com/feed.xml"))
        self.assertTrue(safe_target_url("inkos://collection/rss"))
        self.assertTrue(safe_target_url("inkos://collection/website"))
        self.assertTrue(safe_target_url("inkos://collection/other"))
        self.assertTrue(safe_target_url("inkos://app/random-image"))
        self.assertTrue(safe_target_url("inkos://app/baidu-map"))
        self.assertTrue(safe_target_url("inkos://device/settings"))
        self.assertFalse(safe_target_url("http://example.com"))
        self.assertFalse(safe_target_url("inkos://collection/admin"))
        self.assertFalse(safe_target_url("inkos://app/random-image/"))
        self.assertFalse(safe_target_url("inkos://app/baidu-map?zoom=17"))
        self.assertFalse(safe_target_url("inkos://device/settings?tab=wifi"))
        self.assertFalse(safe_target_url("javascript:alert(1)"))

    def test_semantic_version_order_uses_numeric_components(self) -> None:
        self.assertGreater(semantic_version_parts("1.10.0"), semantic_version_parts("1.2.99"))
        self.assertEqual(semantic_version_parts("1.0.0-rc.1"), (1, 0, 0))
        with self.assertRaises(VerificationError):
            semantic_version_parts("1.0")

    def test_display_sprites_keep_true_grayscale_depth(self) -> None:
        display_source = (DEFAULT_ARCHIVE.parents[1] / "display.cpp").read_text()
        explicit = "setColorDepth(lgfx::color_depth_t::grayscale_8bit)"
        self.assertGreaterEqual(display_source.count(explicit), 3)
        self.assertNotIn("setColorDepth(8)", display_source)

    def test_papers3_epd_flushes_the_accumulated_dirty_rows(self) -> None:
        panel = (
            DEFAULT_ARCHIVE.parents[2]
            / "managed_components"
            / "m5stack__m5gfx"
            / "src"
            / "lgfx"
            / "v1"
            / "platforms"
            / "esp32"
            / "Panel_EPD.cpp"
        ).read_text()
        display = panel.split("void Panel_EPD::display", 1)[1].split(
            "static bool blit_dmabuf", 1
        )[0]
        self.assertIn("const uint_fast16_t flush_y = _range_mod.top", display)
        self.assertIn(
            "const uint_fast16_t flush_h = _range_mod.bottom - _range_mod.top + 1",
            display,
        )
        self.assertIn("cacheWriteBack(&_buf[flush_y * _cfg.panel_width >> 1]", display)
        self.assertNotIn("cacheWriteBack(&_buf[y * _cfg.panel_width >> 1]", display)

    def test_local_clock_uses_binary_glyph_level_fast_waveforms(self) -> None:
        with zipfile.ZipFile(DEFAULT_ARCHIVE) as package:
            manifest = json.loads(package.read("ink-manifest.json"))
            clock = next(
                document for document in manifest["documents"]
                if document["title"] == "时钟"
            )
            clock_document = json.loads(package.read(clock["documentPath"]))
            self.assertNotIn("88:88:88", json.dumps(clock_document, ensure_ascii=False))
            for variant in clock["variants"]:
                sidecar = json.loads(package.read(variant["pages"][0]["sidecarPath"]))
                region = sidecar["dynamicRegions"][0]
                self.assertGreaterEqual(region["bounds"]["height"], 120)
                self.assertEqual(region["style"]["verticalAlign"], "middle")
                self.assertEqual(region["style"]["fontWeight"], 400)

        main = DEFAULT_ARCHIVE.parents[1]
        display = (main / "display.cpp").read_text()
        clock_draw = display.split("bool PaperS3Display::showClock", 1)[1].split(
            "void PaperS3Display::showStatus", 1
        )[0]
        self.assertIn("fonts::DejaVu72", clock_draw)
        self.assertIn("changedClockGlyphs(previousValue, value)", clock_draw)
        self.assertIn("binarizeClockCanvas", clock_draw)
        self.assertIn("clockBinaryLevel", display)
        self.assertIn("clockInkBounds", clock_draw)
        self.assertIn("for (uint8_t changed = 0; changed < changes.count", clock_draw)
        self.assertIn("M5.Display.setEpdMode(epd_fast)", clock_draw)
        self.assertNotIn("setEpdMode(epd_quality)", clock_draw)
        self.assertNotIn("setEpdMode(epd_text)", clock_draw)
        self.assertIn(
            "{0, 0, region.bounds.width, region.bounds.height}",
            clock_draw,
        )
        self.assertIn("M5.Display.setClipRect", clock_draw)
        self.assertNotIn("cleanRefresh", clock_draw)
        self.assertEqual(
            clock_draw.count("M5.Display.display(region.bounds.x + commitRect.x"),
            1,
        )
        self.assertIn("M5.Display.setAutoDisplay(false)", clock_draw)
        self.assertIn("M5.Display.display(region.bounds.x + commitRect.x", clock_draw)
        self.assertIn("M5.Display.setAutoDisplay(true)", clock_draw)
        self.assertLess(
            clock_draw.index("M5.Display.setAutoDisplay(false)"),
            clock_draw.index("M5.Display.display(region.bounds.x + commitRect.x"),
        )
        self.assertLess(
            clock_draw.rindex("M5.Display.display(region.bounds.x + commitRect.x"),
            clock_draw.index("M5.Display.setAutoDisplay(true)"),
        )
        runtime = (main / "runtime.cpp").read_text()
        clock_tick = runtime.split("void InkRuntime::tickClock", 1)[1].split(
            "void InkRuntime::tickOrientation", 1
        )[0]
        self.assertIn("const bool firstTick", clock_tick)
        self.assertNotIn("periodicClean", clock_tick)
        self.assertIn("clockValues_[index], value, error", clock_tick)
        self.assertNotIn("minuteChanged", clock_tick)
        self.assertNotIn("clockTicks_", runtime)
        policy = (main / "include" / "clock_refresh_policy.h").read_text()
        self.assertIn("kSingleSecondChange.count == 1", policy)
        self.assertIn("kSecondRollover.count == 3", policy)
        self.assertIn("void InkRuntime::resetClockPaintState", runtime)
        self.assertGreaterEqual(runtime.count("resetClockPaintState();"), 6)

        # PaperS3's Panel_EPD fast path intentionally collapses every source
        # grey to a 1-bit Bayer pattern. The clock must pre-binarize its sprite
        # so only exact black/white samples ever reach this path.
        panel_epd = (
            DEFAULT_ARCHIVE.parents[2]
            / "managed_components"
            / "m5stack__m5gfx"
            / "src"
            / "lgfx"
            / "v1"
            / "platforms"
            / "esp32"
            / "Panel_EPD.cpp"
        ).read_text()
        self.assertIn("const bool fast = _epd_mode == epd_mode_t::epd_fast", panel_epd)
        self.assertIn("readbuf[i] = (sum + (b << 4)) < 248 ? 0 : 0xF", panel_epd)
        self.assertIn(
            "if (new_data.reinforce_endpoints ||",
            panel_epd,
        )
        self.assertIn(
            "candidate.reinforce_endpoints",
            panel_epd,
        )
        self.assertIn("displayEndpointReinforcement", panel_epd)
        self.assertIn(
            "uint_fast16_t xs = (_range_mod.left + _cfg.offset_x) & ~3u",
            panel_epd,
        )
        self.assertIn(
            "upd.w = xe - xs + 4",
            panel_epd,
        )
        self.assertNotIn(
            "upd.w = xe - xs + 2",
            panel_epd,
        )
        self.assertIn("kClockBinaryThreshold = 160", policy)
        self.assertIn("clockBinaryLevel(kClockBinaryThreshold) == 255", policy)

    def test_wifi_config_is_applied_before_explicit_connect(self) -> None:
        wifi_source = (DEFAULT_ARCHIVE.parents[1] / "wifi.cpp").read_text()
        event_handler = wifi_source.split("void wifiEvent", 1)[1].split(
            "std::string htmlEscape", 1
        )[0]
        self.assertNotIn("esp_wifi_connect()", event_handler)
        self.assertIn("esp_wifi_set_storage(WIFI_STORAGE_RAM)", wifi_source)
        self.assertIn("kStationIdleBit", wifi_source)
        self.assertLess(
            wifi_source.index("esp_wifi_set_config(WIFI_IF_STA, &config)"),
            wifi_source.index("status = esp_wifi_connect()"),
        )

    def test_papers3_full_refresh_policy_serializes_and_settles_frames(self) -> None:
        main = DEFAULT_ARCHIVE.parents[1]
        policy = (main / "include" / "display_refresh_policy.h").read_text()
        display = (main / "display.cpp").read_text()
        self.assertNotIn("kMaxFastFramesBeforeQuality", policy)
        self.assertIn("FrameRefresh::TextHighContrast", policy)
        self.assertIn("FrameRefresh::ScrubThenTextHighContrast", policy)
        self.assertIn("kMaxFramesBetweenScrubs = 12", policy)
        self.assertIn("state.orientation != next.orientation", policy)
        self.assertIn("state.fullScreenUiVisible", policy)
        self.assertGreaterEqual(policy.count("static_assert("), 5)
        self.assertIn("M5.Display.clearDisplay(TFT_WHITE)", display)
        self.assertIn("chooseFrameRefresh(refreshState_, variant.meta", display)
        self.assertIn("M5.Display.setEpdMode(epd_fast)", display)
        self.assertIn("M5.Display.setEpdMode(epd_text)", display)
        self.assertIn("M5.Display.setEpdMode(epd_quality)", display)
        self.assertIn("EPD scrub before settled %s frame content=%s", display)
        self.assertIn(
            "EPD direct %s %s frame content=%s hint=%s (no pre-scrub)",
            display,
        )
        self.assertIn(
            "EPD frame settled orientation=%s content=%s profile=%s hint=%s ",
            display,
        )
        self.assertNotIn("invertedQualityRefreshes", policy)
        frame = display.split("bool PaperS3Display::showFrame", 1)[1].split(
            "bool PaperS3Display::showClock", 1
        )[0]
        self.assertGreaterEqual(frame.count("M5.Display.waitDisplay()"), 2)
        self.assertIn("inverted display mode is no longer supported", frame)

    def test_loading_is_a_single_line_compact_bottom_partial_overlay(self) -> None:
        main = DEFAULT_ARCHIVE.parents[1]
        display = (main / "display.cpp").read_text()
        loading = display.split("void PaperS3Display::showLoading", 1)[1].split(
            "void PaperS3Display::showSettings", 1
        )[0]
        self.assertNotIn("fillScreen", loading)
        self.assertIn("screenHeight - bottom - stripHeight", loading)
        self.assertIn("landscape ? 56 : 64", loading)
        self.assertIn("canvas.setTextDatum(middle_left)", loading)
        self.assertEqual(loading.count("canvas.drawString("), 1)
        self.assertNotIn("const std::string &title", loading)
        self.assertIn("canvas.pushSprite(left, top)", loading)
        self.assertEqual(loading.count("M5.Display.waitDisplay()"), 1)
        self.assertIn("M5.Display.setEpdMode(epd_fast)", loading)
        self.assertNotIn("stateAfterFullScreenUi", loading)
        self.assertIn("stateAfterPartialOverlay", loading)
        self.assertIn("Do not classify this as full-screen UI", loading)
        header = (main / "include" / "display.h").read_text()
        self.assertIn(
            "void showLoading(const std::string &detail);", header
        )
        runtime = (main / "runtime.cpp").read_text()
        self.assertNotIn('showLoading("正在载入"', runtime)
        self.assertIn('showLoading("正在打开目标页面，请稍等…")', runtime)
        self.assertNotIn("服务器正在获取并渲染图片集", runtime)
        self.assertNotIn("服务器正在定位并生成静态地图", runtime)

    def test_online_child_navigation_reuses_verified_manifest_and_surfaces_failures(self) -> None:
        main = DEFAULT_ARCHIVE.parents[1]
        runtime = (main / "runtime.cpp").read_text()
        loader = runtime.split("bool InkRuntime::loadOnline", 1)[1].split(
            "bool InkRuntime::activate", 1
        )[0]
        self.assertIn("const Manifest *verifiedManifest", loader)
        self.assertIn("verifiedManifest->packageId != packageId", loader)
        self.assertIn("manifestHeaders(manifest)", loader)
        self.assertIn("std::vector<uint8_t>().swap(documentResponse.body)", loader)
        self.assertIn("std::vector<uint8_t>().swap(sidecarResponse.body)", loader)
        self.assertIn("const auto renderRequestedPage = [&]() -> bool", loader)
        self.assertIn("if (!variant) return renderRequestedPage();", loader)
        self.assertIn(
            "if (!pageSet || pageSet->pages.empty())", loader
        )
        self.assertGreaterEqual(loader.count("return renderRequestedPage();"), 2)
        self.assertNotIn(
            "Manifest has no frames for the selected variant", loader
        )

        navigate = runtime.split("bool InkRuntime::navigateTo", 1)[1].split(
            "bool InkRuntime::resolveSource", 1
        )[0]
        self.assertIn("active_.manifest.packageId == location.packageId", navigate)
        self.assertIn("findDocument(active_.manifest, location.documentUuid)", navigate)
        self.assertIn("3, verifiedManifest", navigate)
        self.assertIn("NAV_START", navigate)
        self.assertIn("NAV_OK", navigate)
        self.assertIn("NAV_RETAIN", navigate)
        self.assertIn("transaction.manifest = std::move(active_.manifest)", navigate)
        self.assertIn("active_.manifest = std::move(transaction.manifest)", navigate)

        handle = runtime.split("void InkRuntime::handleInput", 1)[1].split(
            "void InkRuntime::openSettings", 1
        )[0]
        self.assertIn(
            'showLoading("打开失败，已保留原页面：" + error)', handle
        )
        self.assertLess(
            handle.rindex("display_.showFrame(active_.png"),
            handle.rindex('showLoading("打开失败，已保留原页面：" + error)'),
        )
        packaged_attempt = handle.index(
            'if (navigateTo(packagedTarget, true, error, "package-link")) return;'
        )
        fallback_guard = handle.index("if (!interaction->fallbackUrl.empty())")
        fallback_attempt = handle.index(
            "resolveSource(interaction->fallbackUrl, sourceTarget, error)"
        )
        self.assertLess(packaged_attempt, fallback_guard)
        self.assertLess(fallback_guard, fallback_attempt)
        self.assertNotIn(
            'error == "Target UUID is absent from the manifest"', handle
        )
        self.assertIn("!interaction->fallbackUrl.empty()", handle)
        self.assertIn(
            'showLoading("正在打开文章详情，请稍等…")',
            handle,
        )
        self.assertIn("NAV_FALLBACK", handle)
        self.assertIn("从原始地址重新打开也失败", handle)
        self.assertGreaterEqual(loader.count("revisionRetriesRemaining - 1"), 6)
        self.assertIn("NAV_RETRY phase=document-integrity", loader)
        self.assertIn("NAV_RETRY phase=sidecar-integrity", loader)
        self.assertIn("NAV_RETRY phase=frame-integrity", loader)
        self.assertIn('jsonString(failure, "message")', runtime)

        protocol = (main / "ink_protocol.cpp").read_text()
        types = (main / "include" / "ink_types.h").read_text()
        fallback_validator = protocol.split("bool safeFallbackUrl", 1)[1].split(
            "bool parseVariant", 1
        )[0]
        sidecar_parser = protocol.split("bool parseSidecar", 1)[1].split(
            "bool parseOnDemandFrame", 1
        )[0]
        self.assertIn('std::strncmp(url, "https://", 8)', fallback_validator)
        self.assertIn("std::find(authority, authorityEnd, '@')", fallback_validator)
        self.assertIn('std::strncmp(port, ":443", 4)', fallback_validator)
        self.assertIn('stringAt(value, "fallbackUrl")', sidecar_parser)
        self.assertIn("!safeFallbackUrl(fallbackUrl)", sidecar_parser)
        self.assertIn("(targetUrl && fallbackUrl)", sidecar_parser)
        self.assertIn("std::string fallbackUrl;", types)

    def test_touch_gestures_are_release_confirmed_directional_and_debounced(self) -> None:
        main = DEFAULT_ARCHIVE.parents[1]
        display = (main / "display.cpp").read_text()
        poll = display.split("InputEvent PaperS3Display::pollInput", 1)[1].split(
            "bool PaperS3Display::suggestedOrientation", 1
        )[0]
        self.assertIn("touch.wasReleased()", poll)
        self.assertIn("kMinimumSwipeUs = 60'000", poll)
        self.assertIn("kMaximumSwipeUs = 2'000'000", poll)
        self.assertIn("std::min(width(), height()) * 10 / 100", poll)
        self.assertIn("absY * 140", poll)
        self.assertIn("absX * 140", poll)
        self.assertIn("inputCooldownUntilUs_ = now + 250'000", poll)
        self.assertIn("void PaperS3Display::suppressInputUntilRelease", display)
        runtime = (main / "runtime.cpp").read_text()
        handle = runtime.split("void InkRuntime::handleInput", 1)[1].split(
            "void InkRuntime::openSettings", 1
        )[0]
        self.assertLess(
            handle.index("display_.suppressInputUntilRelease()"),
            handle.index("navigateTo("),
        )
        self.assertIn("showNavigationProgress", handle)

    def test_papers3_settings_remove_and_migrate_legacy_inversion(self) -> None:
        main = DEFAULT_ARCHIVE.parents[1]
        settings_source = (main / "settings.cpp").read_text()
        display = (main / "display.cpp").read_text()
        settings_ui = display.split("void PaperS3Display::showSettings", 1)[1].split(
            "void PaperS3Display::showPortal", 1
        )[0]
        self.assertNotIn("反色", settings_ui)
        self.assertIn('nvs_erase_key(handle, "invert")', settings_source)
        self.assertNotIn('nvs_set_u8(handle, "invert"', settings_source)
        runtime = (main / "runtime.cpp").read_text()
        display_meta = runtime.split("DisplayMeta InkRuntime::displayMeta", 1)[1].split(
            "const DisplayVariant", 1
        )[0]
        self.assertIn("settings_.fontLevel, false", display_meta)

    def test_uploaded_home_uses_bounded_raw_ab_slots_and_atomic_nvs_activation(self) -> None:
        project = DEFAULT_ARCHIVE.parents[2]
        rows = []
        with (project / "partitions.csv").open(newline="") as source:
            rows = [row for row in csv.reader(source) if row and not row[0].lstrip().startswith("#")]
        partitions = {row[0].strip(): row for row in rows}
        self.assertEqual(partitions["factory"][4].strip().lower(), "0x740000")
        self.assertEqual(partitions["home_a"][3].strip().lower(), "0x770000")
        self.assertEqual(partitions["home_a"][4].strip().lower(), "0x440000")
        self.assertEqual(partitions["home_b"][3].strip().lower(), "0xbb0000")
        self.assertEqual(partitions["home_b"][4].strip().lower(), "0x440000")
        self.assertEqual(int(partitions["home_a"][3], 16) % 0x10000, 0)
        self.assertEqual(int(partitions["home_b"][3], 16) % 0x10000, 0)
        self.assertEqual(int(partitions["home_a"][4], 16) % 0x10000, 0)
        self.assertEqual(int(partitions["home_b"][4], 16) % 0x10000, 0)
        self.assertEqual(int(partitions["home_b"][3], 16) + int(partitions["home_b"][4], 16), 0xff0000)

        storage = (DEFAULT_ARCHIVE.parents[1] / "device_storage.cpp").read_text()
        finish = storage.split("bool finishHomeUpload", 1)[1].split("void abortHomeUpload", 1)[0]
        verifier_task = storage.split("void homeVerificationTask", 1)[1].split(
            "bool flushHomeUploadBlock", 1
        )[0]
        self.assertIn("verifyHomeArchive", verifier_task)
        self.assertIn("homeVerificationTask", finish)
        self.assertIn("xTaskCreatePinnedToCoreWithCaps", finish)
        self.assertIn("kHomeVerificationStackBytes", finish)
        self.assertIn("MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT", finish)
        self.assertIn("ulTaskNotifyTake", finish)
        self.assertIn("writeHomeRecord", finish)
        self.assertLess(finish.index("ulTaskNotifyTake"), finish.index("writeHomeRecord"))
        begin = storage.split("bool beginHomeUpload", 1)[1].split(
            "bool appendHomeUpload", 1
        )[0]
        reserve = storage.split("bool reserveHomeUploadIo", 1)[1].split(
            "bool beginHomeUpload", 1
        )[0]
        append = storage.split("bool appendHomeUpload", 1)[1].split(
            "bool finishHomeUpload", 1
        )[0]
        full_verify = storage.split("bool verifyHomeArchive", 1)[1].split(
            "bool flushHomeUploadBlock", 1
        )[0]
        self.assertNotIn("esp_partition_erase_range", begin)
        self.assertIn("flushHomeUploadBlock", append)
        self.assertIn("validateEntryMetadata", full_verify)
        self.assertIn("archive.entryCount()", full_verify)
        self.assertIn(
            "archive.extractText(document.documentPath", full_verify
        )
        self.assertIn("validateDocumentEnvelope(documentJson, document", full_verify)
        self.assertIn("archive.extractText(page.sidecarPath", full_verify)
        self.assertIn("parseSidecar(sidecarJson", full_verify)
        self.assertIn("archive.extract(page.imagePath", full_verify)
        self.assertIn("byteVectorMatches(png, page.imageBytes", full_verify)
        self.assertIn("validPng(png, variant->width", full_verify)
        self.assertIn("for (const auto &document : manifest.documents)", full_verify)
        self.assertIn("for (const auto &page : pageSet.pages)", full_verify)
        self.assertIn("checkedPages != totalPages", full_verify)
        self.assertIn("home verify payloads documents=%u/%u pages=%u/%u", storage)
        reopen = storage.split("bool openVerifiedHomeArchive", 1)[1].split(
            "struct HomeVerificationWork", 1
        )[0]
        self.assertIn("archive.open", reopen)
        self.assertIn('archive.extractText("ink-manifest.json"', reopen)
        self.assertIn("parseManifest", reopen)
        self.assertNotIn("validateEntryMetadata", reopen)
        mapped_home = storage.split("bool mapStoredHome", 1)[1].split(
            "void unmapStoredHome", 1
        )[0]
        self.assertIn("archiveSha == record.archiveSha256", mapped_home)
        self.assertIn("openVerifiedHomeArchive", mapped_home)
        self.assertNotIn("verifyHomeArchive", mapped_home)
        self.assertIn("home upload activated", finish)
        self.assertIn("sha256HexYielding", verifier_task)
        self.assertIn("bytes erased=%u programmed=%u unchanged=%u", finish)
        flush = storage.split("bool flushHomeUploadBlock", 1)[1].split(
            "void signalCollectionsChanged", 1
        )[0]
        self.assertIn("kFlashEraseBlockBytes", flush)
        self.assertIn("vTaskDelay(kFlashNetworkYieldTicks)", flush)
        self.assertIn("kCooperativeFlashChunkBytes", flush)
        self.assertIn("erasedOffset += kFlashEraseSectorBytes", flush)
        self.assertNotIn(
            "esp_partition_erase_range(\n        upload.partition, offset, eraseBytes)",
            flush,
        )
        self.assertIn("upload.flashIoBuffer", flush)
        self.assertIn("esp_ptr_internal(upload.flashIoBuffer.get())", flush)
        self.assertIn("esp_ptr_in_dram(upload.flashIoBuffer.get())", flush)
        self.assertNotIn("esp_partition_write(\n      upload.partition, offset, upload.pendingBlock.data()", flush)
        self.assertNotIn("existingBlock", storage)
        self.assertIn("claimLinkedHomeFlashIoBuffer", reserve)
        self.assertIn("linkedHomeFlashIoBuffer", reserve)
        self.assertIn("heap_caps_get_largest_free_block", reserve)
        self.assertNotIn("heap_caps_malloc", reserve)
        self.assertNotIn("heap_caps_malloc", begin)
        self.assertIn("was not reserved before acceptance", begin)
        self.assertIn("kCooperativeFlashChunkBytes = 2U * 1024U", storage)
        self.assertIn("kFlashIoChunkBytes = kCooperativeFlashChunkBytes", storage)
        self.assertIn("static DRAM_ATTR uint32_t", storage)
        self.assertIn("kHomeUploadProgressBytes = 256U * 1024U", storage)
        self.assertIn("kHomeVerificationStackBytes = 32U * 1024U", storage)
        self.assertIn('logHomeUploadResources(upload, "progress")', append)
        self.assertIn("kFlashIoChunkBytes <= CONFIG_SPI_FLASH_WRITE_CHUNK_SIZE", storage)
        upload_header = (DEFAULT_ARCHIVE.parents[1] / "include" / "device_storage.h").read_text()
        self.assertIn(
            "std::unique_ptr<uint8_t, decltype(&releaseHomeUploadBuffer)>",
            upload_header,
        )
        self.assertGreaterEqual(storage.count("releaseHomeUploadIo(upload)"), 3)
        self.assertNotIn("nvs_close(handle);\n  nvs_close(handle);", storage)
        self.assertIn("homeRecordCrc", storage)
        self.assertIn("esp_partition_mmap", storage)
        self.assertIn("RTC_NOINIT_ATTR PersistentHomeCheckpoint", storage)
        self.assertIn('case HomeCheckpointPhase::Receiving: return "receiving"', storage)
        for phase in (
            "zip-directory",
            "manifest-extract",
            "manifest-parse",
            "references",
            "entry-frames",
            "payloads",
        ):
            self.assertIn(f'return "{phase}"', storage)
        sdkconfig_defaults = (project / "sdkconfig.defaults").read_text()
        self.assertIn("CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL=0", sdkconfig_defaults)
        self.assertIn("kMaximumUploadedHomeBytes = 0x440000", (DEFAULT_ARCHIVE.parents[1] / "include" / "device_storage.h").read_text())

        archive = (DEFAULT_ARCHIVE.parents[1] / "ink_archive.cpp").read_text()
        metadata = archive.split("bool InkArchive::validateEntryMetadata", 1)[1]
        self.assertIn("localFlags != entry->flags", metadata)
        self.assertIn("localCrc != entry->crc32", metadata)
        self.assertIn("std::memcmp", metadata)

    def test_activation_rejects_corrupt_non_entry_payload_before_nvs_commit(self) -> None:
        archive_bytes = bytearray(DEFAULT_ARCHIVE.read_bytes())
        with zipfile.ZipFile(DEFAULT_ARCHIVE) as package:
            manifest = json.loads(package.read("ink-manifest.json"))
            victim_document = next(
                document
                for document in manifest["documents"]
                if document["uuid"] != manifest["entryUuid"]
                and package.getinfo(document["documentPath"]).compress_type
                == zipfile.ZIP_DEFLATED
            )
            victim = package.getinfo(victim_document["documentPath"])

        self.assertNotEqual(victim_document["uuid"], manifest["entryUuid"])
        self.assertEqual(victim.compress_type, zipfile.ZIP_DEFLATED)
        self.assertGreater(victim.compress_size, 8)
        local = victim.header_offset
        self.assertEqual(archive_bytes[local : local + 4], b"PK\x03\x04")
        name_bytes, extra_bytes = struct.unpack_from("<HH", archive_bytes, local + 26)
        payload = local + 30 + name_bytes + extra_bytes
        archive_bytes[payload + victim.compress_size // 2] ^= 0x01

        # Model upload semantics: the device computes the whole-archive SHA
        # from the received (already-corrupt) bytes, so update only that outer
        # identity. Full payload verification must still reject ZIP CRC/deflate
        # or the manifest-declared document SHA before activation.
        metadata = json.loads(DEFAULT_METADATA.read_text())
        metadata["archiveSha256"] = hashlib.sha256(archive_bytes).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            bad_archive = Path(directory) / "corrupt-non-entry.ink"
            bad_metadata = Path(directory) / "corrupt-non-entry.version.json"
            bad_archive.write_bytes(archive_bytes)
            bad_metadata.write_text(json.dumps(metadata))
            with self.assertRaises(
                (VerificationError, zipfile.BadZipFile, zlib.error)
            ) as rejected:
                verify_embedded_home(bad_archive, bad_metadata)
            self.assertRegex(
                str(rejected.exception), r"CRC|deflat|decompress|SHA-256"
            )

        storage = (DEFAULT_ARCHIVE.parents[1] / "device_storage.cpp").read_text()
        verifier = storage.split("bool verifyHomeArchive", 1)[1].split(
            "bool openVerifiedHomeArchive", 1
        )[0]
        finish = storage.split("bool finishHomeUpload", 1)[1].split(
            "void abortHomeUpload", 1
        )[0]
        self.assertIn("archive.extractText(document.documentPath", verifier)
        self.assertIn("document.documentSha256", verifier)
        self.assertIn("checkedDocuments != manifest.documents.size()", verifier)
        self.assertIn("checkedPages != totalPages", verifier)
        self.assertLess(finish.index("ulTaskNotifyTake"), finish.index("writeHomeRecord"))

    def test_manager_persists_after_ap_and_exposes_bounded_crud(self) -> None:
        main = DEFAULT_ARCHIVE.parents[1]
        wifi = (main / "wifi.cpp").read_text()
        stop = wifi.split("void CaptivePortal::stop()", 1)[1].split(
            "bool CaptivePortal::consumeSaved", 1
        )[0]
        self.assertNotIn("httpd_stop", stop)
        self.assertIn("startManager", wifi)
        for route in (
            "/api/state",
            "/api/settings",
            "/api/collections",
            "/api/home/status",
            "/api/home",
        ):
            self.assertIn(f'.uri = "{route}"', wifi)
        storage_header = (main / "include" / "device_storage.h").read_text()
        self.assertIn("kMaximumRssCollectionEntries = 16", storage_header)
        self.assertIn("kMaximumWebsiteCollectionEntries = 32", storage_header)
        self.assertIn("kMaximumImageCollectionEntries = 16", storage_header)
        self.assertIn("<label for=images>图片查看器</label>", wifi)
        self.assertNotIn("随机图片（系统）", wifi)
        self.assertIn("https://picsum.photos/540/960?random=1", wifi)
        self.assertNotIn(
            "https://picsum.photos/540/960?grayscale&amp;random=1", wifi
        )
        self.assertIn("所有行都可以修改、删除或新增", wifi)
        self.assertIn("列表按填写顺序逐行保存", wifi)
        self.assertIn("上划看下一张、下划看上一张", wifi)
        self.assertNotIn("<label for=other>", wifi)
        self.assertIn("beginHomeUpload", wifi)
        self.assertIn("finishHomeUpload", wifi)
        home_put = wifi.split("esp_err_t apiHomePutHandler", 1)[1].split(
            "esp_err_t apiHomeStatusHandler", 1
        )[0]
        self.assertIn("MALLOC_CAP_SPIRAM", home_put)
        self.assertIn("xTaskCreatePinnedToCore(homeJobTask", home_put)
        self.assertIn("&task, 1)", home_put)
        self.assertIn("reserveHomeUploadIo(pending->upload", home_put)
        self.assertLess(
            home_put.index("xTaskCreatePinnedToCore(homeJobTask"),
            home_put.index("reserveHomeUploadIo(pending->upload"),
        )
        self.assertLess(
            home_put.index("reserveHomeUploadIo(pending->upload"),
            home_put.index('"202 Accepted"'),
        )
        self.assertIn("pending->cancelled = true", home_put)
        self.assertIn("xTaskNotifyGive(task)", home_put)
        self.assertIn('"202 Accepted"', home_put)
        self.assertNotIn("beginHomeUpload", home_put)
        self.assertNotIn("appendHomeUpload", home_put)
        worker = wifi.split("void runHomeJob", 1)[1].split(
            "void homeJobTask", 1
        )[0]
        self.assertIn("beginHomeUpload", worker)
        self.assertIn("appendHomeUpload", worker)
        self.assertIn("finishHomeUpload", worker)
        self.assertIn("body.reset()", worker)
        task = wifi.split("void homeJobTask", 1)[1].split(
            "bool publishSavedSettings", 1
        )[0]
        self.assertIn("ulTaskNotifyTake", task)
        self.assertIn("pending->cancelled", task)
        self.assertIn("config.recv_wait_timeout = 5", wifi)
        self.assertIn("fetch('/api/home/status'", wifi)
        status_json = wifi.split("bool homeJobStatusJson", 1)[1].split(
            "void runHomeJob", 1
        )[0]
        self.assertIn('"recoveryCheckpoint"', status_json)
        self.assertIn("loadHomeUploadDiagnostic", status_json)

    def test_home_upload_receive_uses_lan_safe_deadline_and_rtc_progress(self) -> None:
        main = DEFAULT_ARCHIVE.parents[1]
        wifi = (main / "wifi.cpp").read_text()
        storage = (main / "device_storage.cpp").read_text()
        storage_header = (main / "include" / "device_storage.h").read_text()
        home_put = wifi.split("esp_err_t apiHomePutHandler", 1)[1].split(
            "esp_err_t apiHomeStatusHandler", 1
        )[0]

        self.assertIn(
            "kHomeReceiveTotalTimeoutUs = 120LL * 1000LL * 1000LL", wifi
        )
        self.assertIn(
            "kRequestReceiveIdleTimeoutUs = 8LL * 1000LL * 1000LL", wifi
        )
        self.assertIn("kHomeReceiveCheckpointBytes = 256U * 1024U", wifi)
        self.assertIn("kHomeReceiveTotalTimeoutUs", home_put)
        self.assertIn("recordHomeUploadReceiveCheckpoint", home_put)
        self.assertIn("receiving=%u/%u elapsed=%lldms", home_put)
        self.assertNotIn("25-second", home_put)

        self.assertIn("recordHomeUploadReceiveCheckpoint", storage_header)
        checkpoint = storage.split(
            "void recordHomeUploadReceiveCheckpoint", 1
        )[1].split("void releaseHomeUploadBuffer", 1)[0]
        self.assertIn("saveHomeCheckpoint(HomeCheckpointPhase::Receiving", checkpoint)
        self.assertNotIn("nvs_", checkpoint)
        self.assertNotIn("esp_partition_", checkpoint)

    def test_collection_pages_use_server_semantic_renderer(self) -> None:
        runtime = (DEFAULT_ARCHIVE.parents[1] / "runtime.cpp").read_text()
        collection = runtime.split("bool InkRuntime::renderCollection", 1)[1].split(
            "bool InkRuntime::fetchManifest", 1
        )[0]
        self.assertIn('"inkos.content/v2"', collection)
        self.assertIn('"kind", "list"', collection)
        self.assertIn('std::string(kApiBase) + "/render"', collection)
        self.assertIn("parseSidecar", collection)
        self.assertIn("validPngGeometry", collection)
        self.assertNotIn("drawString", collection)

    def test_server_owned_apps_are_exact_no_store_transactions(self) -> None:
        main = DEFAULT_ARCHIVE.parents[1]
        runtime = (main / "runtime.cpp").read_text()
        protocol = (main / "ink_protocol.cpp").read_text()
        app = runtime.split("bool InkRuntime::renderApp", 1)[1].split(
            "bool InkRuntime::fetchManifest", 1
        )[0]
        for action in ("inkos://app/random-image", "inkos://app/baidu-map"):
            self.assertIn(action, runtime)
            self.assertIn(action, protocol)
        self.assertIn('std::string(kApiBase) + "/apps/execute"', app)
        self.assertIn('"nonce"', app)
        self.assertIn('"requestedAtUnixMs"', app)
        self.assertIn('"pageIndex"', app)
        self.assertIn('"images"', app)
        self.assertIn("collections_.images.size()", app)
        self.assertIn("for (const auto &entry : collections_.images)", app)
        self.assertIn("sidecar.pageCount != pageCount", app)
        self.assertIn('response.header("x-ink-app-page-index")', app)
        self.assertIn('response.header("x-ink-app-image-mode")', app)
        self.assertIn(
            '"photo-papers3-slideshow-gray16-rgb-png-v3"',
            runtime,
        )
        self.assertIn('"diagnostic-raw-colour-png-v1"', runtime)
        self.assertIn(
            "FrameRenderProfile::PaperS3PhotoGray16",
            app,
        )
        self.assertIn('"APP_FRAME action=%s', app)
        self.assertIn("expectedImageMode", app)
        self.assertIn("FrameRenderProfile::Generic", app)
        self.assertIn("result.renderProfile = renderProfile", app)
        self.assertIn("validPngGeometry", app)
        self.assertIn("!sidecar.interactions.empty()", app)
        self.assertNotIn("picsum.photos", runtime)
        self.assertNotIn("api.map.baidu.com", runtime)
        navigate = runtime.split("bool InkRuntime::navigateTo", 1)[1].split(
            "bool InkRuntime::resolveSource", 1
        )[0]
        self.assertIn("const std::string previousAppNonce", navigate)
        self.assertIn("activeAppAction_ = previousAppAction", navigate)
        self.assertIn("activeAppNonce_ = previousAppNonce", navigate)
        controls = runtime.split("void InkRuntime::handleInput", 1)[1].split(
            "void InkRuntime::openSettings", 1
        )[0]
        self.assertIn("InputKind::SwipeUp", controls)
        self.assertIn("location_.pageIndex + 1", controls)
        self.assertIn("InputKind::SwipeDown", controls)
        self.assertIn("location_.pageIndex - 1", controls)
        self.assertIn("display_.showFrame(active_.png", controls)
        input_handler = runtime.split("void InkRuntime::handleInput", 1)[1].split(
            "DisplayMeta InkRuntime::displayMeta", 1
        )[0]
        self.assertIn("location_.pageIndex + 1 < active_.sidecar.pageCount", input_handler)
        self.assertIn("location_.pageIndex > 0", input_handler)
        self.assertIn(
            'returnToPreviousLevel("last-page-back", "last-page-parent-back")',
            input_handler,
        )
        self.assertIn("active_.sidecar.pageCount > 0", input_handler)

    def test_first_boot_seeds_readers_images_and_migrates_v1_other(self) -> None:
        storage = (DEFAULT_ARCHIVE.parents[1] / "device_storage.cpp").read_text()
        defaults = storage.split("DeviceCollections defaultCollections()", 1)[1].split(
            "bool writeCollectionsBlobUnlocked", 1
        )[0]
        for label, url in (
            ("煎蛋", "https://jandan.net/"),
            ("维基百科", "https://zh.wikipedia.org/"),
            ("人民日报", "https://www.people.com.cn/"),
            ("百度贴吧", "https://tieba.baidu.com/"),
            ("Chiphell", "https://www.chiphell.com/"),
        ):
            self.assertIn(label, defaults)
            self.assertIn(url, defaults)
        for label, url in (
            ("少数派", "https://sspai.com/feed"),
            ("阮一峰的网络日志", "https://www.ruanyifeng.com/blog/atom.xml"),
            ("Solidot", "https://www.solidot.org/index.rss"),
        ):
            self.assertIn(label, defaults)
            self.assertIn(url, defaults)
        self.assertIn("随机图片", defaults)
        self.assertIn("kDefaultRandomImageUrl", defaults)
        self.assertIn(
            '"https://picsum.photos/540/960?random=1"', storage
        )
        self.assertIn(
            '"https://picsum.photos/540/960?grayscale&random=1"', storage
        )
        load = storage.split("bool loadCollections", 1)[1].split(
            "bool saveCollections", 1
        )[0]
        self.assertGreaterEqual(load.count("writeCollectionsBlobUnlocked"), 2)
        self.assertIn("recovered default network-reader collection", load)
        parser = storage.split("bool parseCollectionsJsonImpl", 1)[1].split(
            "bool readHomeRecord", 1
        )[0]
        self.assertIn('"inkos.device-collections/v1"', parser)
        self.assertIn('"inkos.device-collections/v2"', parser)
        self.assertIn('parseEntries(root.get(), "other", CollectionKind::Website', parser)
        self.assertIn("websiteUrls.insert(entry.url)", parser)
        self.assertIn("kRetiredRandomImageAction", parser)
        self.assertIn("kLegacyGrayscaleRandomImageUrl", parser)
        self.assertIn("entry.url == kLegacyGrayscaleRandomImageUrl", parser)
        self.assertIn("kDefaultRandomImageUrl", parser)
        serializer = storage.split("std::string collectionsJson", 1)[1].split(
            "bool loadCollections", 1
        )[0]
        self.assertIn('"inkos.device-collections/v2"', serializer)
        self.assertIn('addEntries("images", collections.images)', serializer)
        self.assertNotIn('addEntries("other"', serializer)
        self.assertIn("migrated collections into current readers", load)

    def test_persisted_user_input_is_sanitized_without_blocking_boot(self) -> None:
        main = DEFAULT_ARCHIVE.parents[1]
        settings = (main / "settings.cpp").read_text()
        storage = (main / "device_storage.cpp").read_text()

        load_settings = settings.split("bool loadSettings", 1)[1].split(
            "bool saveSettings", 1
        )[0]
        for guard in (
            "loaded.wifiSsid.size() > 32",
            "containsUnsafeTextByte(loaded.wifiSsid)",
            "loaded.wifiPassword.size() > 63",
            "containsUnsafeTextByte(loaded.wifiPassword)",
            "validServerBaseUrl(loaded.serverBaseUrl",
            "orientationMode > 1",
            "manualOrientation > 1",
            "fontLevel < -2",
            "fontLevel > 2",
        ):
            self.assertIn(guard, load_settings)
        self.assertIn("loaded.serverBaseUrl.clear()", load_settings)
        self.assertIn("std::clamp<int8_t>(fontLevel, -2, 2)", load_settings)
        self.assertIn("sanitized in-memory values are still safe", load_settings)
        self.assertLess(
            load_settings.index("settings = std::move(loaded)"),
            load_settings.rindex("return true"),
        )

        save_settings = settings.split("bool saveSettings", 1)[1].split(
            "bool clearNetworkSettings", 1
        )[0]
        self.assertIn("Settings are outside PaperS3 limits", save_settings)
        self.assertIn("validServerBaseUrl(settings.serverBaseUrl", save_settings)
        self.assertLess(
            save_settings.index("Settings are outside PaperS3 limits"),
            save_settings.index("nvs_open"),
        )

        load_collections = storage.split("bool loadCollections", 1)[1].split(
            "bool saveCollections", 1
        )[0]
        self.assertIn("recoverDefaults", load_collections)
        self.assertIn("invalid stored collection size", load_collections)
        self.assertIn("invalid stored collection JSON", load_collections)
        self.assertIn("error.clear()", load_collections)
        self.assertIn("return true", load_collections)

    def test_app_flash_preserves_nvs_and_home_activation_is_commit_last(self) -> None:
        project = DEFAULT_ARCHIVE.parents[2]
        app_flash = (project / "build" / "flash_app_args").read_text().splitlines()
        payload_rows = [row.strip() for row in app_flash if row.strip().startswith("0x")]
        self.assertEqual(payload_rows, ["0x20000 inkos_papers3_idf.bin"])

        with (project / "partitions.csv").open(newline="") as source:
            rows = [
                row
                for row in csv.reader(source)
                if row and not row[0].lstrip().startswith("#")
            ]
        partitions = {row[0].strip(): row for row in rows}
        self.assertEqual(partitions["nvs"][3].strip().lower(), "0x9000")
        self.assertEqual(partitions["factory"][3].strip().lower(), "0x20000")

        storage = (DEFAULT_ARCHIVE.parents[1] / "device_storage.cpp").read_text()
        finish = storage.split("bool finishHomeUpload", 1)[1].split(
            "void abortHomeUpload", 1
        )[0]
        self.assertLess(finish.index("ulTaskNotifyTake"), finish.index("writeHomeRecord"))
        self.assertLess(finish.index("if (!verified)"), finish.index("writeHomeRecord"))
        self.assertLess(finish.index("writeHomeRecord"), finish.index("signalHomeChanged"))
        begin = storage.split("bool beginHomeUpload", 1)[1].split(
            "bool appendHomeUpload", 1
        )[0]
        self.assertIn("present && current.slot == 'a' ? 'b' : 'a'", begin)

    def test_management_inputs_are_strict_bounded_and_validated_before_commit(self) -> None:
        main = DEFAULT_ARCHIVE.parents[1]
        safe_json = (main / "include" / "safe_json.h").read_text()
        wifi = (main / "wifi.cpp").read_text()
        storage = (main / "device_storage.cpp").read_text()

        self.assertIn("for (size_t index = 0; index < json.size(); ++index)", safe_json)
        self.assertIn("if (++depth > maximumDepth) return nullptr", safe_json)
        self.assertIn("json[index + 4] == '0'", safe_json)
        self.assertIn("cJSON_ParseWithLengthOpts", safe_json)
        self.assertIn("json.size() + 1", safe_json)
        self.assertIn("true);", safe_json)
        self.assertNotIn("cJSON_ParseWithLength(", wifi)
        self.assertNotIn("cJSON_ParseWithLength(", storage)
        self.assertIn("parseStrictBoundedJson(body, 8)", wifi)
        self.assertIn("parseStrictBoundedJson(json, 16)", storage)

        form_parser = wifi.split("bool parseForm", 1)[1].split(
            "bool unsafeTextValue", 1
        )[0]
        self.assertIn("allowedFields", form_parser)
        self.assertIn("result.emplace", form_parser)
        self.assertIn("name.find('\\0')", form_parser)
        self.assertIn("decodedValue.find('\\0')", form_parser)
        self.assertNotIn("result[", form_parser)

        save_form = wifi.split("esp_err_t saveHandler", 1)[1].split(
            "esp_err_t resetHandler", 1
        )[0]
        self.assertIn('parseForm(body, {"ssid", "password", "server"}', save_form)
        self.assertIn("unsafeTextValue(ssid->second, 32, false)", save_form)
        self.assertLess(save_form.index("parseForm"), save_form.index("saveSettings"))
        self.assertIn('"422 Unprocessable Entity"', save_form)

        collections_form = wifi.split(
            "esp_err_t collectionsFormHandler", 1
        )[1].split("esp_err_t apiStateHandler", 1)[0]
        self.assertIn(
            'parseForm(body, {"rss", "websites", "images"}', collections_form
        )
        self.assertLess(
            collections_form.index("parseForm"),
            collections_form.index("saveCollections"),
        )

        settings_api = wifi.split("esp_err_t apiSettingsPutHandler", 1)[1].split(
            "esp_err_t apiHomePutHandler", 1
        )[0]
        self.assertIn("unknownOrDuplicate", settings_api)
        self.assertIn("unsafeTextValue(ssid->valuestring, 32, false)", settings_api)
        self.assertLess(
            settings_api.index("unknownOrDuplicate"),
            settings_api.index("saveSettings"),
        )

        trim = wifi.split("std::string trim", 1)[1].split(
            "bool addCollectionLines", 1
        )[0]
        self.assertIn("return value.substr(begin, end - begin)", trim)
        self.assertNotIn("erase(value.begin())", trim)
        station = wifi.split("bool connectStation", 1)[1].split(
            "bool wifiConnected", 1
        )[0]
        ssid_copy = station.split("std::copy_n(settings.wifiSsid.begin()", 1)[1].split(
            "std::copy_n(settings.wifiPassword.begin()", 1
        )[0]
        self.assertIn("sizeof(config.sta.ssid)", ssid_copy)
        self.assertNotIn("sizeof(config.sta.ssid) - 1", ssid_copy)

        entries = storage.split("bool parseEntries", 1)[1].split(
            "bool parseCollectionsJsonImpl", 1
        )[0]
        self.assertIn("bool sawId = false", entries)
        self.assertIn("bool sawLabel = false", entries)
        self.assertIn("bool sawUrl = false", entries)
        self.assertIn("unknown or duplicate entry field", entries)
        collection_url = storage.split("bool validCollectionAuthority", 1)[1].split(
            "std::string generatedIdForName", 1
        )[0]
        self.assertIn("inet_pton(AF_INET6", collection_url)
        self.assertIn("byte == 0x7f", collection_url)
        self.assertIn('remainder.empty() || remainder == ":443"', collection_url)

    def test_native_device_ui_does_not_enlarge_16px_bitmap_fonts(self) -> None:
        display = (DEFAULT_ARCHIVE.parents[1] / "display.cpp").read_text()
        status = display.split("void PaperS3Display::showStatus", 1)[1].split(
            "void PaperS3Display::showSettings", 1
        )[0]
        settings = display.split("void PaperS3Display::showSettings", 1)[1].split(
            "void PaperS3Display::showPortal", 1
        )[0]
        self.assertNotIn("efontCN_16", status)
        self.assertNotIn("efontCN_16", settings)
        self.assertIn("efontCN_24", status)
        self.assertIn("efontCN_24_b", settings)
        self.assertIn("kUiBorderWidth = 3", display)


if __name__ == "__main__":
    unittest.main()
