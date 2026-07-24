import { z } from "zod";

import rawDefaultRssStyle from "./styles/rss-default.v1.json";

const shortTextSchema = z.string().trim().min(1).max(500);
const bodySourceSchema = z.enum([
  "rss-content-encoded",
  "atom-content",
  "rss-description",
  "atom-summary",
  "linked-chromium",
]);

export const rssStyleSchema = z
  .object({
    schemaVersion: z.literal("inkos.rss-style/v1"),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
    version: z.number().int().positive(),
    feed: z
      .object({
        kind: z.literal("list"),
        layout: z.literal("feed"),
        description: z.literal("channel"),
        summary: z.literal("teaser-then-body-lede"),
        author: z.literal("eyebrow"),
        publishedAt: z.literal("calendar-date"),
        image: z.literal("media-then-body"),
        linkLabel: shortTextSchema,
      })
      .strict(),
    article: z
      .object({
        kind: z.literal("detail"),
        layoutWithImage: z.literal("image-story"),
        layoutWithoutImage: z.literal("article"),
        eyebrow: shortTextSchema,
        bodySourceOrder: z
          .array(bodySourceSchema)
          .length(5)
          .superRefine((sources, context) => {
            if (new Set(sources).size !== sources.length) {
              context.addIssue({
                code: "custom",
                message: "bodySourceOrder cannot contain duplicate sources",
              });
            }
            if (sources.at(-1) !== "linked-chromium") {
              context.addIssue({
                code: "custom",
                message: "linked-chromium must be the final body fallback",
              });
            }
          }),
        linkedPage: z.literal("fallback-if-teaser"),
        missingBody: z.literal("teaser-then-source-link"),
      })
      .strict(),
    html: z
      .object({
        unknownElements: z.literal("unwrap"),
        relativeUrls: z.literal("entry-base"),
        unsafeSubtrees: z.literal("drop"),
        decorativeImages: z.literal("drop"),
      })
      .strict(),
  })
  .strict();

export type RssStyle = z.infer<typeof rssStyleSchema>;

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

export function parseRssStyle(value: unknown): Readonly<RssStyle> {
  return deepFreeze(rssStyleSchema.parse(value));
}

/**
 * This is a server-owned, checked-in style. Requests cannot provide paths,
 * selectors, CSS, URLs or executable expressions.
 */
export const DEFAULT_RSS_STYLE = parseRssStyle(rawDefaultRssStyle);
