import { describe, expect, it } from "vitest";

import type { AssetResolver, ImageResolution } from "./asset-resolver";
import { collectContentImageOccurrences, imageSourceKey } from "./content-images";
import {
  contentDocumentSchema,
  renderRequestSchema,
  type ContentDocument,
  type ContentImage,
} from "./contracts";
import { RenderEngine } from "./engine";
import { getScreenProfile, orientScreenProfile } from "./profiles";
import { layoutSemanticDocument } from "./semantic-layout";

const PROFILE_IDS = [
  "m5stack-paper-s3-portrait",
  "m5stack-xiaozhi-card",
  "m5stack-paper-color",
] as const;
const ORIENTATIONS = ["portrait", "landscape"] as const;
const LIST_LAYOUTS = ["feed", "list", "grid", "cardboard", "masonry", "bookshelf"] as const;
const DETAIL_LAYOUTS = ["article", "image-story", "postcard"] as const;

function image(index: number): ContentImage {
  return {
    source: { kind: "remote", url: `https://images.example/${index}.jpg` },
    alt: `Image ${index}`,
    caption: `Caption ${index}`,
  };
}

function detailDocument(layout: typeof DETAIL_LAYOUTS[number]): ContentDocument {
  return contentDocumentSchema.parse({
    schemaVersion: "inkos.content/v2",
    id: `image-navigation/detail-${layout}`,
    revision: 1,
    locale: "en",
    page: {
      kind: "detail",
      layout,
      title: "Image navigation",
      summary: "Every semantic image can open a generated full-screen image document.",
      heroImage: image(1),
      content: [
        { type: "paragraph", text: "Body copy before the inline image." },
        { type: "image", image: image(2) },
      ],
    },
  });
}

function listDocument(layout: typeof LIST_LAYOUTS[number], count = 1): ContentDocument {
  return contentDocumentSchema.parse({
    schemaVersion: "inkos.content/v2",
    id: `image-navigation/list-${layout}`,
    revision: 1,
    locale: "en",
    page: {
      kind: "list",
      layout,
      title: "Image list",
      items: Array.from({ length: count }, (_value, index) => ({
        id: `item-${index}`,
        eyebrow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][index % 7],
        title: `Item ${index + 1}`,
        summary: "A linked card whose image has a smaller, more specific action.",
        image: image(index + 10),
        link: {
          label: `Open item ${index + 1}`,
          target: { kind: "document", documentId: `article-${index + 1}` },
        },
      })),
    },
  });
}

function imageResolutionMap(document: ContentDocument): ReadonlyMap<string, ImageResolution> {
  return new Map(collectContentImageOccurrences(document).map(({ image: semanticImage }) => [
    imageSourceKey(semanticImage),
    {
      status: "resolved" as const,
      image: {
        dataUri: "data:image/jpeg;base64,/9j/2Q==",
        width: 300,
        height: 200,
        mimeType: "image/jpeg",
      },
    },
  ]));
}

function targetMap(document: ContentDocument): ReadonlyMap<string, string> {
  return new Map(collectContentImageOccurrences(document).map((occurrence, index) => [
    occurrence.contentPath,
    `preview-${index}`,
  ]));
}

function allInteractions(
  layout: ReturnType<typeof layoutSemanticDocument>,
) {
  return layout.pages.flatMap((page) => page.interactions);
}

