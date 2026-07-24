import { ZodError } from "zod";

import { base64UrlJson, problemResponse } from "@/lib/ink/http";
import { createInkDisplayVariant } from "@/lib/ink/package-builder";
import { onlineRenderRequestSchema, ONLINE_PACKAGE_ID } from "@/lib/ink/service-contracts";
import { frameSidecar } from "@/lib/ink/sidecar";
import { renderEngine } from "@/lib/rendering/engine";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    const input = onlineRenderRequestSchema.parse(await request.json());
    const variant = createInkDisplayVariant(input.profileId, input.displayMeta);
    const frame = await renderEngine.render({
      profileId: input.profileId,
      document: input.document.content,
      localWidgets: input.document.localWidgets,
      displayMeta: input.displayMeta,
      navigationContext: input.navigationContext,
      pageIndex: input.pageIndex,
    });
    const imagePath = `online/${variant.id}/${input.document.uuid}/${input.pageIndex
      .toString()
      .padStart(4, "0")}.png`;
    const sidecar = frameSidecar({
      packageId: input.packageId ?? ONLINE_PACKAGE_ID,
      document: input.document,
      variant,
      frame,
      imagePath,
    });

    return new Response(new Uint8Array(frame.payload), {
      headers: {
        "Content-Type": frame.contentType,
        "Content-Length": String(frame.payload.byteLength),
        "Cache-Control": "private, max-age=0, must-revalidate",
        ETag: `"${frame.manifest.sha256}"`,
        "X-Ink-Sidecar": base64UrlJson(sidecar),
        "X-Ink-Frame-Manifest": base64UrlJson(frame.manifest),
        "X-Ink-Warnings": base64UrlJson(frame.warnings),
        ...(frame.manifest.refreshHint
          ? { "X-Ink-Refresh-Hint": frame.manifest.refreshHint }
          : {}),
        "Access-Control-Expose-Headers":
          "X-Ink-Sidecar, X-Ink-Frame-Manifest, X-Ink-Warnings, X-Ink-Refresh-Hint, ETag",
      },
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return problemResponse(
        request,
        400,
        "INVALID_REQUEST",
        "Invalid render request",
        error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      );
    }
    return problemResponse(
      request,
      422,
      "RENDER_FAILED",
      "Frame rendering failed",
      error instanceof Error ? error.message : "Unknown render failure",
    );
  }
}
