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
    // Next standalone output can contain traced copies of source test files.
    // Only execute tests from the source tree, never generated build output.
    exclude: ["**/node_modules/**", "**/.git/**", "**/.next/**"],
  },
});
