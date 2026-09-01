import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const BASE = "http://127.0.0.1:3100";
const c = JSON.parse(readFileSync("/Users/rafaelmelgaco/SonghaiCRM/.e2e-creds.json", "utf8"));
const OUT = "/private/tmp/claude-501/-Users-rafaelmelgaco-SonghaiCRM/10ffaf65-ac1a-4b1b-b62d-368cbdeef6c5/scratchpad";

async function main() {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 760 } });
  const erros: string[] = [];
  p.on("console", (m) => { if (m.type() === "error") erros.push(m.text()); });
  p.on("response", (r) => {
    if (r.url().includes("/api/v1/metrics/atrito")) console.log(`  REDE ${r.request().method()} ${r.status()}`);
  });

  await p.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await p.click('input[type="email"]');
  await p.locator('input[type="email"]').pressSequentially(c.users.manager.email, { delay: 8 });
  await p.click('input[type="password"]');
  await p.locator('input[type="password"]').pressSequentially(c.password, { delay: 8 });
  await p.click('button[type="submit"]');
  await p.waitForURL(/\/app/, { timeout: 30000 });
  await p.goto(`${BASE}/app/metrics`, { waitUntil: "networkidle" });
  await p.waitForTimeout(2000);

  const antes = await p.evaluate(`(() => {
    var t = document.body.innerText;
    var m = t.match(/Conversas que morreram no silêncio \\(após (\\d+)h\\)/);
    var v = t.match(/morreram no silêncio[\\s\\S]{0,200}?(\\d+\\.\\d+%)/);
    return { rotuloRegua: m ? m[1] : null, taxa: v ? v[1] : null,
             temControle: /Contar como perdida no silêncio após/.test(t) };
  })()`);
  console.log("ANTES:", JSON.stringify(antes));

  // CLICAR de verdade: mudar a régua para 168h e salvar.
  const input = p.locator('input[aria-label="Horas de silêncio até considerar a conversa perdida"]');
  await input.click();
  await input.fill("");
  await input.pressSequentially("120", { delay: 20 });
  await p.waitForTimeout(300);
  const botao = p.getByRole("button", { name: /Salvar/ });
  console.log("botão Salvar visível:", await botao.isVisible());
  await botao.click();
  await p.waitForTimeout(3000);

  const depois = await p.evaluate(`(() => {
    var t = document.body.innerText;
    var m = t.match(/Conversas que morreram no silêncio \\(após (\\d+)h\\)/);
    var v = t.match(/morreram no silêncio[\\s\\S]{0,200}?(\\d+\\.\\d+%)/);
    return { rotuloRegua: m ? m[1] : null, taxa: v ? v[1] : null };
  })()`);
  console.log("DEPOIS:", JSON.stringify(depois));
  console.log("erros de console:", erros.length ? erros.slice(0, 3) : "nenhum");
  await p.screenshot({ path: `${OUT}/atrito-fase2.png`, fullPage: false });
  await b.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
