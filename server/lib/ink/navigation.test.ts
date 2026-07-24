import { describe, expect, it } from "vitest";

import { inkFrameSidecarSchema, type InkHitbox } from "./contracts";
import { hitTest, navigateInk, type InkNavigationState } from "./navigation";

const ROOT = "00000000-0000-4000-8000-000000000001";
const CHILD = "00000000-0000-4000-8000-000000000002";

function sidecar(pageIndex = 0, pageCount = 3, parentUuid?: string) {
  return inkFrameSidecarSchema.parse({
    schemaVersion: "inkos.frame-sidecar/v1",
    packageId: "00000000-0000-4000-8000-000000000099",
    documentUuid: CHILD,
    parentUuid,
    variantId: "paper.portrait.normal.font-p0",
    pageIndex,
    pageCount,
    imagePath: `frames/child/${pageIndex}.png`,
    imageSha256: "a".repeat(64),
    logicalSize: { width: 540, height: 960 },
    interactions: [],
  });
}

function state(pageIndex = 0): InkNavigationState {
  return { documentUuid: CHILD, pageIndex, history: [] };
}

describe("Ink navigation gesture contract", () => {
  it("moves up to the next rendered page and stops at the final page", () => {
    const next = navigateInk(state(0), sidecar(0), { type: "swipe-up" });
    expect(next).toMatchObject({ changed: true, reason: "next-page", state: { pageIndex: 1 } });

    const end = navigateInk(state(2), sidecar(2), { type: "swipe-up" });
    expect(end).toMatchObject({ changed: false, reason: "end", state: { pageIndex: 2 } });
  });

  it("moves down to the previous page, then down at page zero opens the parent", () => {
    const previous = navigateInk(state(2), sidecar(2, 3, ROOT), { type: "swipe-down" });
    expect(previous).toMatchObject({ changed: true, reason: "previous-page", state: { pageIndex: 1 } });

    const parent = navigateInk(state(0), sidecar(0, 3, ROOT), { type: "swipe-down" });
    expect(parent).toMatchObject({ changed: true, reason: "parent", state: { documentUuid: ROOT, pageIndex: 0 } });
  });

  it("opens the parent on a left swipe from any page", () => {
    const parent = navigateInk(state(2), sidecar(2, 3, ROOT), { type: "swipe-left" });
    expect(parent).toMatchObject({ changed: true, reason: "parent", state: { documentUuid: ROOT, pageIndex: 0 } });
  });

  it("does not leave a root document", () => {
    expect(navigateInk(state(0), sidecar(0), { type: "swipe-left" })).toMatchObject({
      changed: false,
      reason: "root",
    });
    expect(navigateInk(state(0), sidecar(0), { type: "swipe-down" })).toMatchObject({
      changed: false,
      reason: "root",
    });
  });

  it("restores the parent's prior page from history", () => {
    const withHistory: InkNavigationState = {
      documentUuid: CHILD,
      pageIndex: 0,
      history: [{ documentUuid: ROOT, pageIndex: 4 }],
    };
    const result = navigateInk(withHistory, sidecar(0, 1, ROOT), { type: "swipe-left" });
    expect(result.state).toEqual({ documentUuid: ROOT, pageIndex: 4, history: [] });
  });

  it("rejects a stale sidecar instead of navigating the wrong frame", () => {
    expect(() => navigateInk(state(1), sidecar(0), { type: "swipe-up" })).toThrow(/active frame/u);
  });
});

describe("Ink link hit testing", () => {
  const hitboxes: InkHitbox[] = [
    { id: "large", contentPath: "page.items[0]", bounds: { x: 10, y: 10, width: 100, height: 100 }, targetUuid: ROOT },
    { id: "small", contentPath: "page.items[0].image", bounds: { x: 20, y: 20, width: 20, height: 20 }, targetUuid: "00000000-0000-4000-8000-000000000003" },
  ];

  it("uses half-open bounds and the smallest overlapping target", () => {
    expect(hitTest(hitboxes, 20, 20)?.id).toBe("small");
    expect(hitTest(hitboxes, 109, 109)?.id).toBe("large");
    expect(hitTest(hitboxes, 110, 110)).toBeUndefined();
  });

  it("opens the linked UUID at page zero and records the source visit", () => {
    const active = sidecar(2, 3, ROOT);
    active.interactions.push(hitboxes[0]);
    const result = navigateInk(state(2), active, { type: "tap", x: 12, y: 12 });
    expect(result).toMatchObject({
      changed: true,
      reason: "linked-document",
      state: {
        documentUuid: ROOT,
        pageIndex: 0,
        history: [{ documentUuid: CHILD, pageIndex: 2 }],
      },
    });
  });
});
