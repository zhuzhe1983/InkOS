import { z } from "zod";

import { inkLocalWidgetSchema } from "../ink/local-widgets";
import {
  INKOS_CLIENT_APP_URLS,
  INKOS_CLIENT_DEVICE_URLS,
} from "../ink/app-actions";

export {
  INKOS_CLIENT_APP_URLS,
  INKOS_CLIENT_DEVICE_URLS,
} from "../ink/app-actions";

const idSchema = z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9._:/-]+$/);
const shortTextSchema = z.string().trim().min(1).max(500);
const bodyTextSchema = z.string().trim().min(1).max(20_000);
const offsetDateTimeSchema = z.string().max(100).refine((value) => {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}, "Expected an ISO 8601 date-time with an explicit offset");

const httpUrlSchema = z.string().max(2048).refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}, "Expected an HTTP(S) URL");

/**
 * Device-owned collection destinations. These are data-only navigation
 * commands, not network source URLs and not an extensible custom-scheme
 * namespace. Keep the enum exact so a package cannot smuggle arbitrary
 * `inkos:` actions through semantic content or a frame sidecar.
 */
export const INKOS_CLIENT_COLLECTION_URLS = [
  "inkos://collection/rss",
  "inkos://collection/website",
] as const;

/**
 * Read-only compatibility aliases for packages produced before the network
 * reader became the single owner of ordinary HTTPS bookmarks. New producers
 * must use INKOS_CLIENT_COLLECTION_URLS; clients still accept this exact alias
 * and dispatch it as the website collection.
 */
export const INKOS_LEGACY_CLIENT_COLLECTION_URLS = [
  "inkos://collection/other",
] as const;

export const clientCollectionUrlSchema = z.enum([
  ...INKOS_CLIENT_COLLECTION_URLS,
  ...INKOS_LEGACY_CLIENT_COLLECTION_URLS,
]);

export const clientAppUrlSchema = z.enum(INKOS_CLIENT_APP_URLS);
export const clientDeviceUrlSchema = z.enum(INKOS_CLIENT_DEVICE_URLS);

export const contentLinkUrlSchema = z.union([
  httpUrlSchema,
  clientCollectionUrlSchema,
  clientAppUrlSchema,
  clientDeviceUrlSchema,
]);

export const linkTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), url: contentLinkUrlSchema }).strict(),
  z.object({ kind: z.literal("document"), documentId: idSchema }).strict(),
]);

export const contentImageSchema = z
  .object({
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("asset"), assetId: idSchema }).strict(),
      z.object({ kind: z.literal("remote"), url: httpUrlSchema }).strict(),
    ]),
    alt: z.string().max(500),
    caption: shortTextSchema.optional(),
    /** Semantic image role; renderers choose device-specific treatment. */
    renderIntent: z.enum(["photo", "graphic", "map"]).optional(),
  })
  .strict();

export const contentLinkSchema = z
  .object({
    label: shortTextSchema,
    target: linkTargetSchema,
    description: bodyTextSchema.optional(),
  })
  .strict();

export const detailBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("paragraph"), text: bodyTextSchema }).strict(),
  z
    .object({
      type: z.literal("heading"),
      level: z.union([z.literal(2), z.literal(3)]),
      text: shortTextSchema,
    })
    .strict(),
  z.object({ type: z.literal("image"), image: contentImageSchema }).strict(),
  z
    .object({
      type: z.literal("list"),
      ordered: z.boolean().default(false),
      items: z.array(shortTextSchema).min(1).max(64),
    })
    .strict(),
  z.object({ type: z.literal("link"), link: contentLinkSchema }).strict(),
  z
    .object({
      type: z.literal("quote"),
      text: bodyTextSchema,
      attribution: shortTextSchema.optional(),
    })
    .strict(),
]);

