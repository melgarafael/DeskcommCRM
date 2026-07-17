import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup/vitest.setup.ts"],
    globals: true,
    coverage: { provider: "v8", reporter: ["text", "html"] },
    exclude: ["node_modules", ".next", "dist", "tests/e2e/**", "tests/invariants/**"],
  },
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
});
