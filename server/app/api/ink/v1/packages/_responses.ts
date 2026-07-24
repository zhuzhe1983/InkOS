import { sha256Hex } from "@/lib/ink/archive";
import {
  InkCatalogInputError,
  type InkCatalogArtifact,
  type LoadedInkCatalogPackage,
} from "@/lib/ink/catalog-store";
import { problemResponse } from "@/lib/ink/http";

function etag(sha256: string): string {
  return `"${sha256}"`;
}

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function requestMatches(request: Request, sha256: string): boolean {
  const header = request.headers.get("If-None-Match");
  if (!header) return false;
  const expected = etag(sha256);
  return header
    .split(",")
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === "*" || candidate === expected || candidate === `W/${expected}`);
}

function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function artifactResponse(
  request: Request,
  artifact: InkCatalogArtifact,
  loaded: LoadedInkCatalogPackage,
): Response {
  const headers = new Headers({
    ETag: etag(artifact.sha256),
    "Cache-Control": artifact.cacheControl,
    "X-Content-Type-Options": "nosniff",
    "X-Ink-Package-Id": loaded.manifest.packageId,
    "X-Ink-Package-Revision": String(loaded.manifest.revision),
    "X-Ink-Manifest-SHA256": loaded.manifestSha256,
    "X-Ink-SHA256": artifact.sha256,
  });
  if (requestMatches(request, artifact.sha256)) return new Response(null, { status: 304, headers });

  headers.set("Content-Type", artifact.contentType);
  headers.set("Content-Length", String(artifact.bytes.byteLength));
  if (artifact.fileName) {
    headers.set(
      "Content-Disposition",
      `attachment; filename="package.ink"; filename*=UTF-8''${rfc5987(artifact.fileName)}`,
    );
  }
  return new Response(new Uint8Array(artifact.bytes), { headers });
}

/**
 * packageId resource URLs always point at the newest published revision. Any
 * resource selected from a previously fetched manifest must therefore carry
 * that manifest's strong ETag. Check this before looking up the document/frame
 * so a resource removed by a newer revision cannot be mistaken for a 404.
 */
export function manifestPreconditionFailure(
  request: Request,
  loaded: LoadedInkCatalogPackage,
): Response | undefined {
  const value = request.headers.get("If-Match");
  if (value === null) {
    return noStore(problemResponse(
      request,
      428,
      "MANIFEST_PRECONDITION_REQUIRED",
      "Manifest precondition required",
      "Send the strong manifest ETag in If-Match before requesting a manifest-derived resource",
    ));
  }
  if (value.trim() === etag(loaded.manifestSha256)) return undefined;

  const response = noStore(problemResponse(
    request,
    412,
    "PACKAGE_REVISION_CHANGED",
    "Package manifest changed",
    "Reload the package manifest and retry the complete resource transaction",
  ));
  response.headers.set("X-Ink-Package-Id", loaded.manifest.packageId);
  response.headers.set("X-Ink-Package-Revision", String(loaded.manifest.revision));
  response.headers.set("X-Ink-Manifest-SHA256", loaded.manifestSha256);
  return response;
}

export async function catalogJsonResponse(request: Request, value: unknown): Promise<Response> {
  const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  const sha256 = await sha256Hex(bytes);
  const headers = new Headers({
    ETag: etag(sha256),
    "Cache-Control": "public, max-age=15, must-revalidate",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  if (requestMatches(request, sha256)) return new Response(null, { status: 304, headers });
  headers.set("Content-Length", String(bytes.byteLength));
  return new Response(bytes, { headers });
}

export function catalogFailure(request: Request, error: unknown): Response {
  if (error instanceof InkCatalogInputError) {
    const response = problemResponse(request, 400, "INVALID_REQUEST", "Invalid package request", error.message);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
  const response = problemResponse(
    request,
    500,
    "INTERNAL_ERROR",
    "Package catalog failed",
    error instanceof Error ? error.message : "Unknown package catalog failure",
    true,
  );
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export function catalogNotFound(
  request: Request,
  code: string,
  title: string,
  detail: string,
): Response {
  const response = problemResponse(request, 404, code, title, detail);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