export const detailPageSchema = z
  .object({
    kind: z.literal("detail"),
    layout: z.enum(["article", "image-story", "postcard"]).default("article"),
    title: shortTextSchema,
    summary: bodyTextSchema.optional(),
    eyebrow: shortTextSchema.optional(),
    byline: shortTextSchema.optional(),
    publishedAt: z.string().max(100).optional(),
    heroImage: contentImageSchema.optional(),
    content: z.array(detailBlockSchema).min(1).max(128),
    navigation: z.array(contentLinkSchema).min(1).max(32).optional(),
    links: z.array(contentLinkSchema).max(16).optional(),
  })
  .strict();

export const listItemSchema = z
  .object({
    id: idSchema,
    title: shortTextSchema.optional(),
    summary: bodyTextSchema.optional(),
    eyebrow: shortTextSchema.optional(),
    image: contentImageSchema.optional(),
    link: contentLinkSchema.optional(),
    metadata: z
      .array(z.object({ label: shortTextSchema, value: shortTextSchema }).strict())
      .max(6)
      .optional(),
  })
  .strict()
  .refine((item) => item.title !== undefined || item.image !== undefined, {
    message: "A list item must contain a title or an image",
  });

export const listPageSchema = z
  .object({
    kind: z.literal("list"),
    layout: z
      .enum(["feed", "masonry", "bookshelf", "grid", "list", "cardboard"])
      .default("feed"),
    title: shortTextSchema,
    description: bodyTextSchema.optional(),
    navigation: z.array(contentLinkSchema).min(1).max(32).optional(),
    items: z.array(listItemSchema).min(1).max(128),
    sourcePageInfo: z
      .object({
        currentCursor: z.string().max(512).optional(),
        previousCursor: z.string().max(512).optional(),
        nextCursor: z.string().max(512).optional(),
        totalItems: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const readerBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("paragraph"), text: bodyTextSchema }).strict(),
  z
    .object({
      type: z.literal("heading"),
      level: z.union([z.literal(2), z.literal(3)]),
      text: shortTextSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("list"),
      ordered: z.boolean().default(false),
      items: z.array(shortTextSchema).min(1).max(64),
    })
    .strict(),
  z
    .object({
      type: z.literal("quote"),
      text: bodyTextSchema,
      attribution: shortTextSchema.optional(),
    })
    .strict(),
]);

export const readerPageSchema = z
  .object({
    kind: z.literal("reader"),
    content: z.array(readerBlockSchema).min(1).max(256),
  })
  .strict();

export const imagePageSchema = z
  .object({
    kind: z.literal("image"),
    layout: z.enum(["contain", "cover"]).default("contain"),
    // A full-screen image has no text chrome. Use `detail/image-story` when a
    // caption or other editorial copy must remain visible.
    image: contentImageSchema.omit({ caption: true }),
    link: contentLinkSchema.omit({ description: true }).optional(),
  })
  .strict();

export const contentDocumentSchema = z
  .object({
    schemaVersion: z.literal("inkos.content/v2"),
    id: idSchema,
    revision: z.number().int().positive(),
    locale: z.string().min(2).max(35).default("zh-CN"),
    updatedAt: offsetDateTimeSchema.optional(),
    page: z.discriminatedUnion("kind", [
      detailPageSchema,
      listPageSchema,
      readerPageSchema,
      imagePageSchema,
    ]),
  })
  .strict();

export const einkOutputTuningSchema = z
  .object({
    /** Midtone control: greater than 1 lightens; less than 1 darkens. */
    gamma: z.number().finite().min(0.5).max(2).optional(),
    /** Global contrast around middle gray. */
    contrast: z.number().finite().min(0.5).max(2.5).optional(),
    /** Input gray mapped to panel black. */
    blackPoint: z.number().int().min(0).max(96).optional(),
    /** Input gray mapped to panel white. */
    whitePoint: z.number().int().min(159).max(255).optional(),
    /** Unsharp-mask amount after SVG downsampling. */
    sharpen: z.number().finite().min(0).max(2).optional(),
    /** Extra contrast inside renderer-owned photo regions only. */
    photoContrast: z.number().finite().min(0.5).max(2.5).optional(),
    /** Both modes emit the same fixed 16-entry gray palette. */
    quantization: z.enum(["uniform-16", "photo-ordered-16"]).optional(),
    /** SVG raster scale before the final high-quality downsample. */
    supersampling: z.union([z.literal(1), z.literal(2)]).optional(),
  })
  .strict()
  .superRefine((tuning, context) => {
    const blackPoint = tuning.blackPoint ?? 8;
    const whitePoint = tuning.whitePoint ?? 247;
    if (whitePoint - blackPoint < 64) {
      context.addIssue({
        code: "custom",
        path: ["whitePoint"],
        message: "whitePoint must remain at least 64 levels above blackPoint",
      });
    }
  });

