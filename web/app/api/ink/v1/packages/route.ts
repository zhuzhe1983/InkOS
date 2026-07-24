import {
  listInkCatalogPackages,
  type InkCatalogEntry,
} from "@/lib/ink/catalog-store";
import {
  ensurePaperS3HomePackage,
  PAPERS3_HOME_ENTRY_UUID,
  PAPERS3_HOME_PACKAGE_ID,
} from "@/lib/ink/builtin/papers3-home";

import { catalogFailure, catalogJsonResponse } from "./_responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface PackageCatalogRouteDependencies {
  ensureHome?: () => Promise<unknown>;
  listPackages?: () => Promise<InkCatalogEntry[]>;
}

export async function handlePackageCatalog(
  request: Request,
  dependencies: PackageCatalogRouteDependencies = {},
): Promise<Response> {
  try {
    await (dependencies.ensureHome ?? ensurePaperS3HomePackage)();
    const packages = (await (dependencies.listPackages ?? listInkCatalogPackages)()).sort((left, right) => {
      if (left.packageId === PAPERS3_HOME_PACKAGE_ID) return -1;
      if (right.packageId === PAPERS3_HOME_PACKAGE_ID) return 1;
      return left.packageId.localeCompare(right.packageId);
    });
    const home = packages.find((entry) => entry.packageId === PAPERS3_HOME_PACKAGE_ID);
    if (!home || home.entryUuid !== PAPERS3_HOME_ENTRY_UUID) {
      throw new Error("Verified PaperS3 home package is missing from the catalog");
    }
    return await catalogJsonResponse(request, {
      schemaVersion: "inkos.package-catalog/v1",
      defaultPackageId: PAPERS3_HOME_PACKAGE_ID,
      defaultEntryUuid: PAPERS3_HOME_ENTRY_UUID,
      packages,
    });
  } catch (error) {
    return catalogFailure(request, error);
  }
}

export async function GET(request: Request): Promise<Response> {
  return handlePackageCatalog(request);
}
