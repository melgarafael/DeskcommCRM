import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";

const BASE = "http://127.0.0.1:3100";
const creds = JSON.parse(readFileSync("/Users/rafaelmelgaco/SonghaiCRM/.e2e-creds.json", "utf8"));
const EMAIL = creds.users.manager.email;
const SENHA = creds.password;
const OUT = "/private/tmp/claude-501/-Users-rafaelmelgaco-SonghaiCRM/10ffaf65-ac1a-4b1b-b62d-368cbdeef6c5/scratchpad";

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  const erros: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") erros.push(m.text()); });
  page.on("response", (r) => {
    if (r.url().includes("/api/v1/metrics/atrito")) {
      console.log(`REDE  ${r.status()}  ${r.url().replace(BASE, "")}`);
    }
  });

  console.log("1. login…");
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  const campos = await page.evaluate(() =>
    Array.from(document.querySelectorAll("input")).map((i) => ({
      type: i.type, name: i.name, id: i.id, placeholder: i.placeholder,
      autocomplete: i.autocomplete,
    })),
  );
  console.log("   campos do form:", JSON.stringify(campos));
  await page.click('input[type="email"]');
  await page.locator('input[type="email"]').pressSequentially(EMAIL, { delay: 10 });
  await page.click('input[type="password"]');
  await page.locator('input[type="password"]').pressSequentially(SENHA, { delay: 10 });
  const valores = await page.evaluate(() => ({
    email: (document.querySelector('input[type="email"]') as HTMLInputElement)?.value,
    senhaLen: (document.querySelector('input[type="password"]') as HTMLInputElement)?.value.length,
  }));
  console.log("   valores no DOM:", JSON.stringify(valores), "| esperado email:", EMAIL);
  page.on("response", async (r) => {
    if (/auth|login/.test(r.url()) && r.request().method() === "POST") {
      let corpo = "";
      try { corpo = (await r.text()).slice(0, 300); } catch { corpo = "<sem corpo>"; }
      console.log(`   POST ${r.status()} ${r.url().replace(BASE, "").slice(0, 70)} :: ${corpo}`);
    }
  });
  await page.click('button[type="submit"]');
  try {
    await page.waitForURL(/\/app|\/login\/mfa|\/onboarding/, { timeout: 20_000 });
  } catch {
    const txt = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 500));
    console.log("   ✗ login NAO redirecionou. URL:", page.url().replace(BASE, ""));
    console.log("   TEXTO DA TELA:", txt);
    await page.screenshot({ path: `${OUT}/login-falhou.png`, fullPage: true });
    await browser.close();
    return;
  }
  console.log(`   → ${page.url().replace(BASE, "")}`);

  console.log("2. /app/metrics…");
  await page.goto(`${BASE}/app/metrics`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  console.log(`   → ${page.url().replace(BASE, "")}`);

  // MEDIÇÃO POR FERRAMENTA — nada a olho.
  // A medição vai como STRING: o esbuild do tsx injeta helpers (__name) que não
  // existem no contexto da página, e funções nomeadas dentro de evaluate quebram.
  const medida = await page.evaluate(`(() => {
    var txt = function (el) { return (el && el.textContent ? el.textContent : "").replace(/\\s+/g, " ").trim(); };
    var secoes = Array.prototype.slice.call(document.querySelectorAll("section"));
    var secao = null;
    for (var i = 0; i < secoes.length; i++) {
      var h = secoes[i].querySelector("h2");
      if (h && /Atrito/i.test(h.textContent || "")) { secao = secoes[i]; break; }
    }
    if (!secao) return { achou: false };
    var todos = Array.prototype.slice.call(secao.querySelectorAll("*"));
    var cards = todos.filter(function (c) {
      return /O que isso custou/i.test(c.textContent || "") &&
             !Array.prototype.some.call(c.children, function (k) { return /O que isso custou/i.test(k.textContent || ""); }) === false &&
             c.getAttribute("class") && /rounded|border/.test(c.getAttribute("class"));
    });
    var vistos = [];
    var pares = [];
    for (var j = 0; j < cards.length; j++) {
      var c = cards[j];
      var jaContido = false;
      for (var k = 0; k < vistos.length; k++) { if (vistos[k].contains(c)) { jaContido = true; break; } }
      if (jaContido) continue;
      vistos.push(c);
      var r = c.getBoundingClientRect();
      var ps = c.querySelectorAll("p");
      pares.push({
        largura: Math.round(r.width),
        altura: Math.round(r.height),
        valorEficiencia: txt(ps[0]),
        rotuloEficiencia: txt(ps[1]),
        custoNoMesmoCard: /O que isso custou/i.test(c.textContent || ""),
        texto: txt(c).slice(0, 300)
      });
    }
    var raiz = secao.parentElement || document.body;
    var funil = null;
    var tudo = Array.prototype.slice.call(raiz.querySelectorAll("*"));
    for (var m = 0; m < tudo.length; m++) {
      var t = (tudo[m].textContent || "").trim();
      if (/^Funil\\b/.test(t) && tudo[m].children.length === 0) { funil = tudo[m]; break; }
    }
    return {
      achou: true,
      tituloSecao: txt(secao.querySelector("h2")),
      subtitulo: txt(secao.querySelector("p")),
      nPares: pares.length,
      pares: pares,
      temTracinho: (secao.textContent || "").indexOf("\u2014") >= 0,
      antesDoFunil: funil ? !!(secao.compareDocumentPosition(funil) & 4) : null,
      scrollHorizontal: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);

  console.log("\n3. MEDIDO:");
  console.log(JSON.stringify(medida, null, 2));
  console.log("\n4. erros de console:", erros.length ? erros.slice(0, 5) : "nenhum");

  await page.screenshot({ path: `${OUT}/atrito-1280.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  const mobile = await page.evaluate(`(() => {
    var lc = document.documentElement.clientWidth;
    var culpados = [];
    var todos = Array.prototype.slice.call(document.querySelectorAll("body *"));
    for (var i = 0; i < todos.length; i++) {
      var r = todos[i].getBoundingClientRect();
      if (r.width > lc + 1 || r.right > lc + 1) {
        culpados.push({
          tag: todos[i].tagName,
          cls: (todos[i].getAttribute("class") || "").slice(0, 60),
          w: Math.round(r.width), right: Math.round(r.right),
          dentroDoAtrito: !!(todos[i].closest && todos[i].closest("section") &&
            /Atrito/.test((todos[i].closest("section").querySelector("h2") || {}).textContent || ""))
        });
      }
    }
    return { overflow: document.documentElement.scrollWidth > lc,
             scrollWidth: document.documentElement.scrollWidth, clientWidth: lc,
             culpados: culpados.slice(0, 6) };
  })()`);
  console.log("5. mobile 390px:", JSON.stringify(mobile, null, 2));
  await page.screenshot({ path: `${OUT}/atrito-390.png`, fullPage: true });

  await browser.close();

}
main().catch((e) => { console.error(e); process.exit(1); });
