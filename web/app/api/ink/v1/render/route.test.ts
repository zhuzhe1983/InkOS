import { describe, expect, it } from "vitest";

import { POST } from "./route";

const ROOT = "20000000-0000-4000-8000-000000000001";
const CHILD = "20000000-0000-4000-8000-000000000002";

function input() {
  return {
    profileId: "m5stack-paper-s3-portrait",
    document: {
      schemaVersion: "inkos.document/v1",
      uuid: ROOT,
      source: { title: "目录" },
      content: {
        schemaVersion: "inkos.content/v2",
        id: ROOT,
        revision: 1,
        locale: "zh-CN",
        page: {
          kind: "list",
          layout: "list",
          title: "目录",
          items: [{
            id: "child",
            title: "子页面",
            link: { label: "打开", target: { kind: "document", documentId: CHILD } },
          }],
        },
      },
    },
  };
}

describe("POST /api/ink/v1/render", () => {
  it("returns a PNG and the same offline-compatible sidecar model", async () => {
    const response = await POST(new Request("http://localhost/api/ink/v1/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input()),
    }));
    const body = new Uint8Array(await response.arrayBuffer());
    const encodedSidecar = response.headers.get("X-Ink-Sidecar")!;
    const sidecar = JSON.parse(Buffer.from(encodedSidecar, "base64url").toString("utf8"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("X-Ink-Refresh-Hint")).toBe("binary-text");
    expect(response.headers.get("Access-Control-Expose-Headers"))
      .toContain("X-Ink-Refresh-Hint");
    expect(body.subarray(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(sidecar).toMatchObject({
      schemaVersion: "inkos.frame-sidecar/v1",
      documentUuid: ROOT,
      pageIndex: 0,
      interactions: [expect.objectContaining({ targetUuid: CHILD })],
    });
  });

  it("uses problem+json for invalid protocol input", async () => {
    const invalid = input();
    invalid.document.uuid = "20000000-0000-4000-8000-00000000000A";
    const response = await POST(new Request("http://localhost/api/ink/v1/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(invalid),
    }));
    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Type")).toContain("application/problem+json");
    expect(await response.json()).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("rejects retired inverse rendering", async () => {
    const inverse = { ...input(), displayMeta: { invert: true } };
    const response = await POST(new Request("http://localhost/api/ink/v1/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(inverse),
    }));

    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Type")).toContain("application/problem+json");
    expect(await response.json()).toMatchObject({ code: "INVALID_REQUEST" });
  });
});
