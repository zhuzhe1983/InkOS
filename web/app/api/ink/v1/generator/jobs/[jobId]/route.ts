import { problemResponse } from "@/lib/ink/http";
import {
  cancelGeneratorJob,
  GeneratorStoreError,
  readGeneratorJob,
} from "@/lib/ink/generator/job-store";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ jobId: string }>;
}

function storeProblem(request: Request, error: GeneratorStoreError): Response {
  return problemResponse(request, 404, error.code, "Generator job not found", error.message);
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { jobId } = await context.params;
    return Response.json(await readGeneratorJob(jobId), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof GeneratorStoreError) return storeProblem(request, error);
    return problemResponse(request, 500, "INTERNAL_ERROR", "Job status could not be read", "Internal job storage failure", true);
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { jobId } = await context.params;
    return Response.json(await cancelGeneratorJob(jobId), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof GeneratorStoreError) return storeProblem(request, error);
    return problemResponse(request, 500, "INTERNAL_ERROR", "Job could not be cancelled", "Internal job storage failure", true);
  }
}
