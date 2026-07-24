import { z } from "zod";

import {
  screenProfileSchema,
  type DisplayMeta,
  type ScreenProfile,
} from "./contracts";

const profiles = [
  {
    schemaVersion: "inkos.screen/v1",
    id: "m5stack-paper-s3-portrait",
    version: 2,
    label: "M5Stack PaperS3",
    deviceType: "paper-s3",
    layoutStrategy: "paper-s3-semantic-v1",
    rasterStrategy: "eink-gray4-png-v1",
    nativeSize: { width: 960, height: 540 },
    // ED047TC1 active area. The panel is 58.32 x 103.68 mm in portrait.
    physicalSizeMm: { width: 103.68, height: 58.32 },
    logicalSize: { width: 540, height: 960 },
    displayRotation: 90,
    orientationRotations: { portrait: 90, landscape: 0 },
    safeArea: { top: 20, right: 20, bottom: 20, left: 20 },
    color: { mode: "grayscale", levels: 16 },
    pixelFormat: "gray4",
    touch: { enabled: true },
    refresh: { supportsPartial: true, xAlignment: 8, yAlignment: 1 },
  },
  {
    schemaVersion: "inkos.screen/v1",
    id: "m5stack-xiaozhi-card",
    version: 2,
    label: "M5Stack Xiaozhi Card Kit",
    deviceType: "xiaozhi-card-kit",
    layoutStrategy: "xiaozhi-card-semantic-v1",
    rasterStrategy: "eink-mono1-png-v1",
    nativeSize: { width: 176, height: 264 },
    // GDEY027T91 active area (0.217 mm square pixel pitch).
    physicalSizeMm: { width: 38.192, height: 57.288 },
    logicalSize: { width: 176, height: 264 },
    displayRotation: 0,
    orientationRotations: { portrait: 0, landscape: 90 },
    safeArea: { top: 8, right: 8, bottom: 8, left: 8 },
    color: { mode: "monochrome", levels: 2 },
    pixelFormat: "mono1",
    touch: { enabled: true },
    refresh: { supportsPartial: true, xAlignment: 8, yAlignment: 1 },
  },
  {
    schemaVersion: "inkos.screen/v1",
    id: "m5stack-paper-color",
    version: 2,
    label: "M5Stack PaperColor",
    deviceType: "paper-color",
    layoutStrategy: "paper-color-semantic-v1",
    rasterStrategy: "eink-spectra6-photo-dither-png-v2",
    nativeSize: { width: 400, height: 600 },
    // EL040EF1 / ED2208-DOA active area (0.141 mm square pixel pitch).
    physicalSizeMm: { width: 56.4, height: 84.6 },
    logicalSize: { width: 400, height: 600 },
    displayRotation: 0,
    orientationRotations: { portrait: 0, landscape: 90 },
    safeArea: { top: 14, right: 14, bottom: 14, left: 14 },
    color: { mode: "color", levels: 6, palette: "spectra6" },
    pixelFormat: "spectra6",
    touch: { enabled: false },
    refresh: { supportsPartial: false, xAlignment: 1, yAlignment: 1 },
  },
] satisfies Array<z.input<typeof screenProfileSchema>>;

function freezeScreenProfile(profile: ScreenProfile): ScreenProfile {
  Object.freeze(profile.nativeSize);
  Object.freeze(profile.physicalSizeMm);
  Object.freeze(profile.logicalSize);
  Object.freeze(profile.orientationRotations);
  Object.freeze(profile.safeArea);
  Object.freeze(profile.color);
  Object.freeze(profile.touch);
  Object.freeze(profile.refresh);
  return Object.freeze(profile);
}

// Keep the public registry immutable so a request cannot mutate a shared device profile.
export const screenProfiles: ReadonlyArray<ScreenProfile> = Object.freeze(
  profiles.map((profile) => freezeScreenProfile(screenProfileSchema.parse(profile))),
);

export function getScreenProfile(profileId: string): ScreenProfile {
  const profile = screenProfiles.find((item) => item.id === profileId);
  if (!profile) {
    throw new Error(`Unknown screen profile: ${profileId}`);
  }
  return profile;
}

function profileOrientation(profile: ScreenProfile): DisplayMeta["orientation"] {
  return profile.logicalSize.width > profile.logicalSize.height ? "landscape" : "portrait";
}

function rotateSafeArea(
  safeArea: ScreenProfile["safeArea"],
  delta: number,
): ScreenProfile["safeArea"] {
  switch (delta) {
    case 90:
      return {
        top: safeArea.left,
        right: safeArea.top,
        bottom: safeArea.right,
        left: safeArea.bottom,
      };
    case 180:
      return {
        top: safeArea.bottom,
        right: safeArea.left,
        bottom: safeArea.top,
        left: safeArea.right,
      };
    case 270:
      return {
        top: safeArea.right,
        right: safeArea.bottom,
        bottom: safeArea.left,
        left: safeArea.top,
      };
    default:
      return safeArea;
  }
}

/**
 * Derive a request-scoped logical screen from immutable panel metadata. The
 * native panel never changes; only the logical canvas, rotation and logical
 * safe-area edges change for layout and output metadata.
 */
export function orientScreenProfile(
  profile: ScreenProfile,
  orientation: DisplayMeta["orientation"],
): ScreenProfile {
  if (profileOrientation(profile) === orientation) return profile;

  const targetRotation = profile.orientationRotations[orientation];
  const rotated = targetRotation === 90 || targetRotation === 270;
  const delta = (targetRotation - profile.displayRotation + 360) % 360;
  const swapRefreshAxes = delta === 90 || delta === 270;

  return freezeScreenProfile(screenProfileSchema.parse({
    ...profile,
    logicalSize: rotated
      ? { width: profile.nativeSize.height, height: profile.nativeSize.width }
      : profile.nativeSize,
    displayRotation: targetRotation,
    safeArea: rotateSafeArea(profile.safeArea, delta),
    refresh: swapRefreshAxes
      ? {
          ...profile.refresh,
          xAlignment: profile.refresh.yAlignment,
          yAlignment: profile.refresh.xAlignment,
        }
      : profile.refresh,
  }));
}
