import { describe, expect, it } from "vitest";

import { GET, paperS3Manifest } from "./route";

describe("PaperS3 installable app manifest", () => {
  it("launches the client in control-free fullscreen mode", async () => {
    expect(paperS3Manifest).toMatchObject({
      id: "/papers3-client",
      start_url: "/papers3-client?fullscreen=1",
      scope: "/papers3-client",
      display: "fullscreen",
      display_override: ["fullscreen", "standalone"],
      orientation: "any",
    });
    expect(paperS3Manifest.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ sizes: "192x192" }),
      expect.objectContaining({ sizes: "512x512", purpose: "maskable" }),
    ]));

    const response = GET();
    expect(response.headers.get("content-type")).toContain("application/manifest+json");
    await expect(response.json()).resolves.toMatchObject({ display: "fullscreen" });
  });
});
