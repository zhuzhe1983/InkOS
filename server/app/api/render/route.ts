import { ZodError } from "zod";

import { renderRequestSchema } from "@/lib/rendering/contracts";
import { renderEngine } from "@/lib/rendering/engine";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    const input = renderRequestSchema.parse(await request.json());
    const frame = await renderEngine.render(input);
    const encodedManifest = Buffer.from(JSON.stringify(frame.manifest)).toString("base64url");

    return new Response(new Uint8Array(frame.payload), {
      headers: {
        "Content-Type": frame.contentType,
        "Content-Length": String(frame.payload.byteLength),
        "Cache-Control": "no-store",
        ETag: `"${frame.manifest.sha256}"`,
        "X-Inkos-Frame-Id": frame.manifest.frameId,
        "X-Inkos-Manifest": encodedManifest,
        "X-Inkos-Warnings": Buffer.from(JSON.stringify(frame.warnings)).toString("base64url"),
        "Access-Control-Expose-Headers": "X-Inkos-Frame-Id, X-Inkos-Manifest, X-Inkos-Warnings, ETag",
      },
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json(
        { error: "INVALID_RENDER_REQUEST", issues: error.issues },
        { status: 400 },
      );
    }

    const message = error instanceof Error ? error.message : "Unknown render failure";
    return Response.json({ error: "RENDER_FAILED", message }, { status: 422 });
  }
}
