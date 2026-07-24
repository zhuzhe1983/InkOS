import { ZodError } from "zod";

import {
  InkAppServiceError,
  executeInkApp,
  type InkAppServiceDependencies,
} from "@/lib/ink/apps/service";
import { base64UrlJson, problemResponse } from "@/lib/ink/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function handleAppExecute(
  request: Request,
  dependencies: InkAppServiceDependencies = {},
): Promise<Response> {
  try {
    const executed = await executeInkApp(await request.json(), dependencies);
    const { frame, request: input, sidecar } = executed;
    return new Response(new Uint8Array(frame.payload), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(frame.payload.byteLength),
        "Cache-Control": "no-store",
        Pragma: "no-cache",
        "X-Content-Type-Options": "nosniff",
        ETag: `"${frame.manifest.sha256}"`,
        "X-Ink-SHA256": frame.manifest.sha256,
        "X-Ink-Frame-Manifest": base64UrlJson(frame.manifest),
        "X-Ink-Sidecar": base64UrlJson(sidecar),
        "X-Ink-Warnings": base64UrlJson(frame.warnings),
        "X-Ink-App-Action": input.action,
        "X-Ink-App-Nonce": input.nonce,
        "X-Ink-App-Requested-At": String(input.requestedAtUnixMs),
        "X-Ink-App-Page-Index": String(input.pageIndex),
        "X-Ink-App-Image-Mode": executed.imageMode,
        "Access-Control-Expose-Headers": [
          "ETag",
          "X-Ink-SHA256",
          "X-Ink-Frame-Manifest",
          "X-Ink-Sidecar",
          "X-Ink-Warnings",
          "X-Ink-App-Action",
          "X-Ink-App-Nonce",
          "X-Ink-App-Requested-At",
          "X-Ink-App-Page-Index",
          "X-Ink-App-Image-Mode",
        ].join(", "),
      },
    });
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) {
      const detail = error instanceof ZodError
        ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
        : "Request body must be valid JSON";
      return problemResponse(request, 400, "INVALID_APP_REQUEST", "Invalid app request", detail);
    }
    if (error instanceof InkAppServiceError) {
      return problemResponse(
        request,
        error.status,
        error.code,
        "App execution failed",
        error.message,
        error.retryable,
      );
    }
    return problemResponse(
      request,
      500,
      "APP_EXECUTION_FAILED",
      "App execution failed",
      "应用执行失败，服务端未暴露上游请求细节。",
      true,
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  return handleAppExecute(request);
}
