import { getInkCatalogPackage, getInkSidecarArtifact } from "@/lib/ink/catalog-store";

import {
  artifactResponse,
  catalogFailure,
  catalogNotFound,
  manifestPreconditionFailure,
} from "@/app/api/ink/v1/packages/_responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ packageId: string; variantId: string; uuid: string; pageIndex: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { packageId, variantId, uuid, pageIndex } = await context.params;
    const loaded = await getInkCatalogPackage(packageId);
    if (!loaded) {
      return catalogNotFound(request, "PACKAGE_NOT_FOUND", "Package not found", "No verified package has that packageId");
    }
    const preconditionFailure = manifestPreconditionFailure(request, loaded);
    if (preconditionFailure) return preconditionFailure;
    const artifact = getInkSidecarArtifact(loaded, variantId, uuid, pageIndex);
    if (!artifact) {
      return catalogNotFound(request, "SIDECAR_NOT_FOUND", "Sidecar not found", "The package does not contain that exact frame sidecar");
    }
    return artifactResponse(request, artifact, loaded);
  } catch (error) {
    return catalogFailure(request, error);
  }
}
