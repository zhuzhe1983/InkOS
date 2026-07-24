import { describe, expect, it } from "vitest";

import { inkTimeResponseSchema } from "@/lib/ink/service-contracts";

import { handleTime } from "./route";

describe("GET /api/ink/v1/time", () => {
  it("returns no-store server OS time with explicit Shanghai and HTTP dates", async () => {
    const now = new Date("2026-07-18T06:07:08.123Z");
    const response = handleTime({ now: () => now });
    const body = inkTimeResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Pragma")).toBe("no-cache");
    expect(response.headers.get("Date")).toBe("Sat, 18 Jul 2026 06:07:08 GMT");
    expect(body).toEqual({
      schemaVersion: "inkos.time/v1",
      serverUnixMs: 1_784_354_828_123,
      timezone: "Asia/Shanghai",
      serverIso: "2026-07-18T14:07:08.123+08:00",
    });
  });
});
