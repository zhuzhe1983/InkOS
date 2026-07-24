import type { InkScreenOrientation } from "./runtime-adapter";

interface ScreenOrientationLike {
  readonly type?: string;
  addEventListener?(type: "change", listener: () => void): void;
  removeEventListener?(type: "change", listener: () => void): void;
}

interface OrientationWindowLike {
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly screen?: { readonly orientation?: ScreenOrientationLike };
  readonly visualViewport?: {
    readonly width: number;
    readonly height: number;
    addEventListener(type: "resize", listener: () => void): void;
    removeEventListener(type: "resize", listener: () => void): void;
  } | null;
  addEventListener(type: "orientationchange" | "resize", listener: () => void): void;
  removeEventListener(type: "orientationchange" | "resize", listener: () => void): void;
  requestAnimationFrame(callback: () => void): number;
  cancelAnimationFrame(handle: number): void;
}

export interface ObserveScreenOrientationOptions {
  /** Publish the current orientation immediately after subscribing. */
  publishInitial?: boolean;
}

/**
 * Screen Orientation is sourced from the browser first because it already
 * incorporates the phone sensor, OS rotation lock and the active viewport.
 * Viewport geometry is the compatibility fallback for older iOS browsers.
 */
export function currentScreenOrientation(
  source: Pick<OrientationWindowLike, "innerWidth" | "innerHeight" | "screen" | "visualViewport">,
): InkScreenOrientation {
  const type = source.screen?.orientation?.type;
  if (type?.startsWith("landscape")) return "landscape";
  if (type?.startsWith("portrait")) return "portrait";

  const width = source.visualViewport?.width ?? source.innerWidth;
  const height = source.visualViewport?.height ?? source.innerHeight;
  return width > height ? "landscape" : "portrait";
}

/** Observe sensor-backed screen rotation without requesting motion permission. */
export function observeScreenOrientation(
  source: OrientationWindowLike,
  listener: (orientation: InkScreenOrientation) => void,
  options: ObserveScreenOrientationOptions = {},
): () => void {
  let frame: number | undefined;
  let previous = currentScreenOrientation(source);
  const publish = () => {
    frame = undefined;
    const next = currentScreenOrientation(source);
    if (next === previous) return;
    previous = next;
    listener(next);
  };
  const schedule = () => {
    if (frame !== undefined) source.cancelAnimationFrame(frame);
    frame = source.requestAnimationFrame(publish);
  };

  const orientation = source.screen?.orientation;
  orientation?.addEventListener?.("change", schedule);
  source.addEventListener("orientationchange", schedule);
  source.addEventListener("resize", schedule);
  source.visualViewport?.addEventListener("resize", schedule);
  if (options.publishInitial !== false) listener(previous);

  return () => {
    if (frame !== undefined) source.cancelAnimationFrame(frame);
    orientation?.removeEventListener?.("change", schedule);
    source.removeEventListener("orientationchange", schedule);
    source.removeEventListener("resize", schedule);
    source.visualViewport?.removeEventListener("resize", schedule);
  };
}
