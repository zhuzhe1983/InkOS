import { describe, expect, it } from "vitest";

import { GET } from "./route";

const EXPECTED_PATHS = [
  "/apps/execute",
  "/generator/jobs",
  "/generator/jobs/{jobId}",
  "/generator/jobs/{jobId}/artifact",
  "/generator/jobs/{jobId}/events",
  "/openapi.json",
  "/packages",
  "/packages/{packageId}/documents/{uuid}",
  "/packages/{packageId}/download",
  "/packages/{packageId}/frames/{variantId}/{uuid}/{pageIndex}",
  "/packages/{packageId}/frames/{variantId}/{uuid}/{pageIndex}/sidecar",
  "/packages/{packageId}/manifest",
  "/packages/{packageId}/render",
  "/render",
  "/sources/resolve",
  "/time",
];

describe("InkOS OpenAPI service surface", () => {
  it("documents every public v1 route and uses unique operation IDs", async () => {
    const response = await GET();
    const document = await response.json() as {
      paths: Record<string, Record<string, { operationId?: string }>>;
    };
    expect(Object.keys(document.paths).sort()).toEqual(EXPECTED_PATHS);
    const operationIds = Object.values(document.paths).flatMap((path) =>
      Object.values(path).map((operation) => operation.operationId).filter(Boolean),
    );
    expect(new Set(operationIds).size).toBe(operationIds.length);
  });

  it("describes packageId resources as revision-floating and revalidated", async () => {
    const document = await (await GET()).json() as {
      paths: Record<string, unknown>;
    };
    const serialized = JSON.stringify(document.paths);
    expect(serialized).toContain("revision-floating");
    expect(serialized).toContain("max-age=60, must-revalidate");
    expect(serialized.toLowerCase()).not.toContain("immutable");
  });

  it("requires the verified manifest ETag on every manifest-derived GET", async () => {
    const document = await (await GET()).json() as {
      paths: Record<string, {
        get: {
          parameters: Array<{ name?: string; required?: boolean }>;
          responses: Record<string, unknown>;
        };
      }>;
    };
    const paths = [
      "/packages/{packageId}/documents/{uuid}",
      "/packages/{packageId}/frames/{variantId}/{uuid}/{pageIndex}",
      "/packages/{packageId}/frames/{variantId}/{uuid}/{pageIndex}/sidecar",
    ];
    for (const path of paths) {
      const operation = document.paths[path].get;
      expect(operation.parameters).toContainEqual(expect.objectContaining({
        name: "If-Match",
        required: true,
      }));
      expect(operation.responses).toHaveProperty("412");
      expect(operation.responses).toHaveProperty("428");
    }
  });

  it("publishes explicit default home identifiers instead of relying on catalog order", async () => {
    const document = await (await GET()).json() as {
      components: {
        schemas: {
          PackageCatalog: {
            required: string[];
            properties: Record<string, unknown>;
          };
        };
      };
    };
    const schema = document.components.schemas.PackageCatalog;
    expect(schema.required).toEqual(expect.arrayContaining([
      "defaultPackageId",
      "defaultEntryUuid",
    ]));
    expect(schema.properties).toHaveProperty("defaultPackageId");
    expect(schema.properties).toHaveProperty("defaultEntryUuid");
  });

  it("publishes bounded PaperS3 output-tuning controls on render requests", async () => {
    const document = await (await GET()).json() as {
      components: { schemas: Record<string, unknown> };
    };
    const online = JSON.stringify(document.components.schemas.OnlineRenderRequest);
    const packaged = JSON.stringify(document.components.schemas.PackageRenderRequest);
    for (const schema of [online, packaged]) {
      expect(schema).toContain("outputTuning");
      expect(schema).toContain("gamma");
      expect(schema).toContain("photoContrast");
      expect(schema).toContain("photo-ordered-16");
      expect(schema).toContain("supersampling");
    }
  });

  it("documents the optional fail-closed PaperS3 refresh hint", async () => {
    const document = await (await GET()).json() as {
      paths: Record<string, {
        post: {
          responses: {
            "200": { headers: Record<string, unknown> };
          };
        };
      }>;
    };
    for (const path of ["/render", "/packages/{packageId}/render"]) {
      expect(document.paths[path].post.responses["200"].headers)
        .toHaveProperty("X-Ink-Refresh-Hint");
      expect(JSON.stringify(
        document.paths[path].post.responses["200"].headers["X-Ink-Refresh-Hint"],
      )).toContain("binary-text");
    }
  });

  it("removes inverse generation from the public request matrix", async () => {
    const document = await (await GET()).json() as {
      components: { schemas: Record<string, unknown> };
    };
    const generator = JSON.stringify(document.components.schemas.GeneratorRequest);
    expect(generator).not.toContain("invertModes");
  });

  it("documents the exact server-owned app allowlist and bounded image gallery", async () => {
    const document = await (await GET()).json() as {
      components: { schemas: Record<string, unknown> };
      paths: Record<string, unknown>;
    };
    const schema = JSON.stringify(document.components.schemas.AppExecuteRequest);
    const operation = JSON.stringify(document.paths["/apps/execute"]);
    expect(schema).toContain("inkos://app/random-image");
    expect(schema).toContain("inkos://app/baidu-map");
    expect(schema).toContain('"maxItems":16');
    expect(schema).toContain('"maximum":15');
    expect(operation).toContain("X-Ink-App-Page-Index");
    expect(operation).toContain("photo-papers3-slideshow-gray16-rgb-png-v3");
    expect(operation).toContain("diagnostic-raw-colour-png-v1");
  });
});
