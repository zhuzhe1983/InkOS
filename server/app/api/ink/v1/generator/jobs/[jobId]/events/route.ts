import { problemResponse } from "@/lib/ink/http";
import { GeneratorStoreError, readGeneratorJob } from "@/lib/ink/generator/job-store";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ jobId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { jobId } = await context.params;
    const job = await readGeneratorJob(jobId);
    const event = `retry: 1200\nevent: snapshot\ndata: ${JSON.stringify(job)}\n\n`;
    return new Response(event, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    if (error instanceof GeneratorStoreError) {
      return problemResponse(request, 404, error.code, "Generator job not found", error.message);
    }
    return problemResponse(request, 500, "INTERNAL_ERROR", "Job events could not be read", "Internal job storage failure", true);
  }
}
