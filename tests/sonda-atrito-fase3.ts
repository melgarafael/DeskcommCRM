import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const BASE = "http://127.0.0.1:3100";
const c = JSON.parse(readFileSync("/Users/rafaelmelgaco/SonghaiCRM/.e2e-creds.json", "utf8"));
async function main() {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 1200 } });
  const erros: string[] = [];
  p.on("console", (m) => { if (m.type() === "error") erros.push(m.text()); });
  await p.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await p.click('input[type="email"]');
  await p.locator('input[type="email"]').pressSequentially(c.users.manager.email, { delay: 8 });
  await p.click('input[type="password"]');
  await p.locator('input[type="password"]').pressSequentially(c.password, { delay: 8 });
  await p.click('button[type="submit"]');
  await p.waitForURL(/\/app/, { timeout: 30000 });
  await p.goto(`${BASE}/app/metrics`, { waitUntil: "networkidle" });
  await p.waitForTimeout(2500);
  const m = await p.evaluate(`(() => {
    var t = document.body.innerText;
    function pega(rot) {
      var re = new RegExp(rot + "[\\\\s\\\\S]{0,260}?(\\\\d+[.,]\\\\d+%)");
      var x = t.match(re); return x ? x[1] : null;
    }
    return {
      repergunta_presente: t.indexOf("Perguntas que a pessoa teve de repetir") >= 0,
      repergunta_valor: pega("Perguntas que a pessoa teve de repetir"),
      repergunta_rotulada_como_PISO: /Piso: \\d+ de \\d+/.test(t),
      repergunta_limitacao_visivel: t.indexOf("escapa desta medida") >= 0,
      espera_presente: t.indexOf("Esperas sem nenhuma resposta por mais de 4h") >= 0,
      espera_valor: pega("Esperas sem nenhuma resposta por mais de 4h"),
      abandono_presente: t.indexOf("morreram no silêncio") >= 0,
      pior_caso_presente: t.indexOf("Insistência no pior caso") >= 0,
      base_sem_ressalva_de_escopo: /Base: \d+ demandas? encerradas? nos últimos 30 dias, e \d+ ainda abertas/.test(t),
      invariante4_presente: t.indexOf("Demandas abertas sem próximo passo") >= 0,
      invariante4_valor: (function(){ var m=t.match(/Demandas abertas sem próximo passo[\s\S]{0,200}?(\d+)\s/); return m?m[1]:null; })(),
      insistencia_declara_denominador: /Medido sobre as \d+ demandas que passaram por atendimento humano/.test(t)
    };
  })()`);
  console.log(JSON.stringify(m, null, 2));
  console.log("erros de console:", erros.length ? erros.slice(0, 3) : "nenhum");
  await p.screenshot({ path: "/private/tmp/claude-501/-Users-rafaelmelgaco-SonghaiCRM/10ffaf65-ac1a-4b1b-b62d-368cbdeef6c5/scratchpad/atrito-fase4.png", fullPage: true });
  await b.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
