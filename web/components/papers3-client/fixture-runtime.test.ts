import { describe, expect, it } from "vitest";

import { FixtureInkRuntimeAdapter } from "./fixture-runtime";
import { PAPER_S3_FRAME_SIZE } from "./runtime-adapter";

const baseDisplay = { orientation: "portrait" as const, fontLevel: 0 as const, invert: false };

describe("PaperS3 fixture runtime adapter", () => {
  it("returns renderer-owned 540 x 960 frames and in-bounds hitboxes", async () => {
    const runtime = new FixtureInkRuntimeAdapter();
    const root = await runtime.open({
      uuid: runtime.getRootUuid("offline"),
      pageIndex: 0,
      sourceMode: "offline",
      display: baseDisplay,
    });

    expect(root.page.pixelSize).toEqual(PAPER_S3_FRAME_SIZE);
    expect(root.page.imageUrl).toMatch(/^data:image\/svg\+xml/);
    expect(root.page.linkHitboxes).toHaveLength(3);

    for (const link of root.page.linkHitboxes) {
      expect(link.targetUuid).toMatch(/^ink-demo:/);
      expect(link.bounds.x).toBeGreaterThanOrEqual(0);
      expect(link.bounds.y).toBeGreaterThanOrEqual(0);
      expect(link.bounds.x + link.bounds.width).toBeLessThanOrEqual(PAPER_S3_FRAME_SIZE.width);
      expect(link.bounds.y + link.bounds.height).toBeLessThanOrEqual(PAPER_S3_FRAME_SIZE.height);
    }
  });

  it("distinguishes verified online and offline source descriptors", async () => {
    const runtime = new FixtureInkRuntimeAdapter();
    const uuid = runtime.getRootUuid("online");
    const [online, offline] = await Promise.all([
      runtime.open({ uuid, pageIndex: 0, sourceMode: "online", display: baseDisplay }),
      runtime.open({ uuid, pageIndex: 0, sourceMode: "offline", display: baseDisplay }),
    ]);

    expect(online.source).toMatchObject({ mode: "online", verified: true });
    expect(offline.source).toMatchObject({
      mode: "offline",
      packageFilename: "nook-demo.ink",
      verified: true,
    });
  });

  it("selects distinct pre-rendered frame variants for font settings and ignores retired invert input", async () => {
    const runtime = new FixtureInkRuntimeAdapter();
    const uuid = runtime.getRootUuid("offline");
    const normal = await runtime.open({ uuid, pageIndex: 0, sourceMode: "offline", display: baseDisplay });
    const adjusted = await runtime.open({
      uuid,
      pageIndex: 0,
      sourceMode: "offline",
      display: { orientation: "portrait", fontLevel: 2, invert: true },
    });
    const adjustedNormal = await runtime.open({
      uuid,
      pageIndex: 0,
      sourceMode: "offline",
      display: { orientation: "portrait", fontLevel: 2, invert: false },
    });

    expect(adjusted.page.imageUrl).not.toBe(normal.page.imageUrl);
    expect(adjusted.page.imageUrl).toBe(adjustedNormal.page.imageUrl);
  });

  it("clamps page indexes and rejects unknown UUIDs", async () => {
    const runtime = new FixtureInkRuntimeAdapter();
    const detailUuid = "ink-demo:nook:first-generation";
    const last = await runtime.open({
      uuid: detailUuid,
      pageIndex: 99,
      sourceMode: "offline",
      display: baseDisplay,
    });

    expect(last.page.index).toBe(last.page.count - 1);
    await expect(runtime.open({
      uuid: "missing",
      pageIndex: 0,
      sourceMode: "offline",
      display: baseDisplay,
    })).rejects.toThrow("不存在");
  });
});
