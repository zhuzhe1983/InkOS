import { describe, expect, it, vi } from "vitest";

import {
  PAPERS3_HOME_ENTRY_UUID,
  PAPERS3_HOME_PACKAGE_ID,
} from "@/lib/ink/builtin/papers3-home";
import type { InkCatalogEntry } from "@/lib/ink/catalog-store";

import { handlePackageCatalog } from "./route";

const HOME_ENTRY: InkCatalogEntry = {
  packageId: PAPERS3_HOME_PACKAGE_ID,
  revision: 20260716,
  title: "InkOS PaperS3 应用 · 2026 年 7 月",
  entryUuid: PAPERS3_HOME_ENTRY_UUID,
  fileName: "papers3-home-2026-07-16-r20260716.ink",
  bytes: 1_664_872,
  sha256: "a".repeat(64),
  manifestUrl: `/api/ink/v1/packages/${PAPERS3_HOME_PACKAGE_ID}/manifest`,
  downloadUrl: `/api/ink/v1/packages/${PAPERS3_HOME_PACKAGE_ID}/download`,
};

const OTHER_ENTRY: InkCatalogEntry = {
  packageId: "10000000-0000-4000-8000-000000000099",
  revision: 6,
  title: "Other package",
  entryUuid: "10000000-0000-4000-8000-000000000001",
  fileName: "other-r6.ink",
  bytes: 1234,
  sha256: "b".repeat(64),
  manifestUrl: "/api/ink/v1/packages/10000000-0000-4000-8000-000000000099/manifest",
  downloadUrl: "/api/ink/v1/packages/10000000-0000-4000-8000-000000000099/download",
};

describe("GET /api/ink/v1/packages", () => {
  it("publishes an explicit verified home and never makes clients infer it from storage order", async () => {
    const events: string[] = [];
    const ensureHome = vi.fn(async () => {
      events.push("ensure");
    });
    const listPackages = vi.fn(async () => {
      events.push("list");
      return [OTHER_ENTRY, HOME_ENTRY];
    });
    const request = new Request("http://localhost/api/ink/v1/packages");
    const response = await handlePackageCatalog(request, { ensureHome, listPackages });
    const body = await response.json() as {
      schemaVersion: string;
      defaultPackageId: string;
      defaultEntryUuid: string;
      packages: InkCatalogEntry[];
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=15, must-revalidate");
    expect(response.headers.get("ETag")).toMatch(/^"[a-f0-9]{64}"$/u);
    expect(events).toEqual(["ensure", "list"]);
    expect(body).toMatchObject({
      schemaVersion: "inkos.package-catalog/v1",
      defaultPackageId: PAPERS3_HOME_PACKAGE_ID,
      defaultEntryUuid: PAPERS3_HOME_ENTRY_UUID,
    });
    expect(body.packages[0]).toEqual(HOME_ENTRY);
    expect(body.packages.find((entry) => entry.packageId === body.defaultPackageId)?.entryUuid)
      .toBe(body.defaultEntryUuid);

    const notModified = await handlePackageCatalog(new Request(request.url, {
      headers: { "If-None-Match": response.headers.get("ETag")! },
    }), { ensureHome, listPackages });
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");
  });

  it("does not advertise a dangling default when verified home publication is absent", async () => {
    const response = await handlePackageCatalog(
      new Request("http://localhost/api/ink/v1/packages"),
      {
        ensureHome: async () => undefined,
        listPackages: async () => [OTHER_ENTRY],
      },
    );
    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      code: "INTERNAL_ERROR",
      detail: "Verified PaperS3 home package is missing from the catalog",
    });
  });
});
