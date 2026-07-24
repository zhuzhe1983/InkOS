import type { InkLinkHitbox, InkRuntimeView } from "./runtime-adapter";

export type NavigationIntent =
  | "parent"
  | "next-page"
  | "previous-page-or-parent";

export type NavigationCommand =
  | { readonly kind: "open-parent"; readonly uuid: string }
  | { readonly kind: "open-page"; readonly pageIndex: number }
  | { readonly kind: "none"; readonly reason: "root" | "first-page" | "last-page" };

export interface PointerPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Renderer hitboxes may overlap (for example a photo inside a linked card).
 * The protocol selects the smallest containing half-open rectangle; equal
 * areas retain sidecar order.
 */
export function hitboxAt(
  point: PointerPoint,
  hitboxes: readonly InkLinkHitbox[],
): InkLinkHitbox | undefined {
  let winner: InkLinkHitbox | undefined;
  let winnerArea = Number.POSITIVE_INFINITY;
  for (const hitbox of hitboxes) {
    const { x, y, width, height } = hitbox.bounds;
    if (
      point.x < x
      || point.y < y
      || point.x >= x + width
      || point.y >= y + height
    ) continue;
    const area = width * height;
    if (area < winnerArea) {
      winner = hitbox;
      winnerArea = area;
    }
  }
  return winner;
}

export interface SwipeOptions {
  readonly threshold?: number;
  readonly dominanceRatio?: number;
}

export const PAPERS3_SWIPE_MIN_DISTANCE_PX = 56;
export const PAPERS3_SWIPE_SHORT_EDGE_RATIO = 0.1;
export const PAPERS3_SWIPE_DOMINANCE_RATIO = 1.4;
export const PAPERS3_SWIPE_MIN_DURATION_MS = 60;
export const PAPERS3_SWIPE_MAX_DURATION_MS = 2_000;

export interface ReleasedSwipeOptions {
  /** Pointer travel time measured between pointerdown and pointerup. */
  readonly durationMs: number;
  /** Short edge of the visible screen in the same logical pixels as the pointer points. */
  readonly shortEdge: number;
}

export function intentFromSwipe(
  start: PointerPoint,
  end: PointerPoint,
  options: SwipeOptions = {},
): NavigationIntent | null {
  const threshold = options.threshold ?? PAPERS3_SWIPE_MIN_DISTANCE_PX;
  const dominanceRatio = options.dominanceRatio ?? PAPERS3_SWIPE_DOMINANCE_RATIO;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const absoluteX = Math.abs(dx);
  const absoluteY = Math.abs(dy);

  if (dx <= -threshold && absoluteX >= absoluteY * dominanceRatio) {
    return "parent";
  }

  if (dy <= -threshold && absoluteY >= absoluteX * dominanceRatio) {
    return "next-page";
  }

  if (dy >= threshold && absoluteY >= absoluteX * dominanceRatio) {
    return "previous-page-or-parent";
  }

  return null;
}

/**
 * PaperS3 navigation is committed only after release. Short taps, slow holds,
 * diagonal drags and motion below either physical threshold remain inert.
 */
export function intentFromReleasedPaperS3Swipe(
  start: PointerPoint,
  end: PointerPoint,
  options: ReleasedSwipeOptions,
): NavigationIntent | null {
  if (
    !Number.isFinite(options.durationMs)
    || options.durationMs < PAPERS3_SWIPE_MIN_DURATION_MS
    || options.durationMs > PAPERS3_SWIPE_MAX_DURATION_MS
    || !Number.isFinite(options.shortEdge)
    || options.shortEdge <= 0
  ) return null;

  return intentFromSwipe(start, end, {
    threshold: Math.max(
      PAPERS3_SWIPE_MIN_DISTANCE_PX,
      options.shortEdge * PAPERS3_SWIPE_SHORT_EDGE_RATIO,
    ),
    dominanceRatio: PAPERS3_SWIPE_DOMINANCE_RATIO,
  });
}

export function intentFromKeyboard(key: string): NavigationIntent | null {
  switch (key) {
    case "ArrowLeft":
    case "Escape":
      return "parent";
    case "ArrowUp":
    case "PageDown":
      return "next-page";
    case "ArrowDown":
    case "PageUp":
      return "previous-page-or-parent";
    default:
      return null;
  }
}

/**
 * A previous layer can either be the document parent declared by the active
 * package or a source-history visit maintained by the browser client.
 */
export function requestsPreviousLayer(
  intent: NavigationIntent,
  view: Pick<InkRuntimeView, "page">,
): boolean {
  if (intent === "parent") return true;
  if (intent === "previous-page-or-parent") return view.page.index === 0;
  return view.page.index + 1 >= view.page.count;
}

export function resolveNavigation(
  intent: NavigationIntent,
  view: Pick<InkRuntimeView, "document" | "page">,
): NavigationCommand {
  if (intent === "parent") {
    return view.document.parentUuid
      ? { kind: "open-parent", uuid: view.document.parentUuid }
      : { kind: "none", reason: "root" };
  }

  if (intent === "next-page") {
    if (view.page.index + 1 < view.page.count) {
      return { kind: "open-page", pageIndex: view.page.index + 1 };
    }
    return view.document.parentUuid
      ? { kind: "open-parent", uuid: view.document.parentUuid }
      : { kind: "none", reason: "last-page" };
  }

  if (view.page.index > 0) {
    return { kind: "open-page", pageIndex: view.page.index - 1 };
  }

  return view.document.parentUuid
    ? { kind: "open-parent", uuid: view.document.parentUuid }
    : { kind: "none", reason: "first-page" };
}
