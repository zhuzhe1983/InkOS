import { ZodError } from "zod";

import { problemResponse } from "@/lib/ink/http";
import { createGeneratorJob, GeneratorStoreError } from "@/lib/ink/generator/job-store";
import { enqueueGeneratorJob } from "@/lib/ink/generator/runner";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json();
    const created = await createGeneratorJob(body, request.headers.get("Idempotency-Key") ?? undefined);
    if (created.created) enqueueGeneratorJob(created.job.jobId);
    return Response.json(created.job, {
      status: 202,
      headers: {
        Location: created.job.statusUrl,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof GeneratorStoreError && error.code === "IDEMPOTENCY_CONFLICT") {
      return problemResponse(request, 409, error.code, "Idempotency conflict", error.message);
    }
    if (error instanceof ZodError || error instanceof SyntaxError) {
      const detail = error instanceof ZodError
        ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
        : "Request body must be valid JSON";
      return problemResponse(request, 400, "INVALID_REQUEST", "Invalid generator request", detail);
    }
    return problemResponse(
      request,
      500,
      "INTERNAL_ERROR",
      "Generator job could not be created",
      error instanceof Error ? error.message : "Unknown job creation failure",
      true,
    );
  }
}
