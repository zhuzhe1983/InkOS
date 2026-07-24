import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Inkos Render Lab",
  description: "Server-side e-ink renderer and device simulator",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
