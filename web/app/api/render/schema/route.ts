import { z } from "zod";

import {
  contentDocumentSchema,
  renderRequestSchema,
  screenProfileSchema,
} from "@/lib/rendering/contracts";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return Response.json({
    contentDocument: z.toJSONSchema(contentDocumentSchema, { io: "input" }),
    screenProfile: z.toJSONSchema(screenProfileSchema),
    renderRequest: z.toJSONSchema(renderRequestSchema, { io: "input" }),
  });
}
