import { z } from "zod";

import {
  inkFrameSidecarSchema,
  inkPackageManifestSchema,
  packagedDocumentSchema,
} from "@/lib/ink/contracts";
import {
  generatorJobSchema,
  generatorRequestSchema,
} from "@/lib/ink/generator/contracts";
import { sourceResolveRequestSchema } from "@/lib/ink/generator/source-resolver";
import {
  appExecuteRequestSchema,
  inkTimeResponseSchema,
  onlineRenderRequestSchema,
  packageRenderRequestSchema,
} from "@/lib/ink/service-contracts";

export const runtime = "nodejs";

const problem = (description: string) => ({
  description,
  content: {
    "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } },
  },
});

const catalogArtifactHeaders = {
  ETag: { description: "Strong SHA-256 entity tag.", schema: { type: "string" } },
  "Cache-Control": {
    description: "Revision-floating v1 URLs use public, max-age=60, must-revalidate.",
    schema: { type: "string" },
  },
  "Content-Length": { schema: { type: "integer", minimum: 0 } },
  "X-Ink-Package-Id": { schema: { type: "string", format: "uuid" } },
  "X-Ink-Package-Revision": { schema: { type: "integer", minimum: 1 } },
  "X-Ink-Manifest-SHA256": { schema: { type: "string", pattern: "^[a-f0-9]{64}$" } },
  "X-Ink-SHA256": { schema: { type: "string", pattern: "^[a-f0-9]{64}$" } },
};

const manifestIfMatch = {
  in: "header",
  name: "If-Match",
  required: true,
  description: "Strong ETag of the exact package manifest used to select this resource.",
  schema: { type: "string", pattern: '^"[a-f0-9]{64}"$' },
};

const conditionalNotModified = {
  description: "The caller's If-None-Match matches the current published revision artifact.",
  headers: catalogArtifactHeaders,
};

