import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produce the minimal self-contained Node server used by the production
  // container. Runtime data is stored outside this tree through INKOS_DATA_DIR.
  output: "standalone",
  // Playwright resolves this manifest dynamically while importing
  // `playwright-core`, so Next's static file tracer cannot discover it.
  // Keep it in standalone builds even though InkOS launches the system
  // Chromium instead of downloading a Playwright-managed browser.
  outputFileTracingIncludes: {
    "/*": ["./node_modules/playwright-core/browsers.json"],
  },
  // Runtime packages, caches, and generated jobs live in this writable data
  // directory. They must never be copied into an immutable server image.
  outputFileTracingExcludes: {
    "/*": ["./.ink-data/**/*"],
  },
};

export default nextConfig;
