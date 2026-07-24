import { describe, expect, it } from "vitest";

import {
  INKOS_CLIENT_APP_URLS,
  INKOS_CLIENT_COLLECTION_URLS,
  INKOS_LEGACY_CLIENT_COLLECTION_URLS,
  contentDocumentSchema,
  contentImageSchema,
} from "../rendering/contracts";
import { inkFrameSidecarSchema } from "./contracts";
import { sourceResolveRequestSchema } from "./generator/source-resolver";

const DOCUMENT_UUID = "40000000-0000-4000-8000-000000000001";
const PACKAGE_UUID = "40000000-0000-4000-8000-000000000002";
const SHA256 = "0".repeat(64);

function semanticLink(targetUrl: string) {
  return {
    schemaVersion: "inkos.content/v2",
    id: DOCUMENT_UUID,
    revision: 1,
    locale: "zh-CN",
    page: {
      kind: "list",
      layout: "grid",
      title: "设备集合",
      items: [{
        id: "collection",
        title: "打开集合",
        link: {
          label: "打开集合",
          target: { kind: "url", url: targetUrl },
        },
      }],
    },
  };
}

function sidecar(targetUrl: string) {
  return {
    schemaVersion: "inkos.frame-sidecar/v1",
    packageId: PACKAGE_UUID,
    documentUuid: DOCUMENT_UUID,
    variantId: "paper-s3-portrait",
    pageIndex: 0,
    pageCount: 1,
    imagePath: "frames/page.png",
    imageSha256: SHA256,
    logicalSize: { width: 540, height: 960 },
    interactions: [{
      id: "page.items[0].link",
      contentPath: "page.items[0].link",
      label: "打开集合",
      bounds: { x: 20, y: 20, width: 240, height: 120 },
      targetUuid: DOCUMENT_UUID,
      targetUrl,
    }],
  };
}

describe("reserved client collection links", () => {
  it.each(INKOS_CLIENT_COLLECTION_URLS)("accepts exact semantic and sidecar target %s", (targetUrl) => {
    expect(contentDocumentSchema.safeParse(semanticLink(targetUrl)).success).toBe(true);
    expect(inkFrameSidecarSchema.safeParse(sidecar(targetUrl)).success).toBe(true);
  });

  it.each(INKOS_LEGACY_CLIENT_COLLECTION_URLS)(
    "accepts legacy alias %s for old packages without advertising it to new producers",
    (targetUrl) => {
      expect(INKOS_CLIENT_COLLECTION_URLS).not.toContain(targetUrl);
      expect(contentDocumentSchema.safeParse(semanticLink(targetUrl)).success).toBe(true);
      expect(inkFrameSidecarSchema.safeParse(sidecar(targetUrl)).success).toBe(true);
    },
  );

  it.each(INKOS_CLIENT_APP_URLS)("accepts exact app action %s without treating it as a source URL", (targetUrl) => {
    expect(contentDocumentSchema.safeParse(semanticLink(targetUrl)).success).toBe(true);
    expect(inkFrameSidecarSchema.safeParse(sidecar(targetUrl)).success).toBe(true);
    expect(sourceResolveRequestSchema.safeParse({ url: targetUrl }).success).toBe(false);
  });

  it.each([
    "inkos://collection",
    "inkos://collection/rss/",
    "inkos://collection/rss?feed=https%3A%2F%2Fexample.com",
    "inkos://collection/settings",
    "inkos://Collection/rss",
    "inkos://device/reset",
    "inkos://app/random-image/",
    "inkos://app/baidu-map?zoom=17",
    "inkos://app/settings",
    "javascript:alert(1)",
  ])("rejects unreserved custom target %s everywhere", (targetUrl) => {
    expect(contentDocumentSchema.safeParse(semanticLink(targetUrl)).success).toBe(false);
    expect(inkFrameSidecarSchema.safeParse(sidecar(targetUrl)).success).toBe(false);
  });

  it("keeps ordinary HTTP(S) links compatible but never permits a collection URI as an image", () => {
    expect(contentDocumentSchema.safeParse(semanticLink("https://example.com/article")).success)
      .toBe(true);
    expect(inkFrameSidecarSchema.safeParse(sidecar("http://example.com/article")).success)
      .toBe(true);
    expect(contentImageSchema.safeParse({
      source: { kind: "remote", url: "inkos://collection/rss" },
      alt: "not a network image",
    }).success).toBe(false);
  });

  it.each(INKOS_CLIENT_COLLECTION_URLS)("never treats %s as a server source URL", (url) => {
    expect(sourceResolveRequestSchema.safeParse({ url }).success).toBe(false);
  });

  it.each(INKOS_LEGACY_CLIENT_COLLECTION_URLS)("never fetches legacy alias %s as a source", (url) => {
    expect(sourceResolveRequestSchema.safeParse({ url }).success).toBe(false);
  });
});
