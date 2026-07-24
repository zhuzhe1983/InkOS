import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export const paperS3Manifest: MetadataRoute.Manifest = {
  id: "/papers3-client",
  name: "InkOS PaperS3 Client",
  short_name: "PaperS3",
  description: "在手机上执行 InkOS PaperS3 服务端渲染内容。",
  start_url: "/papers3-client?fullscreen=1",
  scope: "/papers3-client",
  display: "fullscreen",
  display_override: ["fullscreen", "standalone"],
  orientation: "any",
  background_color: "#080a0d",
  theme_color: "#080a0d",
  lang: "zh-CN",
  categories: ["books", "news", "productivity"],
  icons: [
    {
      src: "/papers3-icon-192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "/papers3-icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "/papers3-icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    },
  ],
};

export function GET(): Response {
  return Response.json(paperS3Manifest, {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "application/manifest+json; charset=utf-8",
    },
  });
}
