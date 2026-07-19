import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // JSX runtime automático (como o Next) — necessário p/ testes de componente.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup/vitest.setup.ts"],
    globals: true,
    coverage: { provider: "v8", reporter: ["text", "html"] },
    exclude: ["**/node_modules/**", ".next", "dist", ".claude/**", "tests/e2e/**", "tests/invariants/**"],
  },
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
});
