import { defineConfig } from "vitest/config";
import path from "node:path";

// Config dedicada da suíte de invariantes de banco (tests/invariants/**).
// Roda SÓ via `pnpm test:db` (scripts/test-db.sh), que sobe o Postgres efêmero
// e exporta TEST_DB_CONTAINER. Não faz parte do `pnpm test:unit`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/invariants/**/*.test.ts"],
    globals: false,
    // Seed + queries via docker exec são lentos o suficiente pro default de 5s.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
});
