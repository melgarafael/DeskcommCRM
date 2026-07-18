import { defineConfig } from "@playwright/test";

// Porta do e2e parametrizada (E2E_PORT). Default 3003 NESTE worktree da fusão:
// 3001/3002 são do checkout principal (gov-loop) — reuseExistingServer na 3001
// fazia o e2e daqui REUSAR o dev server deles (a raiz das trombadas entre loops).
const port = Number(process.env.E2E_PORT ?? 3003);

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "on-first-retry",
  },
  webServer: {
    command: `pnpm exec next dev --turbopack -p ${port}`,
    url: `http://localhost:${port}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
