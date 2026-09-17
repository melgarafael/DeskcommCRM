import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir: '.',
  testMatch: 'console.spec.mjs',
  timeout: 120000,
  workers: 1,
  fullyParallel: false,
  outputDir: '../../.superpowers/evidence/extensoes-bancada/playwright',
  reporter: [['list'], ['json', { outputFile: fileURLToPath(new URL('../../.superpowers/evidence/extensoes-bancada/playwright-report.json', import.meta.url)) }]],
  use: {
    baseURL: 'http://127.0.0.1:38761',
    viewport: { width: 1366, height: 900 },
    locale: 'pt-BR',
    trace: 'on',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node experiments/extensoes/console.mjs',
    url: 'http://127.0.0.1:38761',
    reuseExistingServer: true,
    timeout: 15000,
    cwd: '../..',
  },
});
