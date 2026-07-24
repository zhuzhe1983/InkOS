import { afterEach, describe, expect, it, vi } from "vitest";

import type { InkDynamicRegion } from "@/lib/ink/contracts";

import {
  clockTextPlacement,
  estimateServerTimeOffset,
  fetchServerTimeOffset,
  formatClockTime,
  startAlignedClock,
} from "./clock-runtime";

const REGION: InkDynamicRegion = {
  id: "clock-main",
  kind: "clock",
  bounds: { x: 20, y: 100, width: 500, height: 44 },
  format: "HH:mm:ss",
  timezone: "Asia/Shanghai",
  refreshMs: 1_000,
  fullRefreshEvery: 60,
  style: {
    fontFamily: "monospace",
    fontSize: 36,
    fontWeight: 700,
    textAlign: "center",
    verticalAlign: "middle",
    foreground: "black",
    background: "white",
  },
};

afterEach(() => {
  vi.useRealTimers();
});

describe("PaperS3 local clock runtime", () => {
  it("estimates server offset at the request RTT midpoint", () => {
    expect(estimateServerTimeOffset(1_000, 1_100, 2_050)).toBe(1_000);
    expect(() => estimateServerTimeOffset(1_100, 1_000, 2_050)).toThrow(/predates/u);
  });

  it("requests an uncached server sample and applies the measured RTT", async () => {
    const now = vi.fn()
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_100);
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      schemaVersion: "inkos.time/v1",
      serverUnixMs: 2_050,
      timezone: "Asia/Shanghai",
      serverIso: "1970-01-01T08:00:02.050+08:00",
    }));

    await expect(fetchServerTimeOffset(fetcher, undefined, now)).resolves.toBe(1_000);
    expect(fetcher).toHaveBeenCalledWith("/api/ink/v1/time", expect.objectContaining({
      cache: "no-store",
    }));
  });

  it("formats a fixed 24-hour Shanghai clock without locale punctuation", () => {
    expect(formatClockTime(
      Date.parse("2026-07-18T06:07:08.123Z"),
      "Asia/Shanghai",
      "HH:mm:ss",
    )).toBe("14:07:08");
  });

  it("uses verified logical bounds for SVG placement", () => {
    expect(clockTextPlacement(REGION)).toEqual({
      x: 270,
      y: 122,
      textAnchor: "middle",
      dominantBaseline: "central",
    });
  });

  it("aligns to whole seconds, resets on update 60 and cancels cleanly", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T06:07:08.250Z"));
    const ticks: Array<{ updateCount: number; visualReset: boolean }> = [];
    const stop = startAlignedClock(REGION, 0, ({ updateCount, visualReset }) => {
      ticks.push({ updateCount, visualReset });
    });

    expect(ticks).toEqual([{ updateCount: 0, visualReset: false }]);
    await vi.advanceTimersByTimeAsync(749);
    expect(ticks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(ticks.at(-1)).toEqual({ updateCount: 1, visualReset: false });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(ticks.at(-1)).toEqual({ updateCount: 60, visualReset: true });

    stop();
    const tickCount = ticks.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ticks).toHaveLength(tickCount);
    expect(vi.getTimerCount()).toBe(0);
  });
});
