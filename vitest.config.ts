import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against sources, so `pnpm test` works without building first.
    alias: {
      "@swiftnest/protocol": src("./packages/protocol/src/index.ts"),
      "@swiftnest/core": src("./packages/core/src/index.ts"),
      "@swiftnest/sdk": src("./packages/sdk/src/index.ts"),
      "@swiftnest/cap-shell": src("./plugins/cap-shell/src/index.ts"),
      "@swiftnest/surface-mcp": src("./plugins/surface-mcp/src/index.ts"),
      "@swiftnest/link-lan": src("./plugins/link-lan/src/index.ts"),
      "@swiftnest/cap-files": src("./plugins/cap-files/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "plugins/*/test/**/*.test.ts", "templates/*/test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
