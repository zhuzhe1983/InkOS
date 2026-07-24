import { ZodError } from "zod";

import { problemResponse } from "@/lib/ink/http";
import {
  isIdempotencyConflict,
  resolveSource,
  type SourceResolverDependencies,
} from "@/lib/ink/generator/source-resolver";

export const runtime = "nodejs";

export async function handleSourceResolve(
  request: Request,
  dependencies: SourceResolverDependencies = {},
): Promise<Response> {
  const startedAt = performance.now();
  try {
    const resolution = await resolveSource(await request.json(), dependencies);
    const status = resolution.status === "complete" ? 200 : 202;
    const location = resolution.statusUrl ?? resolution.manifestUrl;
    return Response.json(resolution, {
      status,
      headers: {
        ...(location ? { Location: location } : {}),
        "Cache-Control": "no-store",
        "Server-Timing": `source_resolve;dur=${(performance.now() - startedAt).toFixed(1)}`,
        "X-InkOS-Source-Cache": resolution.stale ? "stale" : resolution.cached ? "hit" : "miss",
      },
    });
  } catch (error) {
    if (isIdempotencyConflict(error)) {
      return problemResponse(request, 409, error.code, "Idempotency conflict", error.message);
    }
    if (error instanceof ZodError || error instanceof SyntaxError) {
      const detail = error instanceof ZodError
        ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
        : "Request body must be valid JSON";
      return problemResponse(request, 400, "INVALID_REQUEST", "Invalid source URL", detail);
    }
    return problemResponse(
      request,
      500,
      "INTERNAL_ERROR",
      "Source could not be resolved",
      error instanceof Error ? error.message : "Unknown source resolution failure",
      true,
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  return handleSourceResolve(request);
}
