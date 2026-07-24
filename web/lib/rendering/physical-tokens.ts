import type { ScreenProfile } from "./contracts";

/**
 * Renderer design units use the conventional 160 px/in baseline. A value in
 * these units has a stable physical size on every trusted screen profile.
 */
export const RENDER_DENSITY_BASELINE_PPI = 160;

export interface PhysicalScreenMetrics {
  ppiX: number;
  ppiY: number;
  ppi: number;
  pixelsPerMm: number;
  densityScale: number;
}

export interface LogicalPhysicalSizeMm {
  width: number;
  height: number;
}

export interface PhysicalLayoutTokens extends PhysicalScreenMetrics {
  spacing: {
    hair: number;
    xs: number;
    sm: number;
    md: number;
    lg: number;
    xl: number;
  };
  stroke: {
    standard: number;
    strong: number;
  };
  radius: {
    small: number;
    medium: number;
    large: number;
  };
  icon: {
    small: number;
    medium: number;
    large: number;
  };
  pageInset: number;
  minimumTouchTarget: number;
}

function roundedPixel(value: number): number {
  return Math.max(1, Math.round(value));
}

export function physicalScreenMetrics(profile: ScreenProfile): PhysicalScreenMetrics {
  const ppiX = profile.nativeSize.width / (profile.physicalSizeMm.width / 25.4);
  const ppiY = profile.nativeSize.height / (profile.physicalSizeMm.height / 25.4);
  const ppi = Math.sqrt(ppiX * ppiY);
  return {
    ppiX,
    ppiY,
    ppi,
    pixelsPerMm: ppi / 25.4,
    densityScale: ppi / RENDER_DENSITY_BASELINE_PPI,
  };
}

/** Active panel size expressed in the current logical orientation. */
export function logicalPhysicalSizeMm(profile: ScreenProfile): LogicalPhysicalSizeMm {
  const rotated = profile.displayRotation === 90 || profile.displayRotation === 270;
  return rotated
    ? { width: profile.physicalSizeMm.height, height: profile.physicalSizeMm.width }
    : profile.physicalSizeMm;
}

/** Convert a renderer design unit to native panel pixels. */
export function rendererUnitsToPixels(profile: ScreenProfile, units: number): number {
  return units * physicalScreenMetrics(profile).densityScale;
}

/** Convert a physical millimetre target to native panel pixels. */
export function millimetresToPixels(profile: ScreenProfile, millimetres: number): number {
  return millimetres * physicalScreenMetrics(profile).pixelsPerMm;
}

/**
 * Shared physical primitives used by every semantic layout. Content JSON never
 * sees these values: only the trusted screen profile selects the pixel output.
 */
export function physicalLayoutTokens(profile: ScreenProfile): PhysicalLayoutTokens {
  const metrics = physicalScreenMetrics(profile);
  const px = (units: number) => roundedPixel(units * metrics.densityScale);
  return {
    ...metrics,
    spacing: {
      hair: px(2),
      xs: px(3),
      sm: px(5),
      md: px(8),
      lg: px(12),
      xl: px(18),
    },
    stroke: {
      // ceil keeps a high-density e-paper rule from collapsing to one faint
      // device pixel after rasterisation and grayscale quantisation.
      standard: Math.max(1, Math.ceil(metrics.densityScale)),
      strong: Math.max(2, Math.ceil(metrics.densityScale * 1.5)),
    },
    radius: {
      small: px(3),
      medium: px(6),
      large: px(10),
    },
    icon: {
      small: px(16),
      medium: px(22),
      large: px(30),
    },
    pageInset: px(14),
    // Seven millimetres is large enough for a deliberate finger tap without
    // forcing phone-sized 44 CSS-pixel assumptions onto e-paper hardware.
    minimumTouchTarget: profile.touch.enabled
      ? roundedPixel(metrics.pixelsPerMm * 7)
      : 0,
  };
}