export const displayMetaSchema = z
  .object({
    /**
     * Kept on the wire so existing normal-polarity clients/packages remain
     * readable. Negative rendering is no longer supported: `true` is rejected
     * instead of being silently normalized to a different frame.
     */
    invert: z.boolean().default(false),
    fontLevel: z.union([
      z.literal(-2),
      z.literal(-1),
      z.literal(0),
      z.literal(1),
      z.literal(2),
    ]).default(0),
    orientation: z.enum(["portrait", "landscape"]).default("portrait"),
    /** Optional server-raster controls; omitted requests use the device default. */
    outputTuning: einkOutputTuningSchema.optional(),
  })
  .strict()
  .superRefine((displayMeta, context) => {
    if (displayMeta.invert) {
      context.addIssue({
        code: "custom",
        path: ["invert"],
        message: "invert is no longer supported and must be false",
      });
    }
  });

export const renderImageTargetSchema = z
  .object({
    contentPath: z.string().trim().min(1).max(512),
    targetDocumentId: idSchema,
  })
  .strict();

export const renderNavigationContextSchema = z
  .object({
    imageTargets: z.array(renderImageTargetSchema).max(256).default([]),
  })
  .strict()
  .superRefine((context, refinement) => {
    const paths = new Set<string>();
    context.imageTargets.forEach((target, index) => {
      if (paths.has(target.contentPath)) {
        refinement.addIssue({
          code: "custom",
          path: ["imageTargets", index, "contentPath"],
          message: `Duplicate image target path '${target.contentPath}'`,
        });
      }
      paths.add(target.contentPath);
    });
  });

