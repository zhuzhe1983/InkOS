import { z } from "zod";

export const inkClockFormatSchema = z.literal("HH:mm:ss");
export const inkClockTimezoneSchema = z.literal("Asia/Shanghai");
export const inkClockRefreshMsSchema = z.number().int().min(1_000).max(60_000);
export const inkClockFullRefreshEverySchema = z.number().int().min(1).max(3_600);

const localWidgetIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/u);

const semanticContentPathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^page(?:\.[A-Za-z][A-Za-z0-9]*|\[\d{1,3}\])+$/u);

/**
 * Declarative local behavior attached to an otherwise ordinary semantic
 * document. It describes what changes, never where or how pixels are drawn.
 */
export const inkLocalClockWidgetSchema = z
  .object({
    id: localWidgetIdSchema,
    kind: z.literal("clock"),
    contentPath: semanticContentPathSchema,
    format: inkClockFormatSchema.default("HH:mm:ss"),
    timezone: inkClockTimezoneSchema.default("Asia/Shanghai"),
    refreshMs: inkClockRefreshMsSchema.default(1_000),
    fullRefreshEvery: inkClockFullRefreshEverySchema.default(60),
  })
  .strict();

export const inkLocalWidgetSchema = inkLocalClockWidgetSchema;

export type InkLocalClockWidget = z.infer<typeof inkLocalClockWidgetSchema>;
export type InkLocalWidget = z.infer<typeof inkLocalWidgetSchema>;
