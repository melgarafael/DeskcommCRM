import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const BASE = "http://127.0.0.1:3100";
const creds = JSON.parse(readFileSync("/Users/rafaelmelgaco/SonghaiCRM/.e2e-creds.json", "utf8"));
async function main() {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  await p.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await p.click('input[type="email"]');
  await p.locator('input[type="email"]').pressSequentially(creds.users.manager.email, { delay: 8 });
  await p.click('input[type="password"]');
  await p.locator('input[type="password"]').pressSequentially(creds.password, { delay: 8 });
  await p.click('button[type="submit"]');
  await p.waitForURL(/\/app/, { timeout: 30000 });
  for (const rota of ["/app/inbox", "/app/kanban", "/app/metrics"]) {
    await p.goto(`${BASE}${rota}`, { waitUntil: "networkidle" });
    await p.waitForTimeout(1200);
    const m = await p.evaluate(`({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })`) as { sw: number; cw: number };
    console.log(`${rota.padEnd(14)} scrollWidth=${m.sw} clientWidth=${m.cw} overflow=${m.sw > m.cw}`);
  }
  await b.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
