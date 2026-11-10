// Prova pela tela: recusar uma ligação SIP tocando.
// Uso, da raiz do repositório: OWNER_PASSWORD=... node evidence/recusar-ligacao-sip/prova-recusa-sip.mjs <outdir> <rotulo>
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { chromium } from "@playwright/test";

const [out, rotulo] = process.argv.slice(2);
const BASE = "http://localhost:3000";
fs.mkdirSync(out, { recursive: true });
const psql = (sql) =>
  execFileSync("docker", ["exec", "supabase_db_deskcomm-crm", "psql", "-U", "postgres", "-Atc", sql]).toString().trim();

(async () => {
  // Limpa toques anteriores para a tela ter UMA ligação tocando: esta.
  psql("update voice_calls set status='ended', end_reason='prova-limpeza' where status in ('starting','ringing')");
  const org = psql("select id from organizations limit 1");
  const id = psql(`insert into voice_calls (organization_id, provider, direction, status, peer_phone, asterisk_channel_id)
    values ('${org}', 'sip', 'inbound', 'ringing', '+5527988887777', gen_random_uuid()::text) returning id`).split("\n")[0];
  console.info(`[${rotulo}] ligação SIP tocando:`, id);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 800 } });
  const respostas = [];
  page.on("response", (r) => { if (r.url().includes("/reject")) respostas.push(r.status()); });
  await page.goto(`${BASE}/login`);
  await page.locator("#email").fill("admin@admin.com");
  await page.locator("#password").fill(process.env.OWNER_PASSWORD);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
  await page.goto(`${BASE}/app/inbox`);

  const banner = page.getByRole("alertdialog", { name: "Chamada de voz recebida" });
  await banner.waitFor({ state: "visible", timeout: 30_000 });
  await page.screenshot({ path: path.join(out, `${rotulo}-1-tocando.png`) });
  await page.getByRole("button", { name: "Recusar chamada" }).click();
  await banner.waitFor({ state: "hidden", timeout: 10_000 });
  await page.waitForTimeout(1500);
  console.info(`[${rotulo}] resposta do /reject:`, respostas.join(","));
  await page.screenshot({ path: path.join(out, `${rotulo}-2-depois-do-clique.png`) });
  console.info(`[${rotulo}] banco:`, psql(`select status||' '||coalesce(end_reason,'-') from voice_calls where id='${id}'`));

  await page.reload();
  await page.waitForTimeout(8000);
  console.info(`[${rotulo}] depois de recarregar, banner visível =`, await banner.isVisible());
  await page.screenshot({ path: path.join(out, `${rotulo}-3-recarregada.png`) });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
