import { timingSafeEqual } from "node:crypto";

import { ZodError } from "zod";

import {
  getInkCatalogPackage,
  InkCatalogInputError,
  type LoadedInkCatalogPackage,
} from "@/lib/ink/catalog-store";
import { base64UrlJson, problemResponse } from "@/lib/ink/http";
import {
  inkPackageRenderRuntime,
  type InkPackageRenderRuntime,
} from "@/lib/ink/package-renderer";
import { packageRenderRequestSchema } from "@/lib/ink/service-contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ packageId: string }>;
}

export interface PackageRenderRouteDependencies {
  getPackage?: (packageId: string) => Promise<LoadedInkCatalogPackage | undefined>;
  renderRuntime?: InkPackageRenderRuntime;
}

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function ifMatchSha256(request: Request): string | undefined {
  const value = request.headers.get("If-Match");
  if (value === null) return undefined;
  const match = /^"([a-f0-9]{64})"$/u.exec(value.trim());
  if (!match) throw new Error("If-Match must contain one strong manifest SHA-256 ETag");
  return match[1];
}

function sameSha256(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export async function handlePackageRender(
  request: Request,
  context: RouteContext,
  dependencies: PackageRenderRouteDependencies = {},
): Promise<Response> {
  let packageId: string;
  let input;
  let manifestSha256: string | undefined;
  try {
    packageId = (await context.params).packageId;
    input = packageRenderRequestSchema.parse(await request.json());
    const headerSha256 = ifMatchSha256(request);
    if (
      input.manifestSha256
      && headerSha256
      && !sameSha256(input.manifestSha256, headerSha256)
    ) {
      throw new Error("manifestSha256 and If-Match identify different manifests");
    }
    manifestSha256 = input.manifestSha256 ?? headerSha256;
  } catch (error) {
    const detail = error instanceof ZodError
      ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
      : error instanceof SyntaxError
        ? "Request body must be valid JSON"
        : error instanceof Error
          ? error.message
          : "Invalid render request";
    return noStore(problemResponse(
      request,
      400,
      "INVALID_REQUEST",
      "Invalid package render request",
      detail,
    ));
  }

  if (!manifestSha256) {
    return noStore(problemResponse(
      request,
      428,
      "MANIFEST_PRECONDITION_REQUIRED",
      "Manifest precondition required",
      "Provide manifestSha256 in the request body or the manifest ETag in If-Match",
    ));
  }

  let loaded: LoadedInkCatalogPackage | undefined;
  try {
    loaded = await (dependencies.getPackage ?? getInkCatalogPackage)(packageId);
  } catch (error) {
    if (error instanceof InkCatalogInputError) {
      return noStore(problemResponse(
        request,
        400,
        "INVALID_REQUEST",
        "Invalid package render request",
        error.message,
      ));
    }
    return noStore(problemResponse(
      request,
      500,
      "INTERNAL_ERROR",
      "Package catalog failed",
      error instanceof Error ? error.message : "Unknown package catalog failure",
      true,
    ));
  }

  if (!loaded) {
    return noStore(problemResponse(
      request,
      404,
      "PACKAGE_NOT_FOUND",
      "Package not found",
      "No verified package has that packageId",
    ));
  }
  if (!sameSha256(manifestSha256, loaded.manifestSha256)) {
    return noStore(problemResponse(
      request,
      412,
      "PACKAGE_REVISION_CHANGED",
      "Package manifest changed",
      "Reload the package manifest before requesting an on-demand frame",
    ));
  }
  if (!loaded.contents.documents.has(input.documentUuid)) {
    return noStore(problemResponse(
      request,
      404,
      "DOCUMENT_NOT_FOUND",
      "Document not found",
      "The package does not contain that document UUID",
    ));
  }

  try {
    const rendered = await (dependencies.renderRuntime ?? inkPackageRenderRuntime)
      .render(loaded, input);
    const { frame, sidecar } = rendered;
    const exposedHeaders = [
      "ETag",
      "X-Ink-SHA256",
      "X-Ink-Frame-Manifest",
      "X-Ink-Sidecar",
      "X-Ink-Warnings",
      "X-Ink-Package-Id",
      "X-Ink-Package-Revision",
      "X-Ink-Manifest-SHA256",
      "X-Ink-Requested-Page-Index",
      "X-Ink-Actual-Page-Index",
      "X-Ink-Refresh-Hint",
    ];
    return new Response(new Uint8Array(frame.payload), {
      headers: {
        "Content-Type": frame.contentType,
        "Content-Length": String(frame.payload.byteLength),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ETag: `"${frame.manifest.sha256}"`,
        "X-Ink-SHA256": frame.manifest.sha256,
        "X-Ink-Frame-Manifest": base64UrlJson(frame.manifest),
        "X-Ink-Sidecar": base64UrlJson(sidecar),
        "X-Ink-Warnings": base64UrlJson(frame.warnings),
        "X-Ink-Package-Id": loaded.manifest.packageId,
        "X-Ink-Package-Revision": String(loaded.manifest.revision),
        "X-Ink-Manifest-SHA256": loaded.manifestSha256,
        "X-Ink-Requested-Page-Index": String(rendered.requestedPageIndex),
        "X-Ink-Actual-Page-Index": String(rendered.actualPageIndex),
        ...(frame.manifest.refreshHint
          ? { "X-Ink-Refresh-Hint": frame.manifest.refreshHint }
          : {}),
        "Access-Control-Expose-Headers": exposedHeaders.join(", "),
      },
    });
  } catch (error) {
    return noStore(problemResponse(
      request,
      422,
      "RENDER_FAILED",
      "Package frame rendering failed",
      error instanceof Error ? error.message : "Unknown render failure",
    ));
  }
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return handlePackageRender(request, context);
}
