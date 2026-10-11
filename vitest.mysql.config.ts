import { defineConfig } from "vitest/config";
import path from "node:path";

// Suíte de integração com MySQL de verdade (tests/mysql/**). Roda SÓ via
// `pnpm test:mysql` (job `mysql-integracao`), que sobe um MySQL 8 como serviço
// e exporta MYSQL_TEST_*. Não faz parte do `pnpm test:unit`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/mysql/**/*.test.ts"],
    globals: false,
    // Cada arquivo cria e apaga o próprio banco; a ordem entre arquivos não importa,
    // mas rodar um por vez deixa o tempo medido limpo (C1d e C1f medem relógio).
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // `lib/logger` (importado pelo dialeto) puxa `lib/env` em alguns caminhos; as
    // mesmas variáveis falsas de `vitest.db.config.ts` bastam.
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key-not-a-placeholder-1234567890-1234567890",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      "server-only": path.resolve(__dirname, "node_modules/next/dist/compiled/server-only/empty.js"),
    },
  },
});