export const screenProfileSchema = z
  .object({
    schemaVersion: z.literal("inkos.screen/v1"),
    id: z.string().min(1),
    version: z.number().int().positive(),
    label: z.string().min(1),
    deviceType: z.string().min(1),
    layoutStrategy: z.enum([
      "paper-s3-semantic-v1",
      "xiaozhi-card-semantic-v1",
      "paper-color-semantic-v1",
    ]),
    rasterStrategy: z.enum([
      "eink-gray4-png-v1",
      "eink-mono1-png-v1",
      "eink-spectra6-png-v1",
      "eink-spectra6-photo-dither-png-v2",
    ]),
    nativeSize: z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }).strict(),
    /** Active panel area in the panel's native orientation, not enclosure size. */
    physicalSizeMm: z.object({
      width: z.number().positive().finite(),
      height: z.number().positive().finite(),
    }).strict(),
    logicalSize: z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }).strict(),
    displayRotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
    orientationRotations: z.object({
      portrait: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
      landscape: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
    }).strict(),
    safeArea: z.object({
      top: z.number().int().nonnegative(),
      right: z.number().int().nonnegative(),
      bottom: z.number().int().nonnegative(),
      left: z.number().int().nonnegative(),
    }).strict(),
    color: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("monochrome"), levels: z.literal(2) }).strict(),
      z.object({ mode: z.literal("grayscale"), levels: z.literal(16) }).strict(),
      z
        .object({
          mode: z.literal("color"),
          levels: z.literal(6),
          palette: z.literal("spectra6"),
        })
        .strict(),
    ]),
    pixelFormat: z.enum(["mono1", "gray4", "spectra6"]),
    touch: z.object({ enabled: z.boolean() }).strict(),
    refresh: z.object({
      supportsPartial: z.boolean(),
      xAlignment: z.number().int().positive().default(1),
      yAlignment: z.number().int().positive().default(1),
    }).strict(),
  })
  .strict()
  .superRefine((profile, context) => {
    const expectedPixelFormat = profile.color.levels === 2
      ? "mono1"
      : profile.color.levels === 16
        ? "gray4"
        : "spectra6";
    const expectedRasterStrategies: ReadonlyArray<ScreenProfile["rasterStrategy"]> =
      profile.color.levels === 2
        ? ["eink-mono1-png-v1"]
        : profile.color.levels === 16
          ? ["eink-gray4-png-v1"]
          : ["eink-spectra6-png-v1", "eink-spectra6-photo-dither-png-v2"];
    if (profile.pixelFormat !== expectedPixelFormat) {
      context.addIssue({
        code: "custom",
        path: ["pixelFormat"],
        message: `${profile.color.levels} color levels require ${expectedPixelFormat}`,
      });
    }
    if (!expectedRasterStrategies.includes(profile.rasterStrategy)) {
      context.addIssue({
        code: "custom",
        path: ["rasterStrategy"],
        message: `${profile.color.levels} color levels require ${expectedRasterStrategies.join(" or ")}`,
      });
    }

    const rotated = profile.displayRotation === 90 || profile.displayRotation === 270;
    const expectedLogicalSize = rotated
      ? { width: profile.nativeSize.height, height: profile.nativeSize.width }
      : profile.nativeSize;
    if (
      profile.logicalSize.width !== expectedLogicalSize.width ||
      profile.logicalSize.height !== expectedLogicalSize.height
    ) {
      context.addIssue({
        code: "custom",
        path: ["logicalSize"],
        message: `Logical size must match native size at ${profile.displayRotation}° rotation`,
      });
    }

    const currentOrientation = profile.logicalSize.width > profile.logicalSize.height
      ? "landscape"
      : "portrait";
    if (profile.orientationRotations[currentOrientation] !== profile.displayRotation) {
      context.addIssue({
        code: "custom",
        path: ["orientationRotations", currentOrientation],
        message: `The ${currentOrientation} rotation must match displayRotation`,
      });
    }

    for (const orientation of ["portrait", "landscape"] as const) {
      const orientationRotation = profile.orientationRotations[orientation];
      const orientationRotated = orientationRotation === 90 || orientationRotation === 270;
      const orientedSize = orientationRotated
        ? { width: profile.nativeSize.height, height: profile.nativeSize.width }
        : profile.nativeSize;
      const hasExpectedShape = orientation === "portrait"
        ? orientedSize.height >= orientedSize.width
        : orientedSize.width >= orientedSize.height;
      if (!hasExpectedShape) {
        context.addIssue({
          code: "custom",
          path: ["orientationRotations", orientation],
          message: `Rotation ${orientationRotation} does not produce a ${orientation} logical screen`,
        });
      }
    }

    if (
      profile.safeArea.left + profile.safeArea.right >= profile.logicalSize.width ||
      profile.safeArea.top + profile.safeArea.bottom >= profile.logicalSize.height
    ) {
      context.addIssue({
        code: "custom",
        path: ["safeArea"],
        message: "Safe area must leave a positive drawable region",
      });
    }

    // E-paper pixels are square on the supported panels. Reject a typo in the
    // trusted physical metadata before it silently changes every physical UI
    // token (type, borders, spacing and touch targets).
    const ppiX = profile.nativeSize.width / (profile.physicalSizeMm.width / 25.4);
    const ppiY = profile.nativeSize.height / (profile.physicalSizeMm.height / 25.4);
    const pitchMismatch = Math.abs(ppiX - ppiY) / Math.max(ppiX, ppiY);
    if (pitchMismatch > 0.03) {
      context.addIssue({
        code: "custom",
        path: ["physicalSizeMm"],
        message: "Physical size must describe a panel with matching horizontal and vertical pixel pitch",
      });
    }
  });

