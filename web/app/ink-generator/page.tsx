import type { Metadata } from "next";

import { InkGenerator } from "@/components/ink-generator/ink-generator";

export const metadata: Metadata = {
  title: "Ink Package Generator · InkOS",
  description: "把网页内容生成可验证、可离线分发的 .ink 内容包。",
};

export default function InkGeneratorPage() {
  return <InkGenerator />;
}
