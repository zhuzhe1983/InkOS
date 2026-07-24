import type { ContentImage, RenderImageTarget } from "../rendering/contracts";
import { collectContentImageOccurrences } from "../rendering/content-images";
import {
  packagedDocument,
  type PackagedDocument,
} from "./contracts";
import { uuidV5 } from "./uuid";

export const INKOS_IMAGE_PREVIEW_NAMESPACE = "65c876c9-1f79-5a5a-95c6-4f2323606f3f";
export const MAX_EXPANDED_PACKAGE_DOCUMENTS = 256;

export interface ExpandedImagePreviewDocuments {
  /** Caller-supplied documents followed by deterministic image children. */
  documents: PackagedDocument[];
  /** Renderer request metadata keyed by the original parent document UUID. */
  imageTargetsByDocument: ReadonlyMap<string, RenderImageTarget[]>;
}

export function imagePreviewDocumentUuid(
  parentUuid: string,
  contentPath: string,
): string {
  return uuidV5(`${parentUuid}\0${contentPath}`, INKOS_IMAGE_PREVIEW_NAMESPACE);
}

function previewTitle(parent: PackagedDocument, image: ContentImage): string {
  return (image.caption?.trim() || image.alt.trim() || parent.source.title).slice(0, 500);
}

/**
 * Materialize request-scoped image navigation as ordinary package documents.
 * Existing image pages are already full-screen and are intentionally not
 * expanded again.
 */
export function expandImagePreviewDocuments(
  sourceDocuments: readonly PackagedDocument[],
  maximumDocuments = MAX_EXPANDED_PACKAGE_DOCUMENTS,
  maximumPreviews = Number.POSITIVE_INFINITY,
): ExpandedImagePreviewDocuments {
  if (
    maximumPreviews !== Number.POSITIVE_INFINITY
    && (!Number.isInteger(maximumPreviews) || maximumPreviews < 0)
  ) {
    throw new Error("maximumPreviews must be a non-negative integer");
  }
  const existingUuids = new Set(sourceDocuments.map((document) => document.uuid));
  const children: PackagedDocument[] = [];
  const imageTargetsByDocument = new Map<string, RenderImageTarget[]>();

  for (const parent of sourceDocuments) {
    if (parent.content.page.kind === "image") continue;
    const targets: RenderImageTarget[] = [];
    for (const occurrence of collectContentImageOccurrences(parent.content)) {
      if (children.length >= maximumPreviews) break;
      const uuid = imagePreviewDocumentUuid(parent.uuid, occurrence.contentPath);
      if (existingUuids.has(uuid)) {
        throw new Error(
          `Generated image preview UUID '${uuid}' collides with a packaged document`,
        );
      }
      existingUuids.add(uuid);
      const image: ContentImage = {
        source: occurrence.image.source,
        alt: occurrence.image.alt,
        ...(occurrence.image.renderIntent
          ? { renderIntent: occurrence.image.renderIntent }
          : {}),
      };
      children.push(packagedDocument({
        uuid,
        parentUuid: parent.uuid,
        source: {
          ...parent.source,
          title: previewTitle(parent, occurrence.image),
        },
        content: {
          schemaVersion: "inkos.content/v2",
          id: uuid,
          revision: parent.content.revision,
          locale: parent.content.locale,
          ...(parent.content.updatedAt ? { updatedAt: parent.content.updatedAt } : {}),
          page: {
            kind: "image",
            layout: "contain",
            image,
          },
        },
      }));
      targets.push({
        contentPath: occurrence.contentPath,
        targetDocumentId: uuid,
      });
    }
    if (targets.length > 0) imageTargetsByDocument.set(parent.uuid, targets);
  }

  const documents = [...sourceDocuments, ...children];
  if (documents.length > maximumDocuments) {
    throw new Error(
      `Image preview expansion produced ${documents.length} documents; maximum is ${maximumDocuments}`,
    );
  }
  return { documents, imageTargetsByDocument };
}
