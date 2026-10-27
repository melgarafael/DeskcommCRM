// Prova do arrastar/esticar (plano de 27/10, item 3) pelo membro de teste, com a
// função temporária de calendario-preparar.sql. O que a tela mostra é conferido
// também no banco (calendario-conferir.sql, rodado por fora).
import { chromium } from "/app/node_modules/@playwright/test/index.mjs";
import { mkdirSync } from "node:fs";

const BASE = "https://teste.emmovimento.tech";
const CLIENTE = "8a49b809-3320-40d0-8e18-c3be9b53f0c8";
const OUT = "/prova/evidencias-calendario";
mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, storageState: "/prova/sessao-membro.json" });
const page = await ctx.newPage();
const recado = () => page.getByTestId("recado-do-calendario");
const bloco = () => page.getByTestId("vista-semana").getByTestId("reuniao-no-calendario").filter({ hasText: "Reunião de pauta" }).first();
async function arrastar(de, para) {
  await page.mouse.move(de.x, de.y);
  await page.mouse.down();
  await page.mouse.move(de.x + (para.x - de.x) / 2, de.y + (para.y - de.y) / 2, { steps: 6 });
  await page.mouse.move(para.x, para.y, { steps: 6 });
  await page.mouse.up();
}
async function esperarRecado(texto) {
  await recado().filter({ hasText: texto }).waitFor({ timeout: 30000 });
  return (await recado().innerText()).replace(/\s+/g, " ");
}
const coluna = (dia) => page.getByTestId("vista-semana").locator(`div[data-dia="${dia}"]`).last();

// 1. Semana de 09/11: a reunião de terça 10h–11h vai para quinta, 1h30 depois.
await page.goto(`${BASE}/agencia/calendario?vista=semana&dia=2026-11-09`);
await page.waitForLoadState("networkidle");
const b = await bloco().boundingBox();
const qui = await coluna("2026-11-12").boundingBox();
const de = { x: b.x + b.width / 2, y: b.y + 8 };
await arrastar(de, { x: qui.x + qui.width / 2, y: de.y + 72 });
log("mover:", await esperarRecado("12/11"));
await page.waitForLoadState("networkidle");
await page.screenshot({ path: `${OUT}/01-arrastada-1440.png`, fullPage: true });

// 2. Esticar a borda de baixo uma hora (48 px).
const alca = bloco().getByTestId("esticar-reuniao");
const a = await alca.boundingBox();
await arrastar({ x: a.x + a.width / 2, y: a.y + a.height / 2 }, { x: a.x + a.width / 2, y: a.y + a.height / 2 + 48 });
log("esticar:", await esperarRecado("–"));
const altura = (await bloco().boundingBox()).height;
log("altura do bloco (2 h = 96 px):", Math.round(altura));
await page.screenshot({ path: `${OUT}/02-esticada-1440.png`, fullPage: true });

// 3. Desfazer volta o último gesto.
await recado().getByRole("button", { name: "Desfazer" }).click();
log("desfazer:", await esperarRecado("Voltou"));

// 4. Clique sem arrastar ainda abre a reunião.
await page.goto(`${BASE}/agencia/calendario?vista=semana&dia=2026-11-09`);
await page.waitForLoadState("networkidle");
await bloco().click();
log("clique abre o modal:", await page.getByRole("dialog").isVisible());
await page.keyboard.press("Escape");

// 5. Mês: arrastar para o dia 20 mantém a hora.
await page.goto(`${BASE}/agencia/calendario?vista=mes&dia=2026-11-01`);
await page.waitForLoadState("networkidle");
const chip = page.getByTestId("vista-mes").getByTestId("reuniao-no-calendario").filter({ hasText: "11:30" }).first();
const c = await chip.boundingBox();
const d20 = await page.getByTestId("vista-mes").locator('div[data-dia="2026-11-20"]').boundingBox();
await arrastar({ x: c.x + 10, y: c.y + c.height / 2 }, { x: d20.x + d20.width / 2, y: d20.y + d20.height - 15 });
log("mês:", await esperarRecado("20/11"));
await page.screenshot({ path: `${OUT}/03-mes-1440.png`, fullPage: true });

// 6. Publicações: o rascunho de 12/11 vai para 14/11; o agendado de 13/11 vai para 16/11 e pede agendamento de novo.
await page.goto(`${BASE}/agencia/publicacoes?mes=2026-11&cliente=${CLIENTE}`);
await page.waitForLoadState("networkidle");
for (const [titulo, dia] of [
  ["Post rascunho", "2026-11-14"],
  ["Post agendado", "2026-11-16"],
]) {
  const p = await page.getByTestId("publicacao-na-grade").filter({ hasText: titulo }).first().boundingBox();
  const alvo = await page.locator(`[data-testid="grade-do-mes"] div[data-dia="${dia}"]`).boundingBox();
  await arrastar({ x: p.x + 10, y: p.y + p.height / 2 }, { x: alvo.x + alvo.width / 2, y: alvo.y + alvo.height - 12 });
  await page.getByTestId("mensagem-da-publicacao").filter({ hasText: titulo }).waitFor({ timeout: 30000 });
  log("publicação:", (await page.getByTestId("mensagem-da-publicacao").innerText()).replace(/\s+/g, " "));
}
await page.waitForLoadState("networkidle");
await page.screenshot({ path: `${OUT}/04-publicacoes-1440.png`, fullPage: true });
await browser.close();
