// Config só desta prova: o app já está de pé (next start) e o receptor também.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  // `.pw.ts`, não `.spec.ts`: o include padrão do vitest pegaria `*.spec.ts` e o
  // import de @playwright/test derrubaria a suíte unitária.
  testMatch: "prova.pw.ts",
  timeout: 180_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: "./resultado",
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3687",
    trace: "on",
    screenshot: "off",
    viewport: { width: 1280, height: 900 },
  },
});
