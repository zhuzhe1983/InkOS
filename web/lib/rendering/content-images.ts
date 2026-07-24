import type { ContentDocument, ContentImage } from "./contracts";

/**
 * One semantic image occurrence and its stable path inside inkos.content/v2.
 *
 * The path identifies content, not pixels. Layout strategies remain solely
 * responsible for turning it into device-specific bounds.
 */
export interface ContentImageOccurrence {
  contentPath: string;
  image: ContentImage;
}

export function imageSourceKey(image: ContentImage): string {
  const source = image.source.kind === "asset"
    ? `asset:${image.source.assetId}`
    : `remote:${image.source.url}`;
  return `${source}|intent:${image.renderIntent ?? "photo"}`;
}

/**
 * Enumerate images in semantic document order. These paths are shared by the
 * renderer interaction context and package image-child expansion; keep them in
 * lockstep with semantic-layout.ts.
 */
export function collectContentImageOccurrences(
  document: ContentDocument,
): ContentImageOccurrence[] {
  const page = document.page;
  switch (page.kind) {
    case "reader":
      return [];
    case "image":
      return [{ contentPath: "page.image", image: page.image }];
    case "list":
      return page.items.flatMap((item, index) => item.image
        ? [{ contentPath: `page.items[${index}].image`, image: item.image }]
        : []);
    case "detail": {
      const occurrences: ContentImageOccurrence[] = page.heroImage
        ? [{ contentPath: "page.heroImage", image: page.heroImage }]
        : [];
      page.content.forEach((block, index) => {
        if (block.type === "image") {
          occurrences.push({
            contentPath: `page.content[${index}].image`,
            image: block.image,
          });
        }
      });
      return occurrences;
    }
  }
}
