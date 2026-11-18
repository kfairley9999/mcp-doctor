import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const coreSrc = (path: string): string =>
  fileURLToPath(new URL(`./packages/core/src/${path}`, import.meta.url));

export default defineConfig({
  // Resolve the workspace core package from source so tests never depend on
  // a prior `tsc -b` having emitted packages/core/dist.
  resolve: {
    alias: [
      { find: /^@mcp-doctor\/core\/node$/, replacement: coreSrc("node/index.ts") },
      { find: /^@mcp-doctor\/core$/, replacement: coreSrc("index.ts") },
    ],
  },
  test: {
    environment: "node",
    include: ["packages/*/src/**/*.test.ts", "playground/src/**/*.test.ts"],
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "lcov"],
      include: ["packages/*/src/**/*.ts", "playground/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/schema/self-check.ts"],
      thresholds: {
        lines: 85,
        functions: 85,
        statements: 85,
        branches: 85,
      },
    },
  },
});