export const renderRequestSchema = z
  .object({
    profileId: z.string().min(1),
    document: contentDocumentSchema,
    localWidgets: z.array(inkLocalWidgetSchema).max(8).default([]),
    displayMeta: displayMetaSchema.default({
      invert: false,
      fontLevel: 0,
      orientation: "portrait",
    }),
    /**
     * Request-scoped navigation metadata. It deliberately lives outside the
     * semantic document: content remains reusable and contains no generated
     * package UUIDs or pixel bounds.
     */
    navigationContext: renderNavigationContextSchema.default({ imageTargets: [] }),
    pageIndex: z.number().int().nonnegative().default(0),
    region: z
      .object({
        x: z.number().int().nonnegative(),
        y: z.number().int().nonnegative(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ContentDocument = z.infer<typeof contentDocumentSchema>;
export type DetailBlock = z.infer<typeof detailBlockSchema>;
export type DetailPage = z.infer<typeof detailPageSchema>;
export type ReaderBlock = z.infer<typeof readerBlockSchema>;
export type ReaderPage = z.infer<typeof readerPageSchema>;
export type ListPage = z.infer<typeof listPageSchema>;
export type ImagePage = z.infer<typeof imagePageSchema>;
export type ListItem = z.infer<typeof listItemSchema>;
export type ContentImage = z.infer<typeof contentImageSchema>;
export type ContentLink = z.infer<typeof contentLinkSchema>;
export type ScreenProfile = z.infer<typeof screenProfileSchema>;
export type DisplayMeta = z.infer<typeof displayMetaSchema>;
export type EinkOutputTuning = z.infer<typeof einkOutputTuningSchema>;
export type RenderImageTarget = z.infer<typeof renderImageTargetSchema>;
export type RenderNavigationContext = z.infer<typeof renderNavigationContextSchema>;
export type RenderRequest = z.infer<typeof renderRequestSchema>;
export type RenderRequestInput = z.input<typeof renderRequestSchema>;
export type RenderRegion = NonNullable<RenderRequest["region"]>;

export type LinkTarget = z.infer<typeof linkTargetSchema>;

export interface RenderInteraction {
  contentPath: string;
  /** Human-readable action name for accessibility and non-visual clients. */
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  action:
    | { type: "open-url"; url: string }
    | { type: "open-document"; documentId: string };
}

/** Renderer-owned placement metadata; only selected local widgets reach the sidecar. */
export interface RenderedTextRegion {
  contentPath: string;
  bounds: { x: number; y: number; width: number; height: number };
  style: {
    fontFamily: "sans-serif" | "monospace";
    fontSize: number;
    fontWeight: 400 | 700;
    textAlign: "left" | "center" | "right";
  };
}

/**
 * Advisory display-waveform classification derived from both semantic content
 * and the final encoded pixels. Clients may ignore it and use quality refresh.
 */
export type FrameRefreshHint = "binary-text";

export interface FrameManifest {
  schemaVersion: "inkos.frame/v2";
  rendererVersion: string;
  frameId: string;
  documentId: string;
  documentRevision: number;
  contentType: "detail" | "list" | "reader" | "image";
  screenProfileId: string;
  screenProfileVersion: number;
  nativeSize: { width: number; height: number };
  logicalSize: { width: number; height: number };
  displayRotation: 0 | 90 | 180 | 270;
  pixelFormat: "mono1" | "gray4" | "spectra6";
  layoutStrategy: ScreenProfile["layoutStrategy"];
  rasterStrategy: ScreenProfile["rasterStrategy"];
  displayMeta: DisplayMeta;
  codec: "png";
  pagination: {
    pageIndex: number;
    pageCount: number;
    hasPrevious: boolean;
    hasNext: boolean;
  };
  update: {
    kind: "full" | "partial";
    region: RenderRegion;
  };
  refreshHint?: FrameRefreshHint;
  payloadBytes: number;
  sha256: string;
  crc32: string;
  interactions: RenderInteraction[];
  warnings: string[];
}

export interface RenderedFrame {
  payload: Buffer;
  contentType: "image/png";
  manifest: FrameManifest;
  textRegions?: RenderedTextRegion[];
  warnings: string[];
}
