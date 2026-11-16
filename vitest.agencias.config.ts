import { defineConfig } from "vitest/config";
/** Execução opt-in somente da suíte transacional de agências no banco de teste autorizado. */
export default defineConfig({
  test: {
    include: ["tests/invariants/agencias.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
