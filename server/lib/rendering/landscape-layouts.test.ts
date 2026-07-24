import { describe, expect, it } from "vitest";

import { contentDocumentSchema } from "./contracts";
import { getScreenProfile, orientScreenProfile } from "./profiles";
import {
  EBOOK_HOME_SAMPLE_CONTENT,
  GALLERY_SAMPLE_CONTENT,
  GRID_SAMPLE_CONTENT,
  POSTCARD_SAMPLE_CONTENT,
} from "./sample-content";
import { layoutSemanticDocument } from "./semantic-layout";

const profile = orientScreenProfile(getScreenProfile("m5stack-paper-s3-portrait"), "landscape");
const displayMeta = { orientation: "landscape", invert: false, fontLevel: 0 } as const;

function layout(raw: unknown) {
  return layoutSemanticDocument(contentDocumentSchema.parse(raw), profile, { displayMeta });
}

describe("PaperS3 landscape editorial layouts", () => {
  it("renders the Grid sample as a complete six-week, seven-column month", () => {
    const result = layout(GRID_SAMPLE_CONTENT);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].contentPaths.filter((path) => /^page\.items\[\d+\]$/u.test(path))).toHaveLength(42);
    for (const weekday of ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]) {
      expect(result.pages[0].svg).toContain(weekday);
    }
  });

  it("centers every Postcard text layer, not only the title", () => {
    const result = layout(POSTCARD_SAMPLE_CONTENT);
    const svg = result.pages[0].svg;
    for (const text of ["来自海边的问候", "今天沿着海岸走了很久。", "下一次，我们一起看日落。", "— 林渡"]) {
      const escaped = text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      expect(svg).toMatch(new RegExp(`<text[^>]*text-anchor="middle"[^>]*>[^<]*${escaped}`, "u"));
    }
  });

  it("fits a full six-book shelf row on PaperS3 landscape", () => {
    const result = layout(EBOOK_HOME_SAMPLE_CONTENT);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].contentPaths.filter((path) => /^page\.items\[\d+\]$/u.test(path))).toHaveLength(6);
    expect(new Set(result.pages[0].interactions.map((interaction) => interaction.bounds.x)).size).toBe(6);
  });

  it("uses four shortest-column masonry lanes instead of stretched landscape cards", () => {
    const result = layout(GALLERY_SAMPLE_CONTENT);
    const firstPageLinks = result.pages[0].interactions.filter((interaction) =>
      /^page\.items\[\d+\]\.link$/u.test(interaction.contentPath),
    );
    expect(new Set(firstPageLinks.map((interaction) => interaction.bounds.x)).size).toBe(4);
    expect(result.pages.flatMap((page) => page.contentPaths).filter((path) => /^page\.items\[\d+\]$/u.test(path))).toHaveLength(8);
  });
});
