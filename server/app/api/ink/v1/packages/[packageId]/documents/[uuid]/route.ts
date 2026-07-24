import { getInkCatalogPackage, getInkDocumentArtifact } from "@/lib/ink/catalog-store";

import {
  artifactResponse,
  catalogFailure,
  catalogNotFound,
  manifestPreconditionFailure,
} from "@/app/api/ink/v1/packages/_responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ packageId: string; uuid: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { packageId, uuid } = await context.params;
    const loaded = await getInkCatalogPackage(packageId);
    if (!loaded) {
      return catalogNotFound(request, "PACKAGE_NOT_FOUND", "Package not found", "No verified package has that packageId");
    }
    const preconditionFailure = manifestPreconditionFailure(request, loaded);
    if (preconditionFailure) return preconditionFailure;
    const artifact = getInkDocumentArtifact(loaded, uuid);
    if (!artifact) {
      return catalogNotFound(request, "DOCUMENT_NOT_FOUND", "Document not found", "The package does not contain that document UUID");
    }
    return artifactResponse(request, artifact, loaded);
  } catch (error) {
    return catalogFailure(request, error);
  }
}
