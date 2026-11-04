// Prova pela tela: banner fantasma de ligação presa aparece, o cron roda, e ele some.
// Uso: node prova-ligacao-presa.cjs <repo> <outdir>
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const [repo, out] = process.argv.slice(2);
const { chromium } = require(require.resolve("@playwright/test", { paths: [repo] }));
const env = Object.fromEntries(
  fs.readFileSync(path.join(repo, ".env.local"), "utf8").split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const BASE = "http://localhost:3000";
const SENHA = process.env.OWNER_PASSWORD;
fs.mkdirSync(out, { recursive: true });

const psql = (sql) =>
  execFileSync("docker", ["exec", "supabase_db_deskcomm-crm", "psql", "-U", "postgres", "-Atc", sql]).toString().trim();

(async () => {
  const org = psql("select id from organizations limit 1");
  // A linha como o bug a deixava: SIP recebida, 'ringing', 10 min atrás.
  const id = psql(`insert into voice_calls (organization_id, provider, direction, status, peer_phone, asterisk_channel_id, started_at, created_at)
    values ('${org}', 'sip', 'inbound', 'ringing', '+5527999990000', gen_random_uuid()::text, now() - interval '10 minutes', now() - interval '10 minutes') returning id`).split("\n")[0];
  console.log("linha presa:", id);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 800 } });
  await page.goto(`${BASE}/login`);
  await page.locator("#email").fill("admin@admin.com");
  await page.locator("#password").fill(SENHA);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/(app|onboarding)/, { timeout: 60_000 });
  await page.goto(`${BASE}/app/inbox`);
  await page.waitForLoadState("networkidle");
  console.log("tela:", page.url());

  const banner = page.getByRole("alertdialog", { name: "Chamada de voz recebida" });
  await banner.waitFor({ state: "visible", timeout: 30_000 });
  console.log("ANTES: banner visível =", await banner.isVisible());
  await page.screenshot({ path: path.join(out, "1-antes-banner-fantasma.png") });

  const r = await fetch(`${BASE}/api/v1/cron/recover-stuck-calls`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.INTERNAL_CRON_SECRET}` },
  });
  console.log("cron:", r.status, JSON.stringify(await r.json()));
  console.log("banco:", psql(`select status||' '||end_reason from voice_calls where id='${id}'`));

  // O painel reconcilia com o servidor (Realtime ou a conferência de 10 s).
  await banner.waitFor({ state: "hidden", timeout: 30_000 });
  console.log("DEPOIS (mesma aba): banner visível =", await banner.isVisible());
  await page.reload();
  await page.waitForTimeout(8000);
  console.log("DEPOIS (recarregada): banner visível =", await banner.isVisible());
  await page.screenshot({ path: path.join(out, "2-depois-cron-sem-banner.png") });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
