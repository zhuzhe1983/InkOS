import type { InkDynamicRegion } from "@/lib/ink/contracts";
import type { InkClientAppUrl } from "@/lib/ink/app-actions";

export const PAPER_S3_FRAME_SIZE = {
  width: 540,
  height: 960,
} as const;

export const PAPER_S3_LANDSCAPE_FRAME_SIZE = {
  width: 960,
  height: 540,
} as const;

export type InkFontLevel = -2 | -1 | 0 | 1 | 2;
export type InkScreenOrientation = "portrait" | "landscape";
export type InkSourceMode = "online" | "offline";
export type InkDocumentKind = "list" | "detail" | "reader" | "image";

export interface InkDisplayPreferences {
  readonly orientation: InkScreenOrientation;
  readonly fontLevel: InkFontLevel;
  readonly invert: boolean;
}

export function paperS3FrameSize(orientation: InkScreenOrientation): {
  readonly width: number;
  readonly height: number;
} {
  return orientation === "landscape"
    ? PAPER_S3_LANDSCAPE_FRAME_SIZE
    : PAPER_S3_FRAME_SIZE;
}

export interface InkLinkBounds {
  /** Pixel coordinates in the selected renderer-owned PaperS3 logical frame. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface InkLinkHitbox {
  readonly id: string;
  readonly label: string;
  /** Packaged-document destination, or the current document as a v1 fallback for targetUrl. */
  readonly targetUuid: string;
  /** When present, the client asks the InkOS server to resolve this URL before navigation. */
  readonly targetUrl?: string;
  readonly bounds: InkLinkBounds;
}

export interface InkRenderedPage {
  readonly index: number;
  readonly count: number;
  readonly pixelSize: {
    readonly width: number;
    readonly height: number;
  };
  readonly imageUrl: string;
  readonly imageAlt: string;
  /** Verified renderer-owned local overlays; absent for legacy sidecars. */
  readonly dynamicRegions?: readonly InkDynamicRegion[];
  /**
   * Renderer-owned interaction metadata. Clients must overlay these bounds as-is
   * and must never infer links by inspecting or laying out the rendered pixels.
   */
  readonly linkHitboxes: readonly InkLinkHitbox[];
}

export interface InkDocumentDescriptor {
  readonly uuid: string;
  readonly parentUuid?: string;
  readonly kind: InkDocumentKind;
  readonly title: string;
  readonly revision: number;
}

export interface InkSourceDescriptor {
  readonly mode: InkSourceMode;
  readonly label: string;
  readonly detail: string;
  /** Authoritative package identity used for copyable deep links. */
  readonly packageId?: string;
  /** Server-normalized source URL, when the package came from URL resolution. */
  readonly sourceUrl?: string;
  readonly packageFilename?: string;
  readonly verified: boolean;
}

export interface InkRuntimeView {
  readonly document: InkDocumentDescriptor;
  readonly page: InkRenderedPage;
  readonly source: InkSourceDescriptor;
}

export interface InkOpenRequest {
  readonly uuid: string;
  readonly pageIndex: number;
  readonly sourceMode: InkSourceMode;
  readonly display: InkDisplayPreferences;
}

export interface InkArchiveInstallResult {
  readonly packageId: string;
  readonly title: string;
  readonly revision: number;
  readonly entryUuid: string;
  readonly filename: string;
  readonly documentCount: number;
  readonly variantCount: number;
}

export type InkOnlineSourcePhase =
  | "resolving"
  | "queued"
  | "fetching"
  | "extracting"
  | "rendering"
  | "packaging"
  | "loading-package"
  | "ready";

export interface InkOnlineSourceProgress {
  readonly phase: InkOnlineSourcePhase;
  readonly message: string;
  readonly completed?: number;
  readonly total?: number;
}

export interface InkOnlineSourcePreparationOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: InkOnlineSourceProgress) => void;
  /** Exact frame variant whose entry page must verify and decode before commit. */
  readonly display?: InkDisplayPreferences;
  /** Optional deep-link assertions and exact frame to stage before committing. */
  readonly expectedPackageId?: string;
  readonly targetUuid?: string;
  readonly pageIndex?: number;
}

export interface InkOnlineSourceResult {
  readonly normalizedUrl: string;
  readonly packageId: string;
  readonly entryUuid: string;
  readonly cached: boolean;
}

export interface InkOnlinePackagePreparationOptions {
  readonly signal?: AbortSignal;
  readonly display?: InkDisplayPreferences;
  /** Exact document/page that must verify and decode before package selection commits. */
  readonly targetUuid?: string;
  readonly pageIndex?: number;
  /** Optional entry UUID copied into a deep link; a mismatch is rejected. */
  readonly expectedEntryUuid?: string;
}

export interface InkOnlinePackageResult {
  readonly packageId: string;
  readonly entryUuid: string;
}

export interface InkAppPreparationOptions {
  readonly signal?: AbortSignal;
  readonly display?: InkDisplayPreferences;
}

export interface InkAppPreparationResult {
  readonly action: InkClientAppUrl;
  readonly documentUuid: string;
  readonly nonce: string;
  readonly requestedAtUnixMs: number;
}

/**
 * Boundary between the thin client and either the online service or an opened
 * versioned .ink archive. The shared runtime can implement this interface
 * without changing the PaperS3 UI or its gesture rules.
 */
export interface InkClientRuntimeAdapter {
  readonly adapterId: string;
  /** Returns an already-resolved root, or undefined when the source must first be prepared. */
  getRootUuid(sourceMode: InkSourceMode): string | undefined;
  /** Loads a catalog/manifest when a source root is not known synchronously. */
  resolveRootUuid?(sourceMode: InkSourceMode, signal?: AbortSignal): Promise<string>;
  /** Resolves/generates a URL source and atomically selects its exact online package. */
  prepareOnlineSource?(
    url: string,
    options?: InkOnlineSourcePreparationOptions,
  ): Promise<InkOnlineSourceResult>;
  /** Selects an exact catalog package for a shareable package/document deep link. */
  prepareOnlinePackage?(
    packageId: string,
    options?: InkOnlinePackagePreparationOptions,
  ): Promise<InkOnlinePackageResult>;
  /** Executes one exact server-owned app and atomically stages its verified frame. */
  prepareAppAction?(
    action: InkClientAppUrl,
    options?: InkAppPreparationOptions,
  ): Promise<InkAppPreparationResult>;
  open(request: InkOpenRequest, signal?: AbortSignal): Promise<InkRuntimeView>;
  /** Optional package-client capability used by the browser UI. */
  installArchive?(
    archive: File | ArrayBuffer | Uint8Array,
    filename?: string,
    signal?: AbortSignal,
    /** Display variant whose entry frame must decode before an atomic install commits. */
    display?: InkDisplayPreferences,
  ): Promise<InkArchiveInstallResult>;
  dispose?(): void;
}
