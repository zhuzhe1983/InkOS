import { describe, expect, it } from "vitest";

import {
  hitboxAt,
  intentFromKeyboard,
  intentFromReleasedPaperS3Swipe,
  intentFromSwipe,
  PAPERS3_SWIPE_DOMINANCE_RATIO,
  PAPERS3_SWIPE_MAX_DURATION_MS,
  PAPERS3_SWIPE_MIN_DISTANCE_PX,
  PAPERS3_SWIPE_MIN_DURATION_MS,
  PAPERS3_SWIPE_SHORT_EDGE_RATIO,
  requestsPreviousLayer,
  resolveNavigation,
} from "./navigation";
import type { InkLinkHitbox, InkRuntimeView } from "./runtime-adapter";

function viewAt(pageIndex: number, pageCount = 3, parentUuid: string | null = "parent-uuid") {
  return {
    document: { parentUuid: parentUuid ?? undefined },
    page: { index: pageIndex, count: pageCount },
  } as Pick<InkRuntimeView, "document" | "page">;
}

describe("PaperS3 navigation rules", () => {
  it("maps the three directional swipes without treating right swipe as navigation", () => {
    expect(intentFromSwipe({ x: 200, y: 200 }, { x: 120, y: 202 })).toBe("parent");
    expect(intentFromSwipe({ x: 200, y: 200 }, { x: 202, y: 120 })).toBe("next-page");
    expect(intentFromSwipe({ x: 200, y: 200 }, { x: 202, y: 280 })).toBe("previous-page-or-parent");
    expect(intentFromSwipe({ x: 200, y: 200 }, { x: 280, y: 200 })).toBeNull();
  });

  it("ignores short or ambiguous diagonal movement", () => {
    expect(intentFromSwipe({ x: 100, y: 100 }, { x: 70, y: 100 })).toBeNull();
    expect(intentFromSwipe({ x: 100, y: 100 }, { x: 30, y: 35 })).toBeNull();
  });

  it("uses the device-aligned defaults of 56 logical pixels and 1.4 axis dominance", () => {
    expect(PAPERS3_SWIPE_MIN_DISTANCE_PX).toBe(56);
    expect(PAPERS3_SWIPE_DOMINANCE_RATIO).toBe(1.4);
    expect(intentFromSwipe({ x: 100, y: 100 }, { x: 44, y: 100 })).toBe("parent");
    expect(intentFromSwipe({ x: 100, y: 100 }, { x: 44, y: 140 })).toBe("parent");
    expect(intentFromSwipe({ x: 100, y: 100 }, { x: 44, y: 141 })).toBeNull();
  });

  it("commits a PaperS3 swipe only on release within 60ms–2s and over 10% of the short edge", () => {
    expect(PAPERS3_SWIPE_MIN_DURATION_MS).toBe(60);
    expect(PAPERS3_SWIPE_MAX_DURATION_MS).toBe(2_000);
    expect(PAPERS3_SWIPE_SHORT_EDGE_RATIO).toBe(0.1);

    const start = { x: 200, y: 500 };
    expect(intentFromReleasedPaperS3Swipe(start, { x: 200, y: 440 }, {
      durationMs: 60,
      shortEdge: 540,
    })).toBe("next-page");
    expect(intentFromReleasedPaperS3Swipe(start, { x: 200, y: 444 }, {
      durationMs: 59,
      shortEdge: 540,
    })).toBeNull();
    expect(intentFromReleasedPaperS3Swipe(start, { x: 200, y: 440 }, {
      durationMs: 2_001,
      shortEdge: 540,
    })).toBeNull();
    expect(intentFromReleasedPaperS3Swipe(start, { x: 200, y: 140 }, {
      durationMs: 250,
      shortEdge: 4_000,
    })).toBeNull();
  });

  it("pages normally before the boundaries, then resolves either boundary to the parent", () => {
    expect(resolveNavigation("next-page", viewAt(0))).toEqual({ kind: "open-page", pageIndex: 1 });
    expect(resolveNavigation("next-page", viewAt(2))).toEqual({
      kind: "open-parent",
      uuid: "parent-uuid",
    });
    expect(resolveNavigation("previous-page-or-parent", viewAt(2))).toEqual({ kind: "open-page", pageIndex: 1 });
    expect(resolveNavigation("previous-page-or-parent", viewAt(0))).toEqual({
      kind: "open-parent",
      uuid: "parent-uuid",
    });
  });

  it("safely stays at either boundary of a root without a parent", () => {
    expect(resolveNavigation("next-page", viewAt(2, 3, null))).toEqual({
      kind: "none",
      reason: "last-page",
    });
    expect(resolveNavigation("parent", viewAt(0, 1, null))).toEqual({ kind: "none", reason: "root" });
    expect(resolveNavigation("previous-page-or-parent", viewAt(0, 1, null))).toEqual({
      kind: "none",
      reason: "first-page",
    });
  });

  it("identifies every action that should restore browser source history", () => {
    expect(requestsPreviousLayer("next-page", viewAt(0))).toBe(false);
    expect(requestsPreviousLayer("next-page", viewAt(2))).toBe(true);
    expect(requestsPreviousLayer("previous-page-or-parent", viewAt(2))).toBe(false);
    expect(requestsPreviousLayer("previous-page-or-parent", viewAt(0))).toBe(true);
    expect(requestsPreviousLayer("parent", viewAt(1))).toBe(true);
  });

  it("provides keyboard equivalents for every gesture", () => {
    expect(intentFromKeyboard("ArrowLeft")).toBe("parent");
    expect(intentFromKeyboard("Escape")).toBe("parent");
    expect(intentFromKeyboard("ArrowUp")).toBe("next-page");
    expect(intentFromKeyboard("PageDown")).toBe("next-page");
    expect(intentFromKeyboard("ArrowDown")).toBe("previous-page-or-parent");
    expect(intentFromKeyboard("PageUp")).toBe("previous-page-or-parent");
    expect(intentFromKeyboard("Enter")).toBeNull();
  });

  it("selects a photo hitbox inside a linked card by smallest area and keeps sidecar order on ties", () => {
    const card = {
      id: "card",
      label: "Open article",
      targetUuid: "10000000-0000-4000-8000-000000000001",
      bounds: { x: 10, y: 10, width: 300, height: 160 },
    } satisfies InkLinkHitbox;
    const image = {
      id: "image",
      label: "Open image",
      targetUuid: "10000000-0000-4000-8000-000000000002",
      bounds: { x: 20, y: 20, width: 90, height: 90 },
    } satisfies InkLinkHitbox;
    const equal = { ...image, id: "equal", targetUuid: "10000000-0000-4000-8000-000000000003" };

    expect(hitboxAt({ x: 30, y: 30 }, [card, image])).toBe(image);
    expect(hitboxAt({ x: 200, y: 80 }, [card, image])).toBe(card);
    expect(hitboxAt({ x: 30, y: 30 }, [card, image, equal])).toBe(image);
    expect(hitboxAt({ x: 310, y: 170 }, [card])).toBeUndefined();
  });
});
