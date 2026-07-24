import { z } from "zod";

import {
  clientAppUrlSchema,
  displayMetaSchema,
  renderNavigationContextSchema,
} from "../rendering/contracts";
import { inkUuidSchema, packagedDocumentSchema } from "./contracts";

export const ONLINE_PACKAGE_ID = "00000000-0000-4000-8000-000000000000";

/**
 * Editable HTTPS seed used by clients that do not send their own image list.
 * The server replaces only this exact URL's `random=1` value with the current
 * request nonce so paging/settings keep one stable image.
 */
export const DEFAULT_RANDOM_IMAGE_COLLECTION_URL =
  "https://picsum.photos/540/960?random=1";

/** Exact pre-diagnostic default migrated without changing custom URLs. */
export const LEGACY_GRAYSCALE_RANDOM_IMAGE_COLLECTION_URL =
  "https://picsum.photos/540/960?grayscale&random=1";

export const inkMapStyleSchema = z.enum(["eink", "balanced", "detail"]);
export const appImageProcessingSchema = z.enum([
  "optimized",
  "diagnostic-raw-colour",
]);

const appImageUrlSchema = z.string().max(2048).refine((value) => {
  // Wire compatibility for firmware that predates the editable HTTPS seed.
  // New clients/defaults never emit this retired collection value.
  if (value === "inkos://app/random-image") return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}, "Expected an HTTPS image URL or the retired exact random-image alias");

export const appImageEntrySchema = z.object({
  id: z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/u),
  label: z.string().trim().min(1).max(200),
  url: appImageUrlSchema,
}).strict();

const defaultAppImages = [{
  id: "random",
  label: "随机图片",
  url: DEFAULT_RANDOM_IMAGE_COLLECTION_URL,
}] as const;

export const appExecuteRequestSchema = z
  .object({
    action: clientAppUrlSchema,
    /** Client-generated cache-buster; the server never substitutes its own. */
    nonce: z.string().min(16).max(96).regex(/^[a-z0-9_-]+$/u),
    /** Client wall-clock sample used only for request identity and revision. */
    requestedAtUnixMs: z.number().int().nonnegative().max(4_102_444_800_000),
    /** Gallery page requested by the thin client; the server clamps nothing. */
    pageIndex: z.number().int().nonnegative().max(15).default(0),
    /** Device-owned ordered image collection. External bytes are fetched only by the server. */
    images: z.array(appImageEntrySchema).min(1).max(16).default(defaultAppImages.map((entry) => ({ ...entry }))),
    /** Server-side map tone treatment; static-map upstreams do not expose custom base styles. */
    mapStyle: inkMapStyleSchema.default("eink"),
    /**
     * Explicit bounded diagnostic baseline. It bypasses server grayscale,
     * tone, sharpening, palette and dithering while retaining safe fetch,
     * decode, orientation and contain/cover geometry.
     */
    imageProcessing: appImageProcessingSchema.default("optimized"),
    displayMeta: displayMetaSchema.default({
      invert: false,
      fontLevel: 0,
      orientation: "portrait",
    }),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.action === "inkos://app/baidu-map" && request.pageIndex !== 0) {
      context.addIssue({
        code: "custom",
        path: ["pageIndex"],
        message: "Baidu map has exactly one page",
      });
    }
    if (
      request.action === "inkos://app/random-image"
      && request.pageIndex >= request.images.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["pageIndex"],
        message: "pageIndex is outside the image collection",
      });
    }
  });

export type AppExecuteRequest = z.infer<typeof appExecuteRequestSchema>;
export type AppImageEntry = z.infer<typeof appImageEntrySchema>;
export type InkMapStyle = z.infer<typeof inkMapStyleSchema>;
export type AppImageProcessing = z.infer<typeof appImageProcessingSchema>;

export const onlineRenderRequestSchema = z
  .object({
    document: packagedDocumentSchema,
    profileId: z.string().trim().min(1).max(128),
    displayMeta: displayMetaSchema.default({
      invert: false,
      fontLevel: 0,
      orientation: "portrait",
    }),
    navigationContext: renderNavigationContextSchema.default({ imageTargets: [] }),
    pageIndex: z.number().int().nonnegative().default(0),
    packageId: inkUuidSchema.optional(),
  })
  .strict();

export type OnlineRenderRequest = z.infer<typeof onlineRenderRequestSchema>;

export const packageRenderRequestSchema = z
  .object({
    documentUuid: inkUuidSchema,
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    displayMeta: displayMetaSchema.default({
      invert: false,
      fontLevel: 0,
      orientation: "portrait",
    }),
    pageIndex: z.number().int().nonnegative().max(999_999).default(0),
  })
  .strict();

export type PackageRenderRequest = z.infer<typeof packageRenderRequestSchema>;

export const inkTimeResponseSchema = z
  .object({
    schemaVersion: z.literal("inkos.time/v1"),
    serverUnixMs: z.number().int().nonnegative(),
    timezone: z.literal("Asia/Shanghai"),
    serverIso: z.iso.datetime({ offset: true }),
  })
  .strict();

export type InkTimeResponse = z.infer<typeof inkTimeResponseSchema>;
