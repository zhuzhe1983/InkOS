import type { DisplayMeta } from "../rendering/contracts";
import type { InkDisplayVariant, InkPackageManifest } from "./contracts";

export function outputTuningKey(displayMeta: DisplayMeta): string {
  const tuning = displayMeta.outputTuning;
  if (!tuning) return "";
  return [
    tuning.gamma ?? "",
    tuning.contrast ?? "",
    tuning.blackPoint ?? "",
    tuning.whitePoint ?? "",
    tuning.sharpen ?? "",
    tuning.photoContrast ?? "",
    tuning.quantization ?? "",
    tuning.supersampling ?? "",
  ].join("|");
}

function tuningDigest(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function inkVariantId(profileId: string, displayMeta: DisplayMeta): string {
  const profile = profileId.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-");
  const font = displayMeta.fontLevel < 0 ? `m${Math.abs(displayMeta.fontLevel)}` : `p${displayMeta.fontLevel}`;
  const tuningKey = outputTuningKey(displayMeta);
  const tuning = tuningKey ? `.tune-${tuningDigest(tuningKey)}` : "";
  // Preserve the legacy `.normal.` identifier so previously generated normal
  // packages remain byte-addressable; no negative variant can be created.
  return `${profile}.${displayMeta.orientation}.normal.font-${font}${tuning}`;
}

export function findExactVariant(
  manifest: InkPackageManifest,
  profileId: string,
  displayMeta: DisplayMeta,
): InkDisplayVariant | undefined {
  return manifest.variants.find((variant) => {
    return variant.profileId === profileId
      && variant.displayMeta.orientation === displayMeta.orientation
      && variant.displayMeta.fontLevel === displayMeta.fontLevel
      && outputTuningKey(variant.displayMeta) === outputTuningKey(displayMeta);
  });
}
