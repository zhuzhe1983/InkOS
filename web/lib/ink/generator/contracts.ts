import { z } from "zod";

import { einkOutputTuningSchema } from "../../rendering/contracts";
import { screenProfiles } from "../../rendering/profiles";
import { inkUuidSchema } from "../contracts";

const fontLevelSchema = z.union([
  z.literal(-2),
  z.literal(-1),
  z.literal(0),
  z.literal(1),
  z.literal(2),
]);

const httpsUrlSchema = z.string().max(2048).refine((value) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}, "Expected an absolute HTTPS URL");

const profileIdSchema = z.string().refine(
  (value) => screenProfiles.some((profile) => profile.id === value),
  "Unknown screen profile",
);

function unique<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}

export const generatorRequestSchema = z
  .object({
    seedUrl: httpsUrlSchema,
    title: z.string().trim().min(1).max(500),
    sourceMode: z.enum(["chromium", "http"]).default("chromium"),
    deliveryMode: z.enum(["realtime", "archive"]).default("archive"),
    maxDepth: z.number().int().min(0).max(4).default(1),
    maxDocuments: z.number().int().min(1).max(20).default(8),
    profileIds: z.array(profileIdSchema).min(1).max(3),
    orientations: z.array(z.enum(["portrait", "landscape"])).min(1).max(2),
    fontLevels: z.array(fontLevelSchema).min(1).max(5),
    /** One raster tuning shared by the requested display-variant matrix. */
    outputTuning: einkOutputTuningSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (!unique(request.profileIds)) {
      context.addIssue({ code: "custom", path: ["profileIds"], message: "Values must be unique" });
    }
    if (!unique(request.orientations)) {
      context.addIssue({ code: "custom", path: ["orientations"], message: "Values must be unique" });
    }
    if (!unique(request.fontLevels)) {
      context.addIssue({ code: "custom", path: ["fontLevels"], message: "Values must be unique" });
    }
    if (
      request.outputTuning
      && request.profileIds.some((profileId) =>
        screenProfiles.find((profile) => profile.id === profileId)?.rasterStrategy
          !== "eink-gray4-png-v1"
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["outputTuning"],
        message: "PaperS3 gray4 output tuning requires gray4-only profileIds",
      });
    }
    const variants = request.profileIds.length
      * request.orientations.length
      * request.fontLevels.length;
    if (variants > 32) {
      context.addIssue({
        code: "custom",
        path: ["profileIds"],
        message: "A generation job can contain at most 32 display variants",
      });
    }
  });

export const generatorJobPhaseSchema = z.enum([
  "queued",
  "fetching",
  "extracting",
  "rendering",
  "packaging",
  "complete",
]);
export const generatorJobStatusSchema = z.enum([
  "queued",
  "running",
  "complete",
  "failed",
  "cancelled",
]);

export const generatorJobSchema = z
  .object({
    schemaVersion: z.literal("inkos.generator-job/v1"),
    jobId: inkUuidSchema,
    status: generatorJobStatusSchema,
    phase: generatorJobPhaseSchema,
    progress: z
      .object({
        completed: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
        message: z.string().min(1).max(500),
      })
      .strict(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    statusUrl: z.string().min(1),
    eventsUrl: z.string().min(1),
    artifactUrl: z.string().min(1).optional(),
    package: z
      .object({
        packageId: inkUuidSchema,
        fileName: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}\.ink$/u),
        bytes: z.number().int().positive(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict()
      .optional(),
    timings: z
      .record(
        z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
        z.number().int().nonnegative(),
      )
      .optional(),
    error: z
      .object({
        code: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
        message: z.string().min(1).max(2000),
        retryable: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((job, context) => {
    if (job.status === "complete") {
      if (job.phase !== "complete") {
        context.addIssue({ code: "custom", path: ["phase"], message: "A complete job requires the complete phase" });
      }
      if (!job.package || !job.artifactUrl) {
        context.addIssue({ code: "custom", path: ["package"], message: "A complete job requires its package artifact" });
      }
    }
    if (job.status === "failed" && !job.error) {
      context.addIssue({ code: "custom", path: ["error"], message: "A failed job requires an error" });
    }
  });

export type GeneratorRequest = z.infer<typeof generatorRequestSchema>;
export type GeneratorJob = z.infer<typeof generatorJobSchema>;
export type GeneratorJobPhase = z.infer<typeof generatorJobPhaseSchema>;

export function normalizeGeneratorRequest(raw: unknown): GeneratorRequest {
  const parsed = generatorRequestSchema.parse(raw);
  return {
    ...parsed,
    profileIds: [...parsed.profileIds].sort(),
    orientations: [...parsed.orientations].sort(),
    fontLevels: [...parsed.fontLevels].sort((left, right) => left - right),
  };
}

export function generatorJobUrls(jobId: string) {
  const statusUrl = `/api/ink/v1/generator/jobs/${jobId}`;
  return {
    statusUrl,
    eventsUrl: `${statusUrl}/events`,
    artifactUrl: `${statusUrl}/artifact`,
  };
}
