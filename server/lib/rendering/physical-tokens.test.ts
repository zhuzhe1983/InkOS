import { describe, expect, it } from "vitest";

import { contentDocumentSchema, screenProfileSchema } from "./contracts";
import { layoutSemanticDocument } from "./semantic-layout";
import {
  logicalPhysicalSizeMm,
  millimetresToPixels,
  physicalLayoutTokens,
  physicalScreenMetrics,
  rendererUnitsToPixels,
} from "./physical-tokens";
import { getScreenProfile, orientScreenProfile } from "./profiles";

describe("physical screen render tokens", () => {
  const paperS3 = getScreenProfile("m5stack-paper-s3-portrait");

  it("derives PaperS3 density from the ED047TC1 active panel area", () => {
    const metrics = physicalScreenMetrics(paperS3);

    expect(paperS3.physicalSizeMm).toEqual({ width: 103.68, height: 58.32 });
    expect(metrics.ppiX).toBeCloseTo(235.19, 1);
    expect(metrics.ppiY).toBeCloseTo(235.19, 1);
    expect(metrics.densityScale).toBeGreaterThan(1.45);
    expect(orientScreenProfile(paperS3, "landscape").physicalSizeMm)
      .toEqual(paperS3.physicalSizeMm);
    expect(logicalPhysicalSizeMm(paperS3)).toEqual({ width: 58.32, height: 103.68 });
    expect(logicalPhysicalSizeMm(orientScreenProfile(paperS3, "landscape")))
      .toEqual({ width: 103.68, height: 58.32 });
  });

  it("enlarges every physical PaperS3 primitive instead of only the font", () => {
    const tokens = physicalLayoutTokens(paperS3);

    // These values are the former implicit one-device pixel/design baselines.
    expect(rendererUnitsToPixels(paperS3, 21)).toBeGreaterThan(21);
    expect(tokens.stroke.standard).toBeGreaterThan(1);
    expect(tokens.stroke.strong).toBeGreaterThan(tokens.stroke.standard);
    expect(tokens.spacing.sm).toBeGreaterThan(5);
    expect(tokens.radius.medium).toBeGreaterThan(6);
    expect(tokens.icon.small).toBeGreaterThan(16);
    expect(tokens.minimumTouchTarget).toBeGreaterThanOrEqual(64);
    expect(tokens.minimumTouchTarget).toBe(Math.round(millimetresToPixels(paperS3, 7)));
  });

  it("uses density-aware typography, borders and minimum touch targets in real layout output", () => {
    const document = contentDocumentSchema.parse({
      schemaVersion: "inkos.content/v2",
      id: "physical-layout-test",
      revision: 1,
      page: {
        kind: "detail",
        layout: "article",
        title: "Physical PaperS3",
        content: [{
          type: "link",
          link: {
            label: "Open",
            target: { kind: "url", url: "https://example.com/" },
          },
        }],
      },
    });
    const layout = layoutSemanticDocument(document, paperS3);
    const svg = layout.pages.map((page) => page.svg).join("");
    const fontSizes = [...svg.matchAll(/font-size="([\d.]+)"/gu)]
      .map((match) => Number(match[1]));
    const bodyFontSize = Number(
      svg.match(/<text[^>]*font-size="([\d.]+)"[^>]*>↗ Open<\/text>/u)?.[1],
    );
    const interactions = layout.pages.flatMap((page) => page.interactions);

    expect(Math.max(...fontSizes)).toBeGreaterThan(36);
    expect(bodyFontSize).toBeGreaterThan(21);
    expect(svg).toContain(
      'font-family="Noto Sans CJK SC, PingFang SC, Heiti SC, Microsoft YaHei, Arial Unicode MS, sans-serif"',
    );
    expect(svg).not.toContain('font-family="Arial Unicode MS,');
    expect(svg).toContain('stroke-width="2"');
    expect(interactions.length).toBeGreaterThan(0);
    expect(interactions.every((interaction) => interaction.bounds.width >= 64)).toBe(true);
    expect(interactions.every((interaction) => interaction.bounds.height >= 64)).toBe(true);

    const grid = contentDocumentSchema.parse({
      schemaVersion: "inkos.content/v2",
      id: "physical-grid-test",
      revision: 1,
      page: {
        kind: "list",
        layout: "grid",
        title: "Grid",
        items: [{ id: "card", title: "Card" }],
      },
    });
    expect(layoutSemanticDocument(grid, paperS3).pages[0].svg)
      .toContain('stroke-width="3"');
  });

  it("rejects trusted metadata whose physical aspect implies non-square pixels", () => {
    const parsed = screenProfileSchema.safeParse({
      ...paperS3,
      physicalSizeMm: { width: 103.68, height: 80 },
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path[0] === "physicalSizeMm"))
        .toBe(true);
    }
  });
});