export function buildInkOpenApiDocument() {
  return {
    openapi: "3.1.0",
    info: {
      title: "InkOS Website Service API",
      version: "1.0.0",
      description: "Online e-paper rendering, verified package delivery and deterministic .ink generation.",
    },
    servers: [{ url: "/api/ink/v1" }],
    paths: {
      "/openapi.json": {
        get: {
          operationId: "getInkOpenApiDocument",
          summary: "Read this OpenAPI 3.1 service description",
          responses: {
            "200": {
              description: "OpenAPI document",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
      "/time": {
        get: {
          operationId: "getInkServerTime",
          summary: "Read server OS time for client RTT midpoint calibration",
          description: "Returns application-server wall time. This endpoint does not claim that a browser performs UDP NTP.",
          responses: {
            "200": {
              description: "Current server time; clients should measure request/response RTT and use its midpoint.",
              headers: {
                "Cache-Control": { schema: { const: "no-store" } },
                Date: { schema: { type: "string" } },
              },
              content: { "application/json": { schema: { $ref: "#/components/schemas/InkTime" } } },
            },
          },
        },
      },
      "/render": {
        post: {
          operationId: "renderInkFrame",
          summary: "Render one semantic document page for an exact display variant",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/OnlineRenderRequest" } },
            },
          },
          responses: {
            "200": {
              description: "Rendered PNG; sidecar, frame manifest and warnings are base64url JSON headers.",
              headers: {
                "Content-Length": { schema: { type: "integer", minimum: 1 } },
                "Cache-Control": {
                  schema: { type: "string" },
                  description: "private, max-age=0, must-revalidate",
                },
                "X-Ink-Sidecar": { schema: { type: "string" } },
                "X-Ink-Frame-Manifest": { schema: { type: "string" } },
                "X-Ink-Warnings": { schema: { type: "string" } },
                "X-Ink-Refresh-Hint": {
                  schema: { enum: ["binary-text"] },
                  description: "Optional advisory hint derived from semantic image absence and final PaperS3 gray4 pixels.",
                },
                ETag: { schema: { type: "string" } },
              },
              content: { "image/png": { schema: { type: "string", contentEncoding: "binary" } } },
            },
            "400": problem("Invalid request"),
            "422": problem("Render failure"),
          },
        },
      },
      "/apps/execute": {
        post: {
          operationId: "executeInkApp",
          summary: "Execute one exact server-owned PaperS3 application action",
          description: "Accepts only the random-image and Baidu-map inkos://app actions. The client supplies a fresh nonce and timestamp; random-image may include an ordered 16-item device image collection with one URL per page. External fetching and bounded contain/cover geometry remain server-side. Photos default to the PaperS3 slideshow pipeline: grayscale, 0.5% two-ended autocontrast, contrast 1.08, radius-1/65%/threshold-3 unsharp masking, serpentine Floyd-Steinberg quantization to sixteen levels, and stable bucket-centre RGB encoding. Setting imageProcessing to diagnostic-raw-colour explicitly bypasses grayscale, tone, sharpening, palette and dithering for either Image Viewer or Baidu Map while retaining safe fetch/decode and geometry. Responses are never source-package cached.",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/AppExecuteRequest" } },
            },
          },
          responses: {
            "200": {
              description: "No-store 8-bit RGB/RGBA PNG with verified frame and sidecar headers. Photos default to PaperS3 slideshow-compatible stable-gray16 processing; the explicit diagnostic-raw-colour request mode returns decoded upstream RGB after required geometry for both supported apps.",
              headers: {
                "Content-Length": { schema: { type: "integer", minimum: 1 } },
                "Cache-Control": { schema: { const: "no-store" } },
                ETag: { schema: { type: "string" } },
                "X-Ink-SHA256": { schema: { type: "string", pattern: "^[a-f0-9]{64}$" } },
                "X-Ink-Frame-Manifest": { schema: { type: "string" } },
                "X-Ink-Sidecar": { schema: { type: "string" } },
                "X-Ink-Warnings": { schema: { type: "string" } },
                "X-Ink-App-Action": { schema: { enum: ["inkos://app/random-image", "inkos://app/baidu-map"] } },
                "X-Ink-App-Nonce": { schema: { type: "string" } },
                "X-Ink-App-Requested-At": { schema: { type: "integer" } },
                "X-Ink-App-Page-Index": { schema: { type: "integer", minimum: 0, maximum: 15 } },
                "X-Ink-App-Image-Mode": {
                  schema: {
                    enum: [
                      "photo-papers3-slideshow-gray16-rgb-png-v3",
                      "diagnostic-raw-colour-png-v1",
                    ],
                  },
                },
              },
              content: { "image/png": { schema: { type: "string", contentEncoding: "binary" } } },
            },
            "400": problem("Invalid or non-allowlisted app action"),
            "502": problem("Controlled upstream image/location service unavailable"),
            "503": problem("Baidu map server credential is not configured"),
          },
        },
      },
      "/sources/resolve": {
        post: {
          operationId: "resolveInkSourceUrl",
          summary: "Resolve a server-fetched HTTPS page into a cached PaperS3 content package",
          description: "The client submits an HTTPS page or RSS/Atom URL and its current display settings. The server validates and fetches it, extracts semantic text/images/links (including feed summary/date metadata), assigns stable UUIDs, renders only the first requested variant, then reuses the semantic package for later on-demand display variants. Reserved inkos://collection links are client-only and rejected here.",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/SourceResolveRequest" } },
            },
          },
          responses: {
            "200": {
              description: "A verified published package was already cached and is ready to open.",
              headers: {
                Location: { description: "Manifest URL for a completed cached package.", schema: { type: "string" } },
                "Cache-Control": { schema: { const: "no-store" } },
              },
              content: { "application/json": { schema: { $ref: "#/components/schemas/SourceResolution" } } },
            },
            "202": {
              description: "A persistent generation job is queued/running, or a previous non-terminal job was reused.",
              headers: {
                Location: { description: "Generator job status URL.", schema: { type: "string" } },
                "Cache-Control": { schema: { const: "no-store" } },
              },
              content: { "application/json": { schema: { $ref: "#/components/schemas/SourceResolution" } } },
            },
            "400": problem("URL must be an absolute credential-free HTTPS URL on the default port"),
            "409": problem("Persistent source-resolution idempotency conflict"),
            "500": problem("Source resolution storage failure"),
          },
        },
      },
      "/generator/jobs": {
        post: {
          operationId: "createInkGeneratorJob",
          summary: "Create a persisted asynchronous .ink generation job",
          parameters: [{
            in: "header",
            name: "Idempotency-Key",
            required: false,
            schema: { type: "string", maxLength: 200 },
          }],
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/GeneratorRequest" } },
            },
          },
          responses: {
            "202": {
              description: "Job accepted, or an idempotent existing job returned.",
              headers: {
                Location: { schema: { type: "string" } },
                "Cache-Control": { schema: { const: "no-store" } },
              },
              content: { "application/json": { schema: { $ref: "#/components/schemas/GeneratorJob" } } },
            },
            "400": problem("Invalid request"),
            "409": problem("Idempotency conflict"),
            "500": problem("Generator storage or queue failure"),
          },
        },
      },
      "/generator/jobs/{jobId}": {
        get: {
          operationId: "getInkGeneratorJob",
          summary: "Read deterministic job phase and progress",
          parameters: [{ $ref: "#/components/parameters/JobId" }],
          responses: {
            "200": {
              description: "Current persisted job snapshot; Cache-Control is no-store.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/GeneratorJob" } } },
            },
            "404": problem("Job not found"),
            "500": problem("Job storage failure"),
          },
        },
        delete: {
          operationId: "cancelInkGeneratorJob",
          summary: "Cancel a queued or running job",
          parameters: [{ $ref: "#/components/parameters/JobId" }],
          responses: {
            "200": {
              description: "Cancelled or already-terminal job snapshot; Cache-Control is no-store.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/GeneratorJob" } } },
            },
            "404": problem("Job not found"),
            "500": problem("Job storage failure"),
          },
        },
      },
      "/generator/jobs/{jobId}/events": {
        get: {
          operationId: "getInkGeneratorJobEvents",
          summary: "Read a no-store Server-Sent Events job snapshot",
          parameters: [{ $ref: "#/components/parameters/JobId" }],
          responses: {
            "200": {
              description: "text/event-stream containing a snapshot event and retry interval.",
              headers: { "Cache-Control": { schema: { const: "no-store" } } },
              content: { "text/event-stream": { schema: { type: "string" } } },
            },
            "404": problem("Job not found"),
            "500": problem("Job storage failure"),
          },
        },
      },
      "/generator/jobs/{jobId}/artifact": {
        get: {
          operationId: "downloadInkGeneratorArtifact",
          summary: "Download the verified .ink artifact after completion",
          parameters: [{ $ref: "#/components/parameters/JobId" }],
          responses: {
            "200": {
              description: "Verified package archive; private and revalidated because this URL is job-scoped.",
              headers: {
                "Content-Length": { schema: { type: "integer", minimum: 1 } },
                "Content-Disposition": { schema: { type: "string" } },
                "Cache-Control": { schema: { const: "private, max-age=0, must-revalidate" } },
                ETag: { schema: { type: "string" } },
                "X-Ink-Package-Id": { schema: { type: "string", format: "uuid" } },
                "X-Ink-Package-Sha256": { schema: { type: "string", pattern: "^[a-f0-9]{64}$" } },
              },
              content: {
                "application/vnd.inkos.package+zip": {
                  schema: { type: "string", contentEncoding: "binary" },
                },
              },
            },
            "409": problem("Job is not complete"),
            "404": problem("Job not found"),
            "500": problem("Artifact storage failure"),
          },
        },
      },
      "/packages": {
        get: {
          operationId: "listInkPackages",
          summary: "List verified latest package revisions published by completed jobs",
          responses: {
            "200": {
              description: "Package catalog; public, max-age=15, must-revalidate with a strong ETag.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/PackageCatalog" } } },
            },
            "304": { description: "Catalog ETag matched." },
            "500": problem("Catalog storage failure"),
          },
        },
      },
      "/packages/{packageId}/manifest": {
        get: {
          operationId: "getInkPackageManifest",
          summary: "Read the latest published manifest in a package lineage",
          description: "The v1 packageId URL is revision-floating and must be revalidated; it is not revision-qualified.",
          parameters: [
            { $ref: "#/components/parameters/PackageId" },
            {
              in: "header",
              name: "If-None-Match",
              required: false,
              description: "Revalidate a previously cached manifest representation.",
              schema: { type: "string", pattern: '^"[a-f0-9]{64}"$' },
            },
          ],
          responses: {
            "200": {
              description: "inkos.package/v1 manifest for the current published revision.",
              headers: catalogArtifactHeaders,
              content: { "application/json": { schema: { $ref: "#/components/schemas/InkPackageManifest" } } },
            },
            "304": conditionalNotModified,
            "400": problem("Invalid package UUID"),
            "404": problem("Package not found"),
            "500": problem("Catalog storage failure"),
          },
        },
      },
      "/packages/{packageId}/documents/{uuid}": {
        get: {
          operationId: "getInkPackageDocument",
          summary: "Read one verified packaged semantic document",
          parameters: [
            { $ref: "#/components/parameters/PackageId" },
            { $ref: "#/components/parameters/DocumentUuid" },
            manifestIfMatch,
          ],
          responses: {
            "200": {
              description: "inkos.document/v1 envelope for the current published revision.",
              headers: catalogArtifactHeaders,
              content: { "application/json": { schema: { $ref: "#/components/schemas/PackagedDocument" } } },
            },
            "304": conditionalNotModified,
            "400": problem("Invalid package or document UUID"),
            "412": problem("The package manifest changed after the client verified it"),
            "428": problem("A strong manifest If-Match precondition is required"),
            "404": problem("Package or document not found"),
            "500": problem("Catalog storage failure"),
          },
        },
      },
      "/packages/{packageId}/render": {
        post: {
          operationId: "renderInkPackageFrameOnDemand",
          summary: "Render one verified packaged semantic document for an exact display",
          description: "High-priority synchronous rendering from the verified semantic package. The requested page is clamped after display-specific reflow; actual pagination is returned in the frame and sidecar headers.",
          parameters: [
            { $ref: "#/components/parameters/PackageId" },
            { ...manifestIfMatch, required: false },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/PackageRenderRequest" } },
            },
          },
          responses: {
            "200": {
              description: "On-demand PNG with base64url frame manifest, navigation sidecar and warnings.",
              headers: {
                ETag: { schema: { type: "string" } },
                "Content-Length": { schema: { type: "integer", minimum: 1 } },
                "Cache-Control": { schema: { const: "no-store" } },
                "X-Ink-SHA256": { schema: { type: "string", pattern: "^[a-f0-9]{64}$" } },
                "X-Ink-Frame-Manifest": { schema: { type: "string" } },
                "X-Ink-Sidecar": { schema: { type: "string" } },
                "X-Ink-Warnings": { schema: { type: "string" } },
                "X-Ink-Refresh-Hint": {
                  schema: { enum: ["binary-text"] },
                  description: "Optional advisory hint. Absence requires quality refresh.",
                },
                "X-Ink-Package-Id": { schema: { type: "string", format: "uuid" } },
                "X-Ink-Package-Revision": { schema: { type: "integer", minimum: 1 } },
                "X-Ink-Manifest-SHA256": { schema: { type: "string", pattern: "^[a-f0-9]{64}$" } },
                "X-Ink-Requested-Page-Index": { schema: { type: "integer", minimum: 0 } },
                "X-Ink-Actual-Page-Index": { schema: { type: "integer", minimum: 0 } },
              },
              content: { "image/png": { schema: { type: "string", contentEncoding: "binary" } } },
            },
            "400": problem("Invalid package ID or render request"),
            "404": problem("Package or document not found"),
            "412": problem("The package manifest changed after the client verified it"),
            "422": problem("Semantic package could not be rendered consistently"),
            "428": problem("manifestSha256 or If-Match is required"),
            "500": problem("Catalog storage failure"),
          },
        },
      },
      "/packages/{packageId}/frames/{variantId}/{uuid}/{pageIndex}": {
        get: {
          operationId: "getInkPackageFrame",
          summary: "Read one verified pre-rendered frame PNG",
          parameters: [
            { $ref: "#/components/parameters/PackageId" },
            { $ref: "#/components/parameters/VariantId" },
            { $ref: "#/components/parameters/DocumentUuid" },
            { $ref: "#/components/parameters/PageIndex" },
            manifestIfMatch,
          ],
          responses: {
            "200": {
              description: "PNG frame for the exact variant, document and page.",
              headers: catalogArtifactHeaders,
              content: { "image/png": { schema: { type: "string", contentEncoding: "binary" } } },
            },
            "304": conditionalNotModified,
            "400": problem("Invalid package, variant, document or page index"),
            "412": problem("The package manifest changed after the client verified it"),
            "428": problem("A strong manifest If-Match precondition is required"),
            "404": problem("Package or frame not found"),
            "500": problem("Catalog storage failure"),
          },
        },
      },
      "/packages/{packageId}/frames/{variantId}/{uuid}/{pageIndex}/sidecar": {
        get: {
          operationId: "getInkPackageFrameSidecar",
          summary: "Read the verified navigation sidecar paired with a frame",
          parameters: [
            { $ref: "#/components/parameters/PackageId" },
            { $ref: "#/components/parameters/VariantId" },
            { $ref: "#/components/parameters/DocumentUuid" },
            { $ref: "#/components/parameters/PageIndex" },
            manifestIfMatch,
          ],
          responses: {
            "200": {
              description: "inkos.frame-sidecar/v1 with child hitboxes and target UUIDs.",
              headers: catalogArtifactHeaders,
              content: { "application/json": { schema: { $ref: "#/components/schemas/FrameSidecar" } } },
            },
            "304": conditionalNotModified,
            "400": problem("Invalid package, variant, document or page index"),
            "412": problem("The package manifest changed after the client verified it"),
            "428": problem("A strong manifest If-Match precondition is required"),
            "404": problem("Package or sidecar not found"),
            "500": problem("Catalog storage failure"),
          },
        },
      },
      "/packages/{packageId}/download": {
        get: {
          operationId: "downloadInkPackage",
          summary: "Download the latest verified .ink archive in a package lineage",
          description: "The packageId URL is revision-floating and uses a strong ETag plus must-revalidate caching.",
          parameters: [{ $ref: "#/components/parameters/PackageId" }],
          responses: {
            "200": {
              description: "Verified .ink ZIP data package for the current published revision.",
              headers: {
                ...catalogArtifactHeaders,
                "Content-Disposition": { schema: { type: "string" } },
              },
              content: {
                "application/vnd.inkos.package+zip": {
                  schema: { type: "string", contentEncoding: "binary" },
                },
              },
            },
            "304": conditionalNotModified,
            "400": problem("Invalid package UUID"),
            "404": problem("Package not found"),
            "500": problem("Catalog storage failure"),
          },
        },
      },
    },
    components: {
      parameters: {
        JobId: {
          in: "path",
          name: "jobId",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
        PackageId: {
          in: "path",
          name: "packageId",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
        DocumentUuid: {
          in: "path",
          name: "uuid",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
        VariantId: {
          in: "path",
          name: "variantId",
          required: true,
          schema: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,127}$" },
        },
        PageIndex: {
          in: "path",
          name: "pageIndex",
          required: true,
          schema: { type: "integer", minimum: 0, maximum: 999999 },
        },
      },
      schemas: {
        AppExecuteRequest: z.toJSONSchema(appExecuteRequestSchema, { io: "input" }),
        OnlineRenderRequest: z.toJSONSchema(onlineRenderRequestSchema, { io: "input" }),
        PackageRenderRequest: z.toJSONSchema(packageRenderRequestSchema, { io: "input" }),
        InkTime: z.toJSONSchema(inkTimeResponseSchema),
        InkPackageManifest: z.toJSONSchema(inkPackageManifestSchema),
        PackagedDocument: z.toJSONSchema(packagedDocumentSchema, { io: "input" }),
        FrameSidecar: z.toJSONSchema(inkFrameSidecarSchema),
        GeneratorRequest: z.toJSONSchema(generatorRequestSchema, { io: "input" }),
        GeneratorJob: z.toJSONSchema(generatorJobSchema),
        SourceResolveRequest: z.toJSONSchema(sourceResolveRequestSchema, { io: "input" }),
        SourceResolution: {
          type: "object",
          required: [
            "schemaVersion", "normalizedUrl", "cached", "expectedEntryUuid",
            "expectedPackageId", "status", "job",
          ],
          properties: {
            schemaVersion: { const: "inkos.source-resolution/v1" },
            normalizedUrl: { type: "string", format: "uri" },
            cached: { type: "boolean" },
            stale: { type: "boolean" },
            revalidatingJobId: { type: "string", format: "uuid" },
            expectedEntryUuid: { type: "string", format: "uuid" },
            expectedPackageId: { type: "string", format: "uuid" },
            status: { enum: ["queued", "running", "complete", "failed", "cancelled"] },
            job: {
              oneOf: [{ $ref: "#/components/schemas/GeneratorJob" }, { type: "null" }],
            },
            jobId: { type: "string", format: "uuid" },
            statusUrl: { type: "string" },
            eventsUrl: { type: "string" },
            packageId: { type: "string", format: "uuid" },
            entryUuid: { type: "string", format: "uuid" },
            revision: { type: "integer", minimum: 1 },
            title: { type: "string" },
            manifestUrl: { type: "string" },
            downloadUrl: { type: "string" },
          },
          additionalProperties: false,
        },
        PackageCatalog: {
          type: "object",
          required: ["schemaVersion", "defaultPackageId", "defaultEntryUuid", "packages"],
          properties: {
            schemaVersion: { const: "inkos.package-catalog/v1" },
            defaultPackageId: {
              type: "string",
              format: "uuid",
              description: "Explicit default package; clients must not infer the home package from array order.",
            },
            defaultEntryUuid: {
              type: "string",
              format: "uuid",
              description: "Entry document UUID for the explicit default package.",
            },
            packages: {
              type: "array",
              items: {
                type: "object",
                required: [
                  "packageId", "revision", "title", "entryUuid", "fileName",
                  "bytes", "sha256", "manifestUrl", "downloadUrl",
                ],
                properties: {
                  packageId: { type: "string", format: "uuid" },
                  revision: { type: "integer", minimum: 1 },
                  title: { type: "string" },
                  entryUuid: { type: "string", format: "uuid" },
                  fileName: { type: "string", pattern: "\\.ink$" },
                  bytes: { type: "integer", minimum: 1 },
                  sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
                  manifestUrl: { type: "string" },
                  downloadUrl: { type: "string" },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
        Problem: {
          type: "object",
          required: ["type", "title", "status", "code", "detail", "instance", "retryable"],
          properties: {
            type: { type: "string", format: "uri" },
            title: { type: "string" },
            status: { type: "integer", minimum: 400, maximum: 599 },
            code: { type: "string" },
            detail: { type: "string" },
            instance: { type: "string" },
            retryable: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
    },
  };
}

export async function GET(): Promise<Response> {
  return Response.json(buildInkOpenApiDocument());
}
