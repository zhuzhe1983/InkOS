import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import PaperS3ClientPage, { metadata, viewport } from "./page";

describe("PaperS3 client URL deep links", () => {
  it("uses the offline application-home archive when only presentation parameters are present", async () => {
    const page = await PaperS3ClientPage({
      searchParams: Promise.resolve({ fullscreen: "1" }),
    });
    const html = renderToStaticMarkup(page);

    expect(html).toContain('data-default-offline-home="true"');
    expect(html).toContain('data-immersive="true"');
  });

  it("prefills the ordinary client URL form from the query", async () => {
    const sourceUrl = "https://example.com/a+b?q=x+y#chapter";
    const page = await PaperS3ClientPage({
      searchParams: Promise.resolve({ url: sourceUrl }),
    });
    const html = renderToStaticMarkup(page);

    expect(html).toContain('data-auto-source="true"');
    expect(html).toContain("抓取并打开");
    expect(html).toContain('value="https://example.com/a+b?q=x+y#chapter"');
  });

  it("passes the URL query into immersive startup without rendering controls", async () => {
    const sourceUrl = "https://example.com/a+b?q=x+y#chapter";
    const page = await PaperS3ClientPage({
      searchParams: Promise.resolve({ fullscreen: "1", url: sourceUrl }),
    });
    const html = renderToStaticMarkup(page);

    expect(html).toContain('data-auto-source="true"');
    expect(html).toContain('data-immersive="true"');
    expect(html).not.toContain("全屏模式操作");
    expect(html).not.toContain("全屏页面导航");
    expect(html).not.toContain("抓取并打开");
  });

  it("passes exact package, document and page UUID deep links into startup", async () => {
    const packageId = "10000000-0000-4000-8000-000000000099";
    const uuid = "10000000-0000-4000-8000-000000000002";
    const page = await PaperS3ClientPage({
      searchParams: Promise.resolve({ package: packageId, uuid, page: "3" }),
    });
    const html = renderToStaticMarkup(page);

    expect(html).toContain('data-auto-source="true"');
    expect(html).toContain(`data-initial-package="${packageId}"`);
    expect(html).toContain(`data-initial-uuid="${uuid}"`);
    expect(html).toContain('data-initial-page="3"');
  });

  it("treats an explicit page parameter as content intent instead of falling back", async () => {
    const page = await PaperS3ClientPage({
      searchParams: Promise.resolve({ page: "0" }),
    });
    const html = renderToStaticMarkup(page);

    expect(html).toContain('data-default-offline-home="false"');
    expect(html).toContain("内容直达参数缺少 url 或 package");
  });

  it("publishes install and safe-area metadata for a chrome-free app launch", () => {
    expect(metadata).toMatchObject({
      applicationName: "InkOS PaperS3",
      manifest: "/papers3-client/manifest.webmanifest",
      appleWebApp: {
        capable: true,
        statusBarStyle: "black-translucent",
      },
    });
    expect(viewport).toMatchObject({ viewportFit: "cover" });
  });
});
