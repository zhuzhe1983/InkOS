import { getInkCatalogPackage, getInkManifestArtifact } from "@/lib/ink/catalog-store";

import { artifactResponse, catalogFailure, catalogNotFound } from "@/app/api/ink/v1/packages/_responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ packageId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { packageId } = await context.params;
    const loaded = await getInkCatalogPackage(packageId);
    if (!loaded) {
      return catalogNotFound(request, "PACKAGE_NOT_FOUND", "Package not found", "No verified package has that packageId");
    }
    return artifactResponse(request, getInkManifestArtifact(loaded), loaded);
  } catch (error) {
    return catalogFailure(request, error);
  }
}
