// Prova do ajuste das Trilhas (plano de 27/10, item 2) pelo membro de teste.
import { chromium } from "/app/node_modules/@playwright/test/index.mjs";
import { mkdirSync } from "node:fs";

const BASE = "https://teste.emmovimento.tech";
const OUT = "/prova/evidencias-ajustes-trilhas";
mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, storageState: "/prova/sessao-membro.json" });
const page = await ctx.newPage();

// 1. A lista: cada cliente abre a trilha DENTRO de Trilhas.
await page.goto(`${BASE}/agencia/trilhas`);
await page.waitForLoadState("networkidle");
log("trilhas na lista:", await page.getByTestId("trilha-na-lista").count(), "| reloginhos:", await page.getByTestId("reloginho").count(), "| sem trilha:", await page.getByTestId("clientes-sem-trilha").locator("li").count());
await page.screenshot({ path: `${OUT}/01-lista-1440.png`, fullPage: true });
await page.getByTestId("trilha-na-lista").filter({ hasText: "Empresa Modelo" }).first().click();
await page.waitForURL(/\/agencia\/trilhas\/[0-9a-f-]{36}$/, { timeout: 20000 });
log("abriu em:", new URL(page.url()).pathname, "| título:", await page.getByTestId("trilha-cliente-nome").innerText());

// 2. A linha do tempo: situação de cada passo e o reloginho nos que faltam.
await page.getByTestId("passo-da-trilha").first().waitFor();
const situacoes = await page.getByTestId("passo-da-trilha").evaluateAll((els) => els.map((e) => e.dataset.situacao));
const conta = situacoes.reduce((m, s) => ((m[s] = (m[s] ?? 0) + 1), m), {});
log("passos:", JSON.stringify(conta));
const relogios = page.getByTestId("reloginho");
log("reloginhos:", await relogios.count(), "|", JSON.stringify(await relogios.evaluateAll((els) => els.map((e) => `${e.dataset.nivel}: ${e.textContent}`))));
log("próximo prazo:", (await page.getByTestId("proximo-prazo").innerText().catch(() => "(nenhum)")).replace(/\s+/g, " "));
const antes = await relogios.first().innerText().catch(() => "");
await page.waitForTimeout(2500);
log("reloginho anda:", antes, "→", await relogios.first().innerText().catch(() => ""));

// O marcador fica em cima da linha vertical (medido, não a olho).
log("marcador × linha:", JSON.stringify(await page.evaluate(() => {
  const ol = document.querySelector("ol");
  const dot = ol?.querySelector("li > div > span");
  if (!ol || !dot) return null;
  const linha = ol.getBoundingClientRect().left + parseFloat(getComputedStyle(ol).borderLeftWidth) / 2;
  const r = dot.getBoundingClientRect();
  return { centroDoMarcador: Math.round(r.left + r.width / 2), linha: Math.round(linha) };
})));
await page.screenshot({ path: `${OUT}/02-trilha-1440.png`, fullPage: true });

// 3. Trocar de cliente sem sair de Trilhas.
const sel = page.getByTestId("escolher-cliente-da-trilha");
const outro = await sel.locator("option").evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent })).find((o) => o.v && !o.t.includes("Empresa Modelo")));
if (outro) {
  await sel.selectOption(outro.v);
  await page.waitForURL(new RegExp(`/agencia/trilhas/${outro.v}$`), { timeout: 20000 });
  await page.waitForLoadState("networkidle");
  log("trocou para:", outro.t, "| tem trilha:", (await page.getByTestId("trilha-do-cliente").count()) > 0, "| vazia:", (await page.getByTestId("trilha-vazia").count()) > 0);
}

// 4. Filtro "Com atraso".
await page.goto(`${BASE}/agencia/trilhas?filtro=atrasadas`);
await page.waitForLoadState("networkidle");
log("filtro com atraso:", await page.getByTestId("trilha-na-lista").count());

// 5. A ficha do cliente só resume e manda para Trilhas.
await page.goto(`${BASE}/agencia/clientes/8a49b809-3320-40d0-8e18-c3be9b53f0c8?aba=trilha`);
await page.waitForLoadState("networkidle");
const botao = page.getByTestId("trilha-na-ficha").getByRole("link");
log("ficha:", (await page.getByTestId("trilha-na-ficha").innerText()).replace(/\s+/g, " ").slice(0, 120), "| botão leva a:", await botao.getAttribute("href"));

// 6. Celular.
await page.setViewportSize({ width: 375, height: 812 });
await page.goto(`${BASE}/agencia/trilhas/8a49b809-3320-40d0-8e18-c3be9b53f0c8`);
await page.waitForLoadState("networkidle");
await page.waitForTimeout(1200);
log("celular:", JSON.stringify(await page.evaluate(() => ({ rola: document.documentElement.scrollWidth > document.documentElement.clientWidth }))));
await page.screenshot({ path: `${OUT}/03-trilha-375.png`, fullPage: true });
await browser.close();
