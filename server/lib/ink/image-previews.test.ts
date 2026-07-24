import { describe, expect, it } from "vitest";

import { collectContentImageOccurrences } from "../rendering/content-images";
import { packagedDocument, type PackagedDocument } from "./contracts";
import {
  expandImagePreviewDocuments,
  imagePreviewDocumentUuid,
} from "./image-previews";

const ROOT = "10000000-0000-4000-8000-000000000001";
const LIST = "10000000-0000-4000-8000-000000000002";
const IMAGE = "10000000-0000-4000-8000-000000000003";
const UPDATED_AT = "2026-07-15T10:30:00.000Z";
const RETRIEVED_AT = "2026-07-16T08:00:00.000Z";

function detailDocument(): PackagedDocument {
  return packagedDocument({
    uuid: ROOT,
    source: {
      url: "https://example.com/story",
      title: "Story title",
      retrievedAt: RETRIEVED_AT,
      license: "CC BY 4.0",
    },
    content: {
      schemaVersion: "inkos.content/v2",
      id: ROOT,
      revision: 7,
      locale: "zh-CN",
      updatedAt: UPDATED_AT,
      page: {
        kind: "detail",
        layout: "image-story",
        title: "Story title",
        heroImage: {
          source: { kind: "remote", url: "https://images.example.com/hero.jpg" },
          alt: "Hero alt",
          caption: "Hero caption",
        },
        content: [
          { type: "paragraph", text: "Opening paragraph." },
          {
            type: "image",
            image: {
              source: { kind: "asset", assetId: "story/inline" },
              alt: "Inline alt",
              caption: "Inline caption",
            },
          },
          { type: "heading", level: 2, text: "Second section" },
          {
            type: "image",
            image: {
              source: { kind: "remote", url: "https://images.example.com/footer.jpg" },
              alt: "Footer alt",
            },
          },
        ],
      },
    },
  });
}

function listDocument(): PackagedDocument {
  return packagedDocument({
    uuid: LIST,
    parentUuid: ROOT,
    source: { url: "https://example.com/catalog", title: "Catalog" },
    content: {
      schemaVersion: "inkos.content/v2",
      id: LIST,
      revision: 3,
      locale: "en",
      page: {
        kind: "list",
        layout: "grid",
        title: "Catalog",
        items: [
          {
            id: "with-image",
            title: "First",
            image: {
              source: { kind: "remote", url: "https://images.example.com/first.jpg" },
              alt: "First image",
            },
          },
          { id: "without-image", title: "Text only" },
          {
            id: "later-image",
            image: {
              source: { kind: "asset", assetId: "catalog/later" },
              alt: "Later image",
            },
          },
        ],
      },
    },
  });
}

function imageDocument(): PackagedDocument {
  return packagedDocument({
    uuid: IMAGE,
    parentUuid: ROOT,
    source: { title: "Already full screen" },
    content: {
      schemaVersion: "inkos.content/v2",
      id: IMAGE,
      revision: 2,
      locale: "en",
      page: {
        kind: "image",
        layout: "cover",
        image: {
          source: { kind: "asset", assetId: "already/fullscreen" },
          alt: "Existing image page",
        },
        link: {
          label: "Return to story",
          target: { kind: "document", documentId: ROOT },
        },
      },
    },
  });
}

