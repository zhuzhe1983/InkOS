#!/usr/bin/env python3
"""Verify the PaperS3 EPD completion-ticket contract.

The production driver is ESP-IDF/ESP32-S3-specific, so this host test combines
wraparound/queue-merge model checks with focused source-contract checks.  It
does not import, modify, or execute the embedded-home verification tooling.
"""

from __future__ import annotations

import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
HEADER = (
    ROOT
    / "managed_components"
    / "m5stack__m5gfx"
    / "src"
    / "lgfx"
    / "v1"
    / "platforms"
    / "esp32"
    / "Panel_EPD.hpp"
)
SOURCE = HEADER.with_suffix(".cpp")
UINT32_MASK = (1 << 32) - 1
HALF_RANGE = 1 << 31


def ticket_reached(settled: int, target: int) -> bool:
    return ((settled - target) & UINT32_MASK) < HALF_RANGE


def ticket_newer(candidate: int, reference: int) -> bool:
    distance = (candidate - reference) & UINT32_MASK
    return distance != 0 and distance < HALF_RANGE


def function_body(source: str, signature: str) -> str:
    start = source.index(signature)
    opening = source.index("{", start)
    depth = 0
    for offset in range(opening, len(source)):
        character = source[offset]
        if character == "{":
            depth += 1
        elif character == "}":
            depth -= 1
            if depth == 0:
                return source[opening + 1 : offset]
    raise AssertionError(f"unterminated function: {signature}")


class CompletionTicketTest(unittest.TestCase):
    def test_wraparound_order_uses_half_range(self) -> None:
        self.assertTrue(ticket_reached(0, 0))
        self.assertTrue(ticket_reached(7, 6))
        self.assertFalse(ticket_reached(6, 7))
        self.assertTrue(ticket_reached(0, UINT32_MASK))
        self.assertTrue(ticket_reached(1, UINT32_MASK))
        self.assertFalse(ticket_reached(UINT32_MASK, 0))

        self.assertTrue(ticket_newer(UINT32_MASK, UINT32_MASK - 1))
        self.assertTrue(ticket_newer(0, UINT32_MASK))
        self.assertTrue(ticket_newer(1, 0))
        self.assertFalse(ticket_newer(UINT32_MASK, 0))
        self.assertFalse(ticket_newer(9, 9))

    def test_same_region_merge_keeps_latest_ticket(self) -> None:
        active = UINT32_MASK - 1
        for candidate in (UINT32_MASK, 0, 1):
            if ticket_newer(candidate, active):
                active = candidate
        self.assertEqual(active, 1)
        self.assertTrue(ticket_reached(active, UINT32_MASK))
        self.assertTrue(ticket_reached(active, 0))
        self.assertTrue(ticket_reached(active, 1))

    def test_failed_send_does_not_publish_an_unreachable_ticket(self) -> None:
        submitted = 41
        allocated = 42
        send_succeeded = False
        if send_succeeded and ticket_newer(allocated, submitted):
            submitted = allocated
        self.assertEqual(submitted, 41)
        self.assertTrue(ticket_reached(41, submitted))

    def test_production_source_implements_the_contract(self) -> None:
        header = HEADER.read_text()
        source = SOURCE.read_text()

        self.assertIn("uint32_t ticket;", header)
        self.assertIn("sameRegionAndMode", header)
        self.assertIn("std::atomic<uint32_t> _next_ticket { 1 };", header)
        self.assertIn("std::atomic<uint32_t> _submitted_ticket { 0 };", header)
        self.assertIn("std::atomic<uint32_t> _settled_ticket { 0 };", header)
        self.assertNotIn("_display_busy", header)
        self.assertNotIn("_display_busy", source)
        self.assertIn("0x80000000u", source)

        wait_body = function_body(source, "void Panel_EPD::waitDisplay(void)")
        self.assertIn("_submitted_ticket.load(std::memory_order_acquire)", wait_body)
        self.assertIn("_settled_ticket.load(std::memory_order_acquire)", wait_body)
        self.assertIn("ticketReached", wait_body)

        busy_body = function_body(source, "bool Panel_EPD::displayBusy(void)")
        self.assertIn("_submitted_ticket.load(std::memory_order_acquire)", busy_body)
        self.assertIn("_settled_ticket.load(std::memory_order_acquire)", busy_body)
        self.assertIn("return !ticketReached(settled, submitted);", busy_body)

        display_wrapper = function_body(
            source,
            "void Panel_EPD::display(uint_fast16_t x, uint_fast16_t y, "
            "uint_fast16_t w, uint_fast16_t h)",
        )
        self.assertIn("_display(x, y, w, h, false)", display_wrapper)
        endpoint_wrapper = function_body(
            source, "void Panel_EPD::displayEndpointReinforcement("
        )
        self.assertIn("_display(x, y, w, h, true)", endpoint_wrapper)
        display_body = function_body(
            source,
            "void Panel_EPD::_display(uint_fast16_t x, uint_fast16_t y,",
        )
        self.assertIn("_next_ticket.fetch_add(1, std::memory_order_relaxed)", display_body)
        success_body = display_body.split("if (res)", 1)[1]
        self.assertIn(
            "publishNewerTicket(_submitted_ticket, upd.ticket)", success_body
        )
        self.assertNotIn(
            "publishNewerTicket(_submitted_ticket, upd.ticket)",
            display_body.split("if (res)", 1)[0],
        )
        self.assertNotIn(
            "_range_mod.top    = INT16_MAX",
            display_body.split("if (res)", 1)[0],
        )

        worker_body = function_body(
            source, "void Panel_EPD::task_update(Panel_EPD* me)"
        )
        self.assertIn("new_data.sameRegionAndMode(candidate)", worker_body)
        self.assertIn("new_data.ticket = candidate.ticket", worker_body)
        self.assertIn("ticketNewer(new_data.ticket, active_ticket)", worker_body)
        settled_body = function_body(worker_body, "if (remain == false)")
        self.assertIn(
            "publishNewerTicket(me->_settled_ticket, active_ticket)",
            settled_body,
        )


if __name__ == "__main__":
    unittest.main()
