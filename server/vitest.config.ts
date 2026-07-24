import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // Archive generation and full-frame Sharp assertions are CPU-bound. A
    // shared CI runner can take several times longer than a developer machine;
    // the workflow-level timeout still guards the complete suite.
    testTimeout: 60_000,
    // Next standalone output can contain traced copies of source test files.
    // Only execute tests from the source tree, never generated build output.
    exclude: ["**/node_modules/**", "**/.git/**", "**/.next/**"],
  },
});
