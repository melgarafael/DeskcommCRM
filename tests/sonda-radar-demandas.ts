import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const BASE = "http://127.0.0.1:3100";
const c = JSON.parse(readFileSync("/Users/rafaelmelgaco/SonghaiCRM/.e2e-creds.json", "utf8"));
async function main() {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  const erros: string[] = [];
  p.on("console", (m) => { if (m.type() === "error") erros.push(m.text()); });
  p.on("response", (r) => { if (r.url().includes("/leads/at-risk")) console.log(`  REDE ${r.status()} at-risk`); });

  await p.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await p.click('input[type="email"]');
  await p.locator('input[type="email"]').pressSequentially(c.users.manager.email, { delay: 8 });
  await p.click('input[type="password"]');
  await p.locator('input[type="password"]').pressSequentially(c.password, { delay: 8 });
  await p.click('button[type="submit"]');
  await p.waitForURL(/\/app/, { timeout: 30000 });
  await p.goto(`${BASE}/app/radar`, { waitUntil: "networkidle" });
  await p.waitForTimeout(2500);

  const m = await p.evaluate(`(() => {
    var sec = document.querySelector('[data-testid="radar-sem-proximo-passo"]');
    var vazio = document.querySelector('[data-testid="radar-empty"]');
    var t = document.body.innerText;
    return {
      secao_presente: !!sec,
      estado_vazio_indevido: !!vazio,
      titulo: sec ? (sec.querySelector("p") || {}).innerText : null,
      explicacao: sec ? (sec.querySelectorAll("p")[1] || {}).innerText : null,
      itens_listados: sec ? sec.querySelectorAll("li").length : 0,
      primeiro_item: sec && sec.querySelector("li") ? sec.querySelector("li").innerText.replace(/\\s+/g," ") : null,
      largura: sec ? Math.round(sec.getBoundingClientRect().width) : 0,
      antes_dos_counts: (function(){
        var cts = document.querySelector('[data-testid="radar-counts"]');
        if (!sec || !cts) return null;
        return !!(sec.compareDocumentPosition(cts) & 4);
      })(),
      scroll_horizontal: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);
  console.log(JSON.stringify(m, null, 2));
  console.log("erros de console:", erros.length ? erros.slice(0, 3) : "nenhum");
  await p.screenshot({ path: "/private/tmp/claude-501/-Users-rafaelmelgaco-SonghaiCRM/10ffaf65-ac1a-4b1b-b62d-368cbdeef6c5/scratchpad/radar.png", fullPage: true });
  await b.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
