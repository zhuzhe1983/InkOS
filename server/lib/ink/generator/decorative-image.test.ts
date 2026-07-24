import { describe, expect, it } from "vitest";

import { isDecorativeImage } from "./decorative-image";

describe("decorative image classification", () => {
  it("uses positive declared dimensions when a lazy rendered size is zero", () => {
    expect(isDecorativeImage({
      source: "https://example.com/article.jpg",
      alt: "正文照片",
      renderedWidth: 0,
      renderedHeight: 0,
      renderedHidden: false,
      width: 1_200,
      height: 800,
    })).toBe(false);
    expect(isDecorativeImage({
      source: "https://example.com/article-with-empty-alt.jpg",
      alt: "",
      renderedWidth: 0,
      renderedHeight: 0,
      renderedHidden: false,
      width: 1_200,
      height: 800,
    })).toBe(false);
  });

  it("protects labelled QR and meaningful small editorial images", () => {
    expect(isDecorativeImage({
      source: "https://example.com/qr-icon.png",
      className: "share-icon",
      alt: "扫码打开原文二维码",
      renderedWidth: 48,
      renderedHeight: 48,
    })).toBe(false);
    expect(isDecorativeImage({
      source: "https://example.com/qr.png",
      alt: "",
      renderedWidth: 48,
      renderedHeight: 48,
    })).toBe(false);
    expect(isDecorativeImage({
      source: "https://example.com/thumb.jpg",
      alt: "正文缩略图",
      renderedWidth: 64,
      renderedHeight: 64,
    })).toBe(false);
  });

  it("drops hidden, hairline and semantically decorative images", () => {
    expect(isDecorativeImage({
      source: "https://example.com/photo.jpg",
      alt: "照片",
      renderedHidden: true,
      width: 1_200,
      height: 800,
    })).toBe(true);
    expect(isDecorativeImage({
      source: "https://example.com/tracker.gif",
      renderedWidth: 1,
      renderedHeight: 1,
    })).toBe(true);
    expect(isDecorativeImage({
      source: "https://example.com/more.png",
      renderedWidth: 0,
      renderedHeight: 0,
      renderedHidden: false,
    })).toBe(true);
    expect(isDecorativeImage({
      source: "https://example.com/next.png",
      alt: "下一页",
      renderedWidth: 28,
      renderedHeight: 50,
    })).toBe(true);
    expect(isDecorativeImage({
      source: "https://example.com/author/avatar.jpg",
      alt: "Alice",
      width: 32,
      height: 32,
    })).toBe(true);
  });
});