function expectImageNavigation(
  document: ContentDocument,
  profileId: string,
  orientation: typeof ORIENTATIONS[number],
): void {
  const profile = orientScreenProfile(getScreenProfile(profileId), orientation);
  const targets = targetMap(document);
  const layout = layoutSemanticDocument(document, profile, {
    resolvedImages: imageResolutionMap(document),
    imageTargets: targets,
    displayMeta: { orientation, invert: false, fontLevel: 0 },
  });
  const interactions = allInteractions(layout);

  for (const occurrence of collectContentImageOccurrences(document)) {
    const matching = interactions.filter(
      (interaction) => interaction.contentPath === `${occurrence.contentPath}.fullscreen`,
    );
    expect(matching, `${profileId}/${orientation}/${occurrence.contentPath}`).toHaveLength(1);
    expect(matching[0].action).toEqual({
      type: "open-document",
      documentId: targets.get(occurrence.contentPath),
    });
    expect(matching[0].bounds.x).toBeGreaterThanOrEqual(0);
    expect(matching[0].bounds.y).toBeGreaterThanOrEqual(0);
    expect(matching[0].bounds.width).toBeGreaterThan(0);
    expect(matching[0].bounds.height).toBeGreaterThan(0);
    expect(matching[0].bounds.x + matching[0].bounds.width)
      .toBeLessThanOrEqual(profile.logicalSize.width);
    expect(matching[0].bounds.y + matching[0].bounds.height)
      .toBeLessThanOrEqual(profile.logicalSize.height);
  }

  if (document.page.kind === "list") {
    document.page.items.forEach((item, index) => {
      if (!item.image || !item.link) return;
      const card = interactions.find(({ contentPath }) => contentPath === `page.items[${index}].link`)!;
      const preview = interactions.find(
        ({ contentPath }) => contentPath === `page.items[${index}].image.fullscreen`,
      )!;
      expect(card.action).toEqual({ type: "open-document", documentId: `article-${index + 1}` });
      expect(preview.bounds.width * preview.bounds.height)
        .toBeLessThan(card.bounds.width * card.bounds.height);
    });
  }
}

describe("semantic image navigation", () => {
  it.each(PROFILE_IDS.flatMap((profileId) =>
    ORIENTATIONS.flatMap((orientation) =>
      DETAIL_LAYOUTS.map((layout) => [profileId, orientation, layout] as const),
    ),
  ))("creates exact detail image actions on %s/%s/%s", (profileId, orientation, layout) => {
    expectImageNavigation(detailDocument(layout), profileId, orientation);
  });

  it.each(PROFILE_IDS.flatMap((profileId) =>
    ORIENTATIONS.flatMap((orientation) =>
      LIST_LAYOUTS.map((layout) => [profileId, orientation, layout] as const),
    ),
  ))("keeps card links and adds image actions on %s/%s/%s", (profileId, orientation, layout) => {
    expectImageNavigation(listDocument(layout), profileId, orientation);
  });

  it("uses the fitted visible rectangle for contain images", () => {
    const document = detailDocument("postcard");
    const layout = layoutSemanticDocument(document, getScreenProfile("m5stack-paper-s3-portrait"), {
      resolvedImages: imageResolutionMap(document),
      imageTargets: targetMap(document),
    });
    const hero = allInteractions(layout).find(
      ({ contentPath }) => contentPath === "page.heroImage.fullscreen",
    )!;

    expect(hero.bounds.width / hero.bounds.height).toBeCloseTo(1.5, 1);
  });

  it("does not alter SVG output when request-only navigation metadata is supplied", () => {
    const document = detailDocument("article");
    const profile = getScreenProfile("m5stack-paper-s3-portrait");
    const base = layoutSemanticDocument(document, profile, {
      resolvedImages: imageResolutionMap(document),
    });
    const navigable = layoutSemanticDocument(document, profile, {
      resolvedImages: imageResolutionMap(document),
      imageTargets: targetMap(document),
    });

    expect(navigable.pages.map((page) => page.svg)).toEqual(base.pages.map((page) => page.svg));
    expect(navigable.pages.map((page) => page.contentPaths))
      .not.toEqual(base.pages.map((page) => page.contentPaths));
  });

  it("falls back from the image-less dense calendar treatment when grid items have images", () => {
    const document = listDocument("grid", 28);
    const layout = layoutSemanticDocument(document, getScreenProfile("m5stack-paper-s3-portrait"), {
      resolvedImages: imageResolutionMap(document),
      imageTargets: targetMap(document),
    });

    expect(allInteractions(layout).filter(({ contentPath }) => contentPath.endsWith(".fullscreen")))
      .toHaveLength(28);
    expect(layout.pages.some((page) => page.svg.includes("<image"))).toBe(true);
  });

  it("preserves all 48 feed items and links when image navigation is enabled", () => {
    const document = listDocument("feed", 48);
    const layout = layoutSemanticDocument(document, getScreenProfile("m5stack-paper-s3-portrait"), {
      resolvedImages: imageResolutionMap(document),
      imageTargets: targetMap(document),
    });
    const itemPaths = layout.pages
      .flatMap((page) => page.contentPaths)
      .filter((path) => /^page\.items\[\d+\]$/u.test(path));
    const interactions = allInteractions(layout);

    expect(itemPaths).toEqual(
      Array.from({ length: 48 }, (_value, index) => `page.items[${index}]`),
    );
    expect(interactions.filter(({ contentPath }) => /\.link$/u.test(contentPath)))
      .toHaveLength(48);
    expect(interactions.filter(({ contentPath }) => /\.image\.fullscreen$/u.test(contentPath)))
      .toHaveLength(48);
  });

  it("keeps a full-screen image page terminal and preserves its explicit link", () => {
    const document = contentDocumentSchema.parse({
      schemaVersion: "inkos.content/v2",
      id: "image-navigation/full-screen",
      revision: 1,
      page: {
        kind: "image",
        layout: "contain",
        image: { source: image(99).source, alt: "Full screen" },
        link: {
          label: "Open source",
          target: { kind: "url", url: "https://example.com/source" },
        },
      },
    });
    const layout = layoutSemanticDocument(document, getScreenProfile("m5stack-paper-s3-portrait"), {
      resolvedImages: imageResolutionMap(document),
      imageTargets: new Map([["page.image", "recursive-preview"]]),
    });

    expect(allInteractions(layout)).toEqual([
      expect.objectContaining({
        contentPath: "page.link",
        action: { type: "open-url", url: "https://example.com/source" },
      }),
    ]);
  });
});

