import { screenProfiles } from "@/lib/rendering/profiles";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return Response.json({
    schemaVersion: "inkos.screen-registry/v1",
    profiles: screenProfiles,
  });
}
