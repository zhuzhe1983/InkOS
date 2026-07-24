import type { Metadata, Viewport } from "next";

import { PaperS3Client } from "@/components/papers3-client/paper-s3-client";

export const metadata: Metadata = {
  title: "PaperS3 Client · InkOS",
  description: "PaperS3 网页客户端：执行在线或离线 .ink 内容的分页与 UUID 导航。",
  applicationName: "InkOS PaperS3",
  manifest: "/papers3-client/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "InkOS PaperS3",
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon: [
      { url: "/papers3-icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/papers3-icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [
      { url: "/papers3-apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  },
  other: {
    "mobile-web-app-capable": "yes",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#080a0d",
};

interface PaperS3ClientPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PaperS3ClientPage({ searchParams }: PaperS3ClientPageProps) {
  const parameters = await searchParams;
  const rawFullscreen = parameters.fullscreen;
  const fullscreen = Array.isArray(rawFullscreen) ? rawFullscreen[0] : rawFullscreen;
  const rawSourceUrl = parameters.url;
  const initialSourceUrl = Array.isArray(rawSourceUrl) ? rawSourceUrl[0] : rawSourceUrl;
  const rawPackageId = parameters.package;
  const initialPackageId = Array.isArray(rawPackageId) ? rawPackageId[0] : rawPackageId;
  const rawDocumentUuid = parameters.uuid;
  const initialDocumentUuid = Array.isArray(rawDocumentUuid) ? rawDocumentUuid[0] : rawDocumentUuid;
  const rawPage = parameters.page;
  const pageValue = Array.isArray(rawPage) ? rawPage[0] : rawPage;
  const parsedPage = pageValue === undefined ? 0 : Number(pageValue);
  const initialPageIndex = Number.isSafeInteger(parsedPage) && parsedPage >= 0 ? parsedPage : -1;
  const hasExplicitContentRequest = rawSourceUrl !== undefined
    || rawPackageId !== undefined
    || rawDocumentUuid !== undefined
    || rawPage !== undefined;
  const immersive = fullscreen === "1" || fullscreen === "true";
  return (
    <PaperS3Client
      hasExplicitContentRequest={hasExplicitContentRequest}
      immersive={immersive}
      initialDocumentUuid={initialDocumentUuid}
      initialPackageId={initialPackageId}
      initialPageIndex={initialPageIndex}
      initialSourceUrl={initialSourceUrl}
    />
  );
}
