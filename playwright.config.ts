import { defineConfig } from "@playwright/test";

// Porta do dev server sob teste. Default 3001; sobrescreva com E2E_PORT quando
// a 3001 já estiver ocupada por outro checkout/worktree.
const PORT = process.env.E2E_PORT ?? "3001";
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  webServer: {
    // Produção (`next build` antes!): dev-server compila por rota (40-80s) e
    // Turbopack dev quebra cookies() fora do request scope — inviável p/ e2e.
    command: `pnpm exec next start --port ${PORT}`,
    url: BASE_URL,
    // false: reusar um server que já ocupa a porta pode ser OUTRO processo
    // (ex.: bundle do Remotion na 3000) — o teste precisa do NOSSO next start.
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
