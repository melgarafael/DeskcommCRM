import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const BASE = "http://127.0.0.1:3100";
const c = JSON.parse(readFileSync("/Users/rafaelmelgaco/SonghaiCRM/.e2e-creds.json", "utf8"));
async function main() {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  await p.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await p.click('input[type="email"]');
  await p.locator('input[type="email"]').pressSequentially(c.users.manager.email, { delay: 8 });
  await p.click('input[type="password"]');
  await p.locator('input[type="password"]').pressSequentially(c.password, { delay: 8 });
  await p.click('button[type="submit"]');
  await p.waitForURL(/\/app/, { timeout: 30000 });
  await p.goto(`${BASE}/app/metrics`, { waitUntil: "networkidle" });
  await p.waitForTimeout(2000);
  const m = await p.evaluate(`(() => {
    var body = document.body.innerText;
    return {
      subtituloPagina: (document.querySelector("header p") || {}).innerText || "",
      legendaTravessaoPresente: /significa que não houve dado suficiente/.test(body),
      insistenciaPiorCaso: /Insistência no pior caso/.test(body),
      notaBasePequena: /poucas esperas medidas/.test(body),
      valorPiorCaso: (function () {
        var m2 = body.match(/Insistência no pior caso[\\s\\S]{0,120}?(\\d+)/);
        return m2 ? m2[1] : null;
      })()
    };
  })()`);
  console.log(JSON.stringify(m, null, 2));
  await p.screenshot({ path: "/private/tmp/claude-501/-Users-rafaelmelgaco-SonghaiCRM/10ffaf65-ac1a-4b1b-b62d-368cbdeef6c5/scratchpad/atrito-final.png", fullPage: false });
  await b.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
