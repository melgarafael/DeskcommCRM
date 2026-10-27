// Prova da Fase 9 (IA da agência) COM MODELO — para quando o teste tiver chave de IA.
// Rodar na VPS (ver CONTINUIDADE.md §5.5), com a função temporária de
// /root/agencia-ci/prova/f9-preparar.sql e TAREFA=<id da tarefa que ele cria>:
//   docker run --rm --network host -e TAREFA=<id> -v /root/agencia-ci:/app:ro \
//     -v /root/agencia-ci/prova:/prova mcr.microsoft.com/playwright:v1.63.0-noble \
//     node /prova/prova-fase9-com-modelo.mjs
// Gasta crédito do provedor (3 pedidos). Nada aqui fala com a Meta: a IA só
// escreve texto e cria publicação em RASCUNHO.
import { chromium } from "/app/node_modules/@playwright/test/index.mjs";
import { mkdirSync } from "node:fs";

const BASE = "https://teste.emmovimento.tech";
const TAREFA = process.env.TAREFA;
const OUT = "/prova/evidencias-f9-modelo";
mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, storageState: "/prova/sessao-membro.json" });
const page = await ctx.newPage();
page.on("dialog", (d) => d.accept());

// 1. Mapa novo: a IA propõe, a pessoa confere e aplica.
await page.goto(`${BASE}/agencia/mapas`);
await page.waitForLoadState("networkidle");
await page.locator("#mapa-cliente").selectOption({ label: "Empresa Modelo (Testes)" });
await page.locator("#mapa-titulo").fill("Plano de dezembro com IA (prova)");
await page.getByRole("button", { name: "Criar mapa" }).click();
await page.waitForURL(/\/agencia\/mapas\/[0-9a-f-]{36}$/, { timeout: 20000 });
await page.locator("#pedido-ia").fill(
  "Plano de dezembro: 6 Reels sobre a vitrine de Natal. Roteiros e legendas pela IA, gravação em um dia, edição, e aprovação do cliente antes do dia 18. Publicações a partir do dia 20.",
);
const t0 = Date.now();
await page.getByRole("button", { name: "Propor blocos" }).click();
await Promise.race([
  page.getByTestId("proposta-da-ia").waitFor({ timeout: 150000 }),
  page.getByTestId("mensagem-do-mapa").waitFor({ timeout: 150000 }),
]);
if (await page.getByTestId("mensagem-do-mapa").count()) log("erro da IA:", await page.getByTestId("mensagem-do-mapa").innerText());
const propostos = await page.getByTestId("bloco-proposto").allInnerTexts();
log(`proposta em ${Math.round((Date.now() - t0) / 1000)} s:`, propostos.length, "blocos");
for (const b of propostos) log("  -", b.replace(/\s+/g, " "));
log("blocos no mapa ANTES de aplicar (tem de ser 0):", await page.getByTestId("bloco-do-mapa").count());
await page.screenshot({ path: `${OUT}/01-proposta-1440.png`, fullPage: true });
await page.getByRole("button", { name: "Aplicar no mapa" }).click();
await page.getByTestId("mensagem-do-mapa").filter({ hasText: "entraram no mapa" }).waitFor({ timeout: 20000 });
await page.reload();
await page.waitForLoadState("networkidle");
log("blocos no mapa DEPOIS:", await page.getByTestId("bloco-do-mapa").count(), "| IA:", await page.getByTestId("bloco-do-mapa").filter({ hasText: "IA" }).count());
await page.screenshot({ path: `${OUT}/02-aplicada-1440.png`, fullPage: true });

// 2. Tarefa: escolher a ação, executar, conferir.
await page.goto(`${BASE}/agencia/tarefas?abrir=${TAREFA}`);
await page.waitForLoadState("networkidle");
await page.waitForFunction(() => document.querySelector("#tarefa-titulo")?.value?.includes("(prova)"), null, { timeout: 20000 });
await page.locator("#tarefa-acao-ia").selectOption("legenda");
await page.getByRole("button", { name: "Executar com IA" }).waitFor({ timeout: 20000 });
const t1 = Date.now();
await page.getByRole("button", { name: "Executar com IA" }).click();
await page.getByTestId("resultado-da-ia").waitFor({ timeout: 150000 });
log(`legenda em ${Math.round((Date.now() - t1) / 1000)} s:`, (await page.getByTestId("resultado-da-ia").innerText()).replace(/\s+/g, " ").slice(0, 220));
log("coluna (tem de ser revisao):", await page.locator("#tarefa-coluna").inputValue(), "| checklist tem conferir:", await page.getByText("Conferir o resultado da IA").count());
await page.screenshot({ path: `${OUT}/03-legenda-1440.png`, fullPage: true });

// 3. A mesma tarefa cria a publicação em rascunho no calendário.
await page.locator("#tarefa-acao-ia").selectOption("publicacao");
await page.getByRole("button", { name: "Executar de novo" }).waitFor({ timeout: 20000 });
await page.getByRole("button", { name: "Executar de novo" }).click();
await page.getByTestId("resultado-da-ia").filter({ hasText: "Publicação criada em rascunho" }).waitFor({ timeout: 150000 });
const texto = await page.getByTestId("resultado-da-ia").innerText();
const abrir = texto.match(/\/agencia\/publicacoes\?abrir=[0-9a-f-]{36}/)?.[0];
log("publicação:", texto.split("\n")[0]);
await page.goto(`${BASE}${abrir}`);
await page.waitForLoadState("networkidle");
log("no calendário (tem de ser Rascunho):", await page.getByTestId("situacao-da-publicacao").innerText(), "| legenda:", (await page.locator("#pub-legenda").inputValue()).slice(0, 80));
await page.screenshot({ path: `${OUT}/04-publicacao-rascunho-1440.png`, fullPage: true });
await browser.close();
// Depois: /root/agencia-ci/prova/f9-limpar.sql, e conferir agencia_execucoes_ia (tokens, situação).
