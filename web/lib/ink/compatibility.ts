import type { InkCapability, InkPackageManifest } from "./contracts";

export interface InkClientDescriptor {
  client: "web" | "paperS3";
  version: string;
  formatMajor: number;
  capabilities: readonly InkCapability[];
  profileIds: readonly string[];
}

export interface InkCompatibilityResult {
  compatible: boolean;
  errors: string[];
}

function versionParts(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
  if (!match) throw new Error(`Invalid semantic version '${version}'`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareSemanticVersions(left: string, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

export function assessInkCompatibility(
  manifest: InkPackageManifest,
  client: InkClientDescriptor,
): InkCompatibilityResult {
  const errors: string[] = [];
  if (client.formatMajor !== manifest.compatibility.formatMajor) {
    errors.push(`Package format major ${manifest.compatibility.formatMajor} is unsupported`);
  }

  const minimumVersion = manifest.compatibility.minimumClientVersions[client.client];
  if (compareSemanticVersions(client.version, minimumVersion) < 0) {
    errors.push(`${client.client} client ${client.version} is older than required ${minimumVersion}`);
  }

  const capabilities = new Set(client.capabilities);
  for (const capability of manifest.compatibility.requiredCapabilities) {
    // Packages produced before inversion was retired commonly declared this
    // token even when every packaged variant used normal polarity. The manifest
    // schema already rejects any `invert: true` variant, so such a token is a
    // harmless legacy declaration rather than a runtime requirement.
    if (capability === "display.invert-v1") continue;
    if (!capabilities.has(capability)) errors.push(`Missing required capability '${capability}'`);
  }

  const supportedProfiles = new Set(client.profileIds);
  if (!manifest.variants.some((variant) => supportedProfiles.has(variant.profileId))) {
    errors.push("Package has no display variant for a client profile");
  }

  return { compatible: errors.length === 0, errors };
}
