import { describe, expect, it } from "vitest";

import rawDefaultRssStyle from "./styles/rss-default.v1.json";
import { DEFAULT_RSS_STYLE, parseRssStyle } from "./rss-style";

describe("RSS default style", () => {
  it("loads the checked-in semantic style and deeply freezes it", () => {
    expect(DEFAULT_RSS_STYLE).toEqual(rawDefaultRssStyle);
    expect(Object.isFrozen(DEFAULT_RSS_STYLE)).toBe(true);
    expect(Object.isFrozen(DEFAULT_RSS_STYLE.feed)).toBe(true);
    expect(Object.isFrozen(DEFAULT_RSS_STYLE.article.bodySourceOrder)).toBe(true);
    expect(JSON.stringify(DEFAULT_RSS_STYLE)).not.toMatch(
      /"(?:x|y|width|height|css|selector|script|url)"\s*:/iu,
    );
  });

  it.each([
    ["unknown root key", { ...rawDefaultRssStyle, width: 540 }],
    [
      "selector injection",
      {
        ...rawDefaultRssStyle,
        html: { ...rawDefaultRssStyle.html, selector: ".article" },
      },
    ],
    [
      "duplicate source precedence",
      {
        ...rawDefaultRssStyle,
        article: {
          ...rawDefaultRssStyle.article,
          bodySourceOrder: [
            "rss-content-encoded",
            "rss-content-encoded",
            "rss-description",
            "atom-summary",
            "linked-chromium",
          ],
        },
      },
    ],
    [
      "remote final fallback",
      {
        ...rawDefaultRssStyle,
        article: {
          ...rawDefaultRssStyle.article,
          bodySourceOrder: [
            "rss-content-encoded",
            "atom-content",
            "rss-description",
            "linked-chromium",
            "atom-summary",
          ],
        },
      },
    ],
  ])("rejects %s", (_, value) => {
    expect(() => parseRssStyle(value)).toThrow();
  });
});
