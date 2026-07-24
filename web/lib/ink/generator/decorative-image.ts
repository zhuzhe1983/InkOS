const DECORATIVE_ROLE = /^(?:none|presentation)$/iu;
const DECORATIVE_DESCRIPTOR =
  /(?:^|[-_\s/])(arrow|avatar|badge|bullet|divider|emoji|icon|logo|next|pixel|prev|profile|separator|spacer|spinner|tracking)(?:[-_\s/.]|$)/iu;

const SMALL_SQUARE_EDGE = 64;
const HAIRLINE_EDGE = 4;
const THIN_EDGE = 24;
const THIN_MAXIMUM_EDGE = 320;
const EXTREME_ASPECT_RATIO = 8;
const DESCRIPTOR_MAXIMUM_EDGE = 192;
const PROTECTED_CONTENT_DESCRIPTOR = /(?:\b(?:bar\s*code|barcode|qr|qr\s*code|qrcode)\b|二维码|条形码|条码)/iu;

export interface SemanticImageMetadata {
  alt?: string | null;
  ariaHidden?: string | null;
  caption?: string | null;
  className?: string | null;
  height?: string | number | null;
  id?: string | null;
  parentClassName?: string | null;
  renderedHeight?: string | number | null;
  renderedHidden?: string | boolean | null;
  renderedWidth?: string | number | null;
  role?: string | null;
  source?: string | null;
  width?: string | number | null;
}

function dimension(value: string | number | null | undefined): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;
  const candidate = value?.trim();
  if (!candidate || !/^\d+(?:\.\d+)?(?:px)?$/iu.test(candidate)) return undefined;
  const parsed = Number.parseFloat(candidate);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function preferredDimension(
  rendered: string | number | null | undefined,
  declared: string | number | null | undefined,
): number | undefined {
  const renderedDimension = dimension(rendered);
  const declaredDimension = dimension(declared);
  // A lazy image may be 0x0 before it reaches the viewport while still
  // carrying trustworthy intrinsic/declaration dimensions. Explicit visual
  // hiding is captured separately and must not be inferred from this zero.
  return renderedDimension !== undefined && renderedDimension > 0
    ? renderedDimension
    : declaredDimension !== undefined && declaredDimension > 0
      ? declaredDimension
      : undefined;
}

function meaningfulText(value: string | null | undefined): boolean {
  return /[\p{L}\p{N}]/u.test(value?.trim() ?? "");
}

/**
 * Reject non-editorial images before they enter inkos.content/v2. Chromium
 * snapshots supply rendered dimensions; plain HTTP ingestion falls back to
 * width/height and conservative semantic hints.
 */
export function isDecorativeImage(metadata: SemanticImageMetadata): boolean {
  if (metadata.ariaHidden?.trim().toLocaleLowerCase() === "true") return true;
  if (DECORATIVE_ROLE.test(metadata.role?.trim() ?? "")) return true;
  if (
    metadata.renderedHidden === true
    || (typeof metadata.renderedHidden === "string"
      && metadata.renderedHidden.trim().toLocaleLowerCase() === "true")
  ) return true;

  const width = preferredDimension(metadata.renderedWidth, metadata.width);
  const height = preferredDimension(metadata.renderedHeight, metadata.height);
  const descriptor = [
    metadata.className,
    metadata.id,
    metadata.parentClassName,
    metadata.source,
  ].filter(Boolean).join(" ");
  const descriptorSaysDecorative = DECORATIVE_DESCRIPTOR.test(descriptor);
  const protectedContent = PROTECTED_CONTENT_DESCRIPTOR.test([
    descriptor,
    metadata.alt,
    metadata.caption,
  ].filter(Boolean).join(" "));
  const hasEditorialLabel = meaningfulText(metadata.alt) || meaningfulText(metadata.caption);
  const renderedCollapsed = dimension(metadata.renderedWidth) === 0
    || dimension(metadata.renderedHeight) === 0;

  const declaredWidth = dimension(metadata.width);
  const declaredHeight = dimension(metadata.height);
  const hasPositiveDeclaredSize = (declaredWidth ?? 0) > 0 && (declaredHeight ?? 0) > 0;
  if (declaredWidth === 0 || declaredHeight === 0) return true;
  if (
    renderedCollapsed
    && !hasPositiveDeclaredSize
    && !hasEditorialLabel
    && !protectedContent
  ) return true;

  if (width !== undefined && height !== undefined) {
    if (width <= HAIRLINE_EDGE || height <= HAIRLINE_EDGE) return true;
    if (protectedContent) return false;

    const shortest = Math.min(width, height);
    const longest = Math.max(width, height);
    if (descriptorSaysDecorative && longest <= DESCRIPTOR_MAXIMUM_EDGE) return true;
    if (!hasEditorialLabel && width <= SMALL_SQUARE_EDGE && height <= SMALL_SQUARE_EDGE) return true;
    if (!hasEditorialLabel && shortest <= THIN_EDGE && longest <= THIN_MAXIMUM_EDGE) return true;
    if (!hasEditorialLabel && longest / shortest >= EXTREME_ASPECT_RATIO && shortest <= 32) return true;
    return false;
  }

  // Static HTML frequently omits dimensions. Only discard images whose own
  // semantics clearly identify UI chrome; an unlabelled photo is not enough.
  return descriptorSaysDecorative && !protectedContent;
}

export const DECORATIVE_IMAGE_LIMITS = Object.freeze({
  smallSquareEdge: SMALL_SQUARE_EDGE,
  hairlineEdge: HAIRLINE_EDGE,
  thinEdge: THIN_EDGE,
  thinMaximumEdge: THIN_MAXIMUM_EDGE,
  extremeAspectRatio: EXTREME_ASPECT_RATIO,
});