describe("image preview document expansion", () => {
  it("collects detail and list image paths in semantic source order", () => {
    const detail = detailDocument();
    const list = listDocument();

    expect(collectContentImageOccurrences(detail.content).map(({ contentPath }) => contentPath))
      .toEqual([
        "page.heroImage",
        "page.content[1].image",
        "page.content[3].image",
      ]);
    expect(collectContentImageOccurrences(list.content).map(({ contentPath }) => contentPath))
      .toEqual([
        "page.items[0].image",
        "page.items[2].image",
      ]);
  });

  it("uses stable parent-and-path UUIDv5 identities and preserves expansion order", () => {
    expect(imagePreviewDocumentUuid(ROOT, "page.heroImage"))
      .toBe("15359173-e443-5e20-a162-69fe2b3e9eb6");
    expect(imagePreviewDocumentUuid(ROOT, "page.content[2].image"))
      .toBe("69ff2120-24db-52a4-b379-57ea0a5a4bfd");
    expect(imagePreviewDocumentUuid(LIST, "page.items[1].image"))
      .toBe("c6e28f9a-76bf-5367-86a4-4db748452c47");

    const detail = detailDocument();
    const list = listDocument();
    const expanded = expandImagePreviewDocuments([detail, list]);
    const expectedChildren = [
      imagePreviewDocumentUuid(ROOT, "page.heroImage"),
      imagePreviewDocumentUuid(ROOT, "page.content[1].image"),
      imagePreviewDocumentUuid(ROOT, "page.content[3].image"),
      imagePreviewDocumentUuid(LIST, "page.items[0].image"),
      imagePreviewDocumentUuid(LIST, "page.items[2].image"),
    ];

    expect(expanded.documents.map((document) => document.uuid)).toEqual([
      ROOT,
      LIST,
      ...expectedChildren,
    ]);
    expect(expanded.imageTargetsByDocument.get(ROOT)).toEqual([
      { contentPath: "page.heroImage", targetDocumentId: expectedChildren[0] },
      { contentPath: "page.content[1].image", targetDocumentId: expectedChildren[1] },
      { contentPath: "page.content[3].image", targetDocumentId: expectedChildren[2] },
    ]);
    expect(expanded.imageTargetsByDocument.get(LIST)).toEqual([
      { contentPath: "page.items[0].image", targetDocumentId: expectedChildren[3] },
      { contentPath: "page.items[2].image", targetDocumentId: expectedChildren[4] },
    ]);
    expect(expandImagePreviewDocuments([detail, list]).documents.map(({ uuid }) => uuid))
      .toEqual(expanded.documents.map(({ uuid }) => uuid));
  });

  it("strips captions from image pages while inheriting document metadata", () => {
    const parent = detailDocument();
    const expanded = expandImagePreviewDocuments([parent]);
    const [hero, inline, footer] = expanded.documents.slice(1);

    expect(hero).toMatchObject({
      uuid: imagePreviewDocumentUuid(ROOT, "page.heroImage"),
      parentUuid: ROOT,
      source: {
        url: parent.source.url,
        title: "Hero caption",
        retrievedAt: RETRIEVED_AT,
        license: "CC BY 4.0",
      },
      content: {
        revision: 7,
        locale: "zh-CN",
        updatedAt: UPDATED_AT,
        page: {
          kind: "image",
          layout: "contain",
          image: {
            source: { kind: "remote", url: "https://images.example.com/hero.jpg" },
            alt: "Hero alt",
          },
        },
      },
    });
    expect(inline.source.title).toBe("Inline caption");
    expect(footer.source.title).toBe("Footer alt");
    for (const child of [hero, inline, footer]) {
      expect(child.content.id).toBe(child.uuid);
      expect(child.content.page.kind).toBe("image");
      if (child.content.page.kind === "image") {
        expect(child.content.page.image).not.toHaveProperty("caption");
      }
    }
  });

  it("does not recursively expand an existing image page or alter its link", () => {
    const image = imageDocument();
    const expanded = expandImagePreviewDocuments([image]);

    expect(expanded.documents).toHaveLength(1);
    expect(expanded.documents[0]).toBe(image);
    expect(expanded.documents[0].content.page).toEqual(image.content.page);
    expect(expanded.imageTargetsByDocument.size).toBe(0);
  });

  it("enforces the expanded-document limit without mutating source documents", () => {
    const sources = [detailDocument(), listDocument(), imageDocument()];
    const before = structuredClone(sources);
    const expandedCount = 3 + 3 + 2;

    expect(expandImagePreviewDocuments(sources, expandedCount).documents)
      .toHaveLength(expandedCount);
    expect(sources).toEqual(before);

    expect(() => expandImagePreviewDocuments(sources, expandedCount - 1))
      .toThrow(`Image preview expansion produced ${expandedCount} documents; maximum is ${expandedCount - 1}`);
    expect(sources).toEqual(before);
  });
});
