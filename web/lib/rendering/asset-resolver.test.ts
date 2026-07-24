import { lookup } from "node:dns/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ControlledRemoteAssetResolver } from "./asset-resolver";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

function remote(url: string) {
  return {
    source: { kind: "remote" as const, url },
    alt: "remote image",
  };
}

const publicDnsAnswer = [{ address: "1.1.1.1", family: 4 }];
const privateDnsAnswer = [{ address: "127.0.0.1", family: 4 }];
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const lookupMock = vi.mocked(lookup);

beforeEach(() => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue(publicDnsAnswer as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("job-scoped remote image hosts", () => {
  it("does not add a source-discovered host to the global resolver allowlist", async () => {
    const result = await new ControlledRemoteAssetResolver().resolve(
      remote("https://images.example.test/photo.jpg"),
    );
    expect(result).toEqual({
      status: "unavailable",
      reason: "host 'images.example.test' is not allowlisted",
    });
  });

  it("still rejects private addresses even when a job discovered that exact host", async () => {
    lookupMock.mockResolvedValueOnce(privateDnsAnswer as never);
    const result = await new ControlledRemoteAssetResolver({
      allowedSourceHosts: ["127.0.0.1"],
      allowPublicRedirectHosts: true,
    }).resolve(remote("https://127.0.0.1/private.jpg"));

    expect(result.status).toBe("unavailable");
    expect(result.status === "unavailable" ? result.reason : "").toMatch(/public address/u);
  });

  it("keeps the same SSRF boundary in diagnostic raw-colour normalization", async () => {
    lookupMock.mockResolvedValueOnce(privateDnsAnswer as never);
    const result = await new ControlledRemoteAssetResolver({
      allowedSourceHosts: ["127.0.0.1"],
      allowPublicRedirectHosts: true,
      normalization: "diagnostic-raw-colour-png",
    }).resolve(remote("https://127.0.0.1/private.png"));

    expect(result.status).toBe("unavailable");
    expect(result.status === "unavailable" ? result.reason : "").toMatch(/public address/u);
  });

  it("continues to require HTTPS for a job-scoped host", async () => {
    const result = await new ControlledRemoteAssetResolver({
      allowedSourceHosts: ["images.example.test"],
    }).resolve(remote("http://images.example.test/photo.jpg"));

    expect(result).toEqual({
      status: "unavailable",
      reason: "only HTTPS images are allowed",
    });
  });

  it("sends only the validated image URL's own HTTPS origin as Referer", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(onePixelPng, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(onePixelPng.byteLength),
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new ControlledRemoteAssetResolver({
      allowedSourceHosts: ["cdnfile.sspai.com"],
    }).resolve(remote(
      "https://cdnfile.sspai.com/article/secret/photo.png?token=do-not-leak#crop",
    ));

    expect(result.status).toBe("resolved");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
      Accept: "image/webp,image/png,image/jpeg",
      Referer: "https://cdnfile.sspai.com/",
      "User-Agent": "InkOS-Renderer/0.3",
    });
  });

  it("revalidates a redirect and uses the redirect target's own origin", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: {
          Location: "https://media.example.test/final/photo.jpg?signature=do-not-leak#view",
        },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new ControlledRemoteAssetResolver({
      allowedSourceHosts: ["images.example.test"],
      allowPublicRedirectHosts: true,
    }).resolve(remote("https://images.example.test/start/photo.jpg?source-secret=1"));

    expect(result).toEqual({
      status: "unavailable",
      reason: "image server returned HTTP 403",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Referer: "https://images.example.test/",
    });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      Referer: "https://media.example.test/",
    });
  });

  it("does not issue a redirected request or Referer to a private target", async () => {
    lookupMock
      .mockResolvedValueOnce(publicDnsAnswer as never)
      .mockResolvedValueOnce(privateDnsAnswer as never);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { Location: "https://127.0.0.1/private.jpg" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new ControlledRemoteAssetResolver({
      allowedSourceHosts: ["images.example.test"],
      allowPublicRedirectHosts: true,
    }).resolve(remote("https://images.example.test/start.jpg"));

    expect(result.status).toBe("unavailable");
    expect(result.status === "unavailable" ? result.reason : "").toMatch(/public address/u);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects credential-bearing image URLs before constructing a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await new ControlledRemoteAssetResolver({
      allowedSourceHosts: ["images.example.test"],
    }).resolve(remote("https://user:password@images.example.test/photo.jpg"));

    expect(result).toEqual({
      status: "unavailable",
      reason: "image URLs cannot contain credentials",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
