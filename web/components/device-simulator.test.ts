import { describe, expect, it } from "vitest";

import {
  contentDocumentSchema,
  type RenderInteraction,
} from "@/lib/rendering/contracts";
import { renderEngine } from "@/lib/rendering/engine";
import {
  DETAIL_SAMPLE_CONTENT,
  FULLSCREEN_IMAGE_CONTAIN_SAMPLE_CONTENT,
} from "@/lib/rendering/sample-content";

import {
  createSimulatorRenderPlan,
  hitTestFrameInteractions,
  imagePreviewForInteraction,
  logicalPointInFrame,
} from "./device-simulator";

function interaction(
  contentPath: string,
  bounds: RenderInteraction["bounds"],
  action: RenderInteraction["action"],
): RenderInteraction {
  return { contentPath, bounds, action, label: contentPath };
}

describe("device simulator image preview planning", () => {
  it("creates request-scoped contain children without mutating or adding targets to editor JSON", () => {
    const document = contentDocumentSchema.parse(DETAIL_SAMPLE_CONTENT);
    const editorJsonBefore = JSON.stringify(document);
    const plan = createSimulatorRenderPlan(document);

    expect(plan.imageTargets).toHaveLength(2);
    expect(plan.imageTargets.map((target) => target.contentPath)).toEqual([
      "page.heroImage",
      "page.content[7].image",
    ]);
    expect(JSON.stringify(document)).toBe(editorJsonBefore);
    for (const target of plan.imageTargets) {
      expect(editorJsonBefore).not.toContain(target.targetDocumentId);
      const preview = plan.imagePreviews.get(target.targetDocumentId);
      expect(preview?.document.page).toMatchObject({ kind: "image", layout: "contain" });
      expect(preview?.document.id).toBe(target.targetDocumentId);
      expect(preview?.document.revision).toBe(document.revision);
      expect(preview?.document.page.kind === "image" && "caption" in preview.document.page.image).toBe(false);
    }
  });

  it("does not recursively create a child for an existing full-screen image document", () => {
    const imageDocument = contentDocumentSchema.parse(FULLSCREEN_IMAGE_CONTAIN_SAMPLE_CONTENT);
    const plan = createSimulatorRenderPlan(imageDocument);
    expect(plan.imageTargets).toEqual([]);
    expect(plan.imagePreviews.size).toBe(0);
  });

  it.each([
    "m5stack-paper-s3-portrait",
    "m5stack-xiaozhi-card",
    "m5stack-paper-color",
  ])("renders navigable image hitboxes and the contain child on %s", async (profileId) => {
    const document = contentDocumentSchema.parse(DETAIL_SAMPLE_CONTENT);
    const plan = createSimulatorRenderPlan(document);
    const firstPreview = [...plan.imagePreviews.values()][0];
    const parentFrame = await renderEngine.render({
      profileId,
      document,
      navigationContext: { imageTargets: plan.imageTargets },
    });
    expect(parentFrame.manifest.interactions).toContainEqual(expect.objectContaining({
      contentPath: `${firstPreview.contentPath}.fullscreen`,
      action: { type: "open-document", documentId: firstPreview.targetDocumentId },
    }));

    const childFrame = await renderEngine.render({
      profileId,
      document: firstPreview.document,
      displayMeta: { orientation: "landscape", invert: false, fontLevel: 2 },
      navigationContext: { imageTargets: [] },
    });
    expect(childFrame.manifest).toMatchObject({
      documentId: firstPreview.targetDocumentId,
      contentType: "image",
      displayMeta: { orientation: "landscape", invert: false, fontLevel: 2 },
      pagination: { pageIndex: 0, pageCount: 1 },
    });
  });
});

describe("device simulator manifest hit testing", () => {
  const articleLink = interaction(
    "page.items[0].link",
    { x: 0, y: 0, width: 200, height: 200 },
    { type: "open-document", documentId: "article-detail" },
  );
  const imageLink = interaction(
    "page.items[0].image.fullscreen",
    { x: 20, y: 30, width: 80, height: 70 },
    { type: "open-document", documentId: "simulator-image-preview:0:gallery" },
  );

  it("chooses the smallest overlapping hitbox and keeps array order for equal areas", () => {
    expect(hitTestFrameInteractions([articleLink, imageLink], 50, 50)).toBe(imageLink);
    const equal = interaction(
      "equal",
      imageLink.bounds,
      { type: "open-url", url: "https://example.com" },
    );
    expect(hitTestFrameInteractions([imageLink, equal], 50, 50)).toBe(imageLink);
    expect(hitTestFrameInteractions([imageLink], 100, 50)).toBeUndefined();
  });

  it("opens only a registered image open-document interaction", () => {
    const document = contentDocumentSchema.parse({
      ...DETAIL_SAMPLE_CONTENT,
      id: "gallery",
    });
    const plan = createSimulatorRenderPlan(document);
    const preview = [...plan.imagePreviews.values()][0];
    const valid = interaction(
      `${preview.contentPath}.fullscreen`,
      imageLink.bounds,
      { type: "open-document", documentId: preview.targetDocumentId },
    );
    expect(imagePreviewForInteraction(valid, plan.imagePreviews)).toBe(preview);
    expect(imagePreviewForInteraction(articleLink, plan.imagePreviews)).toBeUndefined();
    expect(imagePreviewForInteraction(
      { ...valid, contentPath: "page.links[0]" },
      plan.imagePreviews,
    )).toBeUndefined();
    expect(imagePreviewForInteraction(
      { ...valid, action: { type: "open-url", url: "https://example.com" } },
      plan.imagePreviews,
    )).toBeUndefined();
  });

  it("maps browser coordinates into portrait and landscape logical frames", () => {
    expect(logicalPointInFrame(
      { x: 120, y: 220 },
      { left: 20, top: 20, width: 200, height: 400 },
      { width: 540, height: 960 },
    )).toEqual({ x: 270, y: 480 });
    expect(logicalPointInFrame(
      { x: 220, y: 120 },
      { left: 20, top: 20, width: 400, height: 200 },
      { width: 960, height: 540 },
    )).toEqual({ x: 480, y: 270 });
  });
});
