// Prova dos modelos de tarefa e da pasta do cliente (plano de 27/10, item 4) pelo
// membro de teste, com uma função temporária "Tarefas (prova)" (tarefas.criar).
import { chromium } from "/app/node_modules/@playwright/test/index.mjs";
import { mkdirSync } from "node:fs";

const BASE = "https://teste.emmovimento.tech";
const OUT = "/prova/evidencias-tarefas-modelos";
mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState: "/prova/sessao-membro.json" });
const page = await ctx.newPage();

await page.goto(`${BASE}/agencia/tarefas`);
await page.waitForLoadState("networkidle");
await page.getByRole("button", { name: "Nova tarefa" }).first().click();
await page.locator("#tarefa-modelo").waitFor({ timeout: 15000 });
log("modelos oferecidos:", (await page.locator("#tarefa-modelo option").count()) - 1);
await page.locator("#tarefa-modelo").selectOption("edicao");
log("título:", await page.locator("#tarefa-titulo").inputValue());
await page.locator("#tarefa-modelo").selectOption("gravacao");
const itens = await page.getByRole("checkbox", { name: /^Feito:/ }).count();
log("depois do modelo Gravação: título =", await page.locator("#tarefa-titulo").inputValue(), "| itens do checklist:", itens);
await page.locator("#tarefa-titulo").fill("Gravação de dezembro (prova)");
await page.locator("#tarefa-cliente").selectOption({ label: "Empresa Modelo (Testes)" });
await page.getByTestId("pastas-do-cliente").waitFor({ timeout: 10000 });
log("botões de pasta:", (await page.getByTestId("pastas-do-cliente").getByRole("button").allInnerTexts()).join(" | "));
await page.getByTestId("pastas-do-cliente").getByRole("button").first().click();
await page.getByRole("alert").filter({ hasText: "Drive" }).first().waitFor({ timeout: 15000 }).catch(() => undefined);
log("pasta Captações:", (await page.getByRole("alert").filter({ hasText: "Drive" }).first().innerText().catch(() => "(link entrou)")).replace(/\s+/g, " "));
await page.screenshot({ path: `${OUT}/01-modelo-1440.png`, fullPage: true });
await page.getByRole("button", { name: "Salvar", exact: true }).click();
await page.waitForTimeout(3000);
await browser.close();
