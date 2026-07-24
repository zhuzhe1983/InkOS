import type { RenderedFrame } from "../rendering/contracts";
import {
  inkFrameSidecarSchema,
  type InkDynamicRegion,
  type InkDisplayVariant,
  type InkFrameSidecar,
  type PackagedDocument,
} from "./contracts";

export interface FrameSidecarInput {
  packageId: string;
  document: PackagedDocument;
  variant: InkDisplayVariant;
  frame: RenderedFrame;
  imagePath: string;
  packagedUuids?: ReadonlySet<string>;
  /** Canonical URL fallback for an RSS/Atom feed's packaged detail targets. */
  feedDetailFallbackUrls?: ReadonlyMap<string, string>;
}

export function feedDetailFallbackUrlsForDocuments(
  documents: Iterable<PackagedDocument>,
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const document of documents) {
    if (document.content.page.kind !== "detail" || !document.source.url) continue;
    try {
      const parsed = new URL(document.source.url);
      if (
        parsed.protocol === "https:"
        && !parsed.username
        && !parsed.password
        && (!parsed.port || parsed.port === "443")
      ) {
        result.set(document.uuid, parsed.href);
      }
    } catch {
      // Invalid source envelopes are rejected before packaging. Keep this
      // recovery index independently fail-closed.
    }
  }
  return result;
}

function dynamicRegionsForFrame(
  document: PackagedDocument,
  frame: RenderedFrame,
): InkDynamicRegion[] {
  const widgets = document.localWidgets ?? [];
  if (widgets.length === 0) return [];
  if (frame.manifest.pagination.pageIndex !== 0) return [];

  return widgets.map((widget) => {
    const matches = (frame.textRegions ?? []).filter((region) =>
      region.contentPath === widget.contentPath
    );
    if (matches.length !== 1) {
      throw new Error(
        `Local widget '${widget.id}' must map to exactly one first-page text region; found ${matches.length}`,
      );
    }
    const region = matches[0];
    if (region.style.fontFamily !== "monospace") {
      throw new Error(`Local clock widget '${widget.id}' was not rendered with a monospace fallback`);
    }
    const safeClockFontSize = Math.max(8, Math.min(
      region.style.fontSize,
      Math.floor(region.bounds.height * 0.72),
      Math.floor(region.bounds.width / 5.4),
    ));
    return {
      id: widget.id,
      kind: "clock",
      bounds: region.bounds,
      format: widget.format,
      timezone: widget.timezone,
      refreshMs: widget.refreshMs,
      fullRefreshEvery: widget.fullRefreshEvery,
      style: {
        fontFamily: "monospace",
        fontSize: safeClockFontSize,
        fontWeight: region.style.fontWeight,
        textAlign: region.style.textAlign,
        verticalAlign: "middle",
        foreground: "black",
        background: "white",
      },
    };
  });
}

export function frameSidecar(input: FrameSidecarInput): InkFrameSidecar {
  const { document, frame, packagedUuids, variant } = input;
  if (frame.manifest.documentId !== document.uuid) {
    throw new Error("Rendered frame document ID does not match its package envelope");
  }
  if (
    frame.manifest.logicalSize.width !== variant.logicalSize.width ||
    frame.manifest.logicalSize.height !== variant.logicalSize.height
  ) {
    throw new Error("Rendered frame logical size does not match its display variant");
  }

  const interactions = frame.manifest.interactions.map((interaction) => {
    const targetUuid = interaction.action.type === "open-document"
      ? interaction.action.documentId
      : document.uuid;
    if (packagedUuids && !packagedUuids.has(targetUuid)) {
      throw new Error(`Rendered interaction links missing UUID '${targetUuid}'`);
    }
    const packagedDetailFallbackUrl = interaction.action.type === "open-document"
      && (
        (
          document.content.page.kind === "list"
          && document.content.page.layout === "feed"
        )
        || (
          document.content.page.kind === "detail"
          && interaction.contentPath.startsWith("page.navigation[")
        )
      )
      ? input.feedDetailFallbackUrls?.get(targetUuid)
      : undefined;
    return {
      id: interaction.contentPath,
      contentPath: interaction.contentPath,
      label: interaction.label,
      bounds: interaction.bounds,
      targetUuid,
      ...(interaction.action.type === "open-url"
        ? { targetUrl: interaction.action.url }
        : packagedDetailFallbackUrl
          ? { fallbackUrl: packagedDetailFallbackUrl }
          : {}),
    };
  });
  const dynamicRegions = dynamicRegionsForFrame(document, frame);

  return inkFrameSidecarSchema.parse({
    schemaVersion: "inkos.frame-sidecar/v1",
    packageId: input.packageId,
    documentUuid: document.uuid,
    ...(document.parentUuid ? { parentUuid: document.parentUuid } : {}),
    variantId: variant.id,
    pageIndex: frame.manifest.pagination.pageIndex,
    pageCount: frame.manifest.pagination.pageCount,
    imagePath: input.imagePath,
    imageSha256: frame.manifest.sha256,
    logicalSize: frame.manifest.logicalSize,
    interactions,
    ...(dynamicRegions.length > 0 ? { dynamicRegions } : {}),
  });
}