describe("render navigation request contract", () => {
  const document = listDocument("feed");

  it("defaults navigation metadata without putting it into semantic content", () => {
    const request = renderRequestSchema.parse({ profileId: PROFILE_IDS[0], document });
    expect(request.navigationContext).toEqual({ imageTargets: [] });
    expect(contentDocumentSchema.safeParse({
      ...document,
      navigationContext: { imageTargets: [] },
    }).success).toBe(false);
  });

  it("accepts a valid target and rejects duplicate paths or extra keys", () => {
    const base = {
      profileId: PROFILE_IDS[0],
      document,
      navigationContext: {
        imageTargets: [{
          contentPath: "page.items[0].image",
          targetDocumentId: "preview-1",
        }],
      },
    };
    expect(renderRequestSchema.safeParse(base).success).toBe(true);
    expect(renderRequestSchema.safeParse({
      ...base,
      navigationContext: {
        imageTargets: [base.navigationContext.imageTargets[0], base.navigationContext.imageTargets[0]],
      },
    }).success).toBe(false);
    expect(renderRequestSchema.safeParse({
      ...base,
      navigationContext: { ...base.navigationContext, pixelBounds: { x: 0, y: 0 } },
    }).success).toBe(false);
  });

  it("rejects a semantic path that is not an image before rasterization", async () => {
    const unavailableResolver: AssetResolver = {
      async resolve() {
        return { status: "unavailable", reason: "test" };
      },
    };
    const engine = new RenderEngine({ assetResolver: unavailableResolver });

    await expect(engine.render({
      profileId: PROFILE_IDS[0],
      document,
      navigationContext: {
        imageTargets: [{ contentPath: "page.items[0].title", targetDocumentId: "preview-1" }],
      },
    })).rejects.toThrow(/does not exist in document/u);
  });
});
