import { readFile, stat } from "node:fs/promises";

import { problemResponse } from "@/lib/ink/http";
import {
  generatorArtifactPath,
  GeneratorStoreError,
  readGeneratorJob,
} from "@/lib/ink/generator/job-store";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ jobId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { jobId } = await context.params;
    const job = await readGeneratorJob(jobId);
    if (job.status !== "complete" || !job.package) {
      return problemResponse(
        request,
        409,
        "JOB_NOT_READY",
        "Package artifact is not ready",
        `Generator job is currently '${job.status}'`,
        job.status === "queued" || job.status === "running",
      );
    }
    const artifactPath = generatorArtifactPath(jobId);
    const [artifact, metadata] = await Promise.all([readFile(artifactPath), stat(artifactPath)]);
    if (metadata.size !== job.package.bytes) throw new Error("Artifact size does not match job metadata");
    return new Response(new Uint8Array(artifact), {
      headers: {
        "Content-Type": "application/vnd.inkos.package+zip",
        "Content-Length": String(artifact.byteLength),
        "Content-Disposition": `attachment; filename="${job.package.fileName}"`,
        "Cache-Control": "private, max-age=0, must-revalidate",
        ETag: `"${job.package.sha256}"`,
        "X-Ink-Package-Id": job.package.packageId,
        "X-Ink-Package-Sha256": job.package.sha256,
      },
    });
  } catch (error) {
    if (error instanceof GeneratorStoreError) {
      return problemResponse(request, 404, error.code, "Generator job not found", error.message);
    }
    return problemResponse(
      request,
      500,
      "INTERNAL_ERROR",
      "Package artifact could not be read",
      error instanceof Error ? error.message : "Internal artifact storage failure",
      true,
    );
  }
}
