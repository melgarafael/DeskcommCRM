// Prova dos Mapas no estilo do Fluxo (plano de 27/10, item 5) pelo membro de teste,
// com mapas-preparar.sql (função temporária e membro TEMPORÁRIO da organização da
// Empresa Modelo para dar "Ciente" como cliente).
import { chromium } from "/app/node_modules/@playwright/test/index.mjs";
import { mkdirSync } from "node:fs";

const BASE = "https://teste.emmovimento.tech";
const OUT = "/prova/evidencias-mapas-fluxo";
mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState: "/prova/sessao-membro.json" });
const page = await ctx.newPage();
page.on("dialog", (d) => d.accept());
const no = (especie) => page.locator(`[data-testid="bloco-do-mapa"][data-especie="${especie}"]`).first();
const painel = () => page.getByTestId("painel-do-bloco");
const msg = () => page.getByTestId("mensagem-do-mapa");
async function esperar(texto) {
  await msg().filter({ hasText: texto }).waitFor({ timeout: 30000 });
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(800);
}

// 1. Mapa a partir do modelo pronto "Recorrente — Etapa 3".
await page.goto(`${BASE}/agencia/mapas`);
await page.waitForLoadState("networkidle");
await page.locator("#mapa-cliente").selectOption({ label: "Empresa Modelo (Testes)" });
await page.locator("#mapa-titulo").fill("Ciclo de dezembro (prova)");
await page.locator("#mapa-modelo").selectOption("recorrente_etapa_3");
await page.getByRole("button", { name: "Criar mapa" }).click();
await page.waitForURL(/\/agencia\/mapas\/[0-9a-f-]{36}$/, { timeout: 20000 });
await page.locator(".react-flow__node").first().waitFor({ timeout: 20000 });
log(
  "modelo Etapa 3:",
  await page.getByTestId("bloco-do-mapa").count(),
  "blocos |",
  await page.locator(".react-flow__edge").count(),
  "setas | mini-mapa:",
  await page.locator(".react-flow__minimap").count(),
  "| controles:",
  await page.locator(".react-flow__controls").count(),
  "| paleta:",
  await page.getByTestId("paleta-do-mapa").locator("button[data-testid^=paleta-]").count(),
  "blocos",
);
await page.screenshot({ path: `${OUT}/01-modelo-etapa-3-1440.png`, fullPage: true });

// 2. Mapa em branco montado pela paleta e pelo "+".
await page.goto(`${BASE}/agencia/mapas`);
await page.waitForLoadState("networkidle");
await page.locator("#mapa-cliente").selectOption({ label: "Empresa Modelo (Testes)" });
await page.locator("#mapa-titulo").fill("Mapa do Fluxo (prova)");
await page.getByRole("button", { name: "Criar mapa" }).click();
await page.waitForURL(/\/agencia\/mapas\/[0-9a-f-]{36}$/, { timeout: 20000 });
const url = page.url();
await page.getByTestId("paleta-roteiro").click();
await esperar("acrescentado");
await no("roteiro").getByTestId("mais-do-bloco").click();
log("o + pede o próximo:", (await page.getByTestId("paleta-do-mapa").innerText()).includes("Escolha o próximo bloco"));
await page.getByTestId("paleta-aviso").click();
await esperar("acrescentado");
await no("aviso").getByTestId("mais-do-bloco").click();
await page.getByTestId("paleta-publicacao").click();
await esperar("acrescentado");
log("depois do +:", await page.getByTestId("bloco-do-mapa").count(), "blocos |", await page.locator(".react-flow__edge").count(), "setas");

// Arrastar da paleta para o mapa (HTML5) e ligar puxando da alça.
await page.getByTestId("paleta-relatorio").dragTo(page.locator(".react-flow__pane"), { targetPosition: { x: 260, y: 420 } });
await esperar("acrescentado");
const pub = page.locator(".react-flow__node", { has: no("publicacao") });
const rel = page.locator(".react-flow__node", { has: no("relatorio") });
await pub.locator(".react-flow__handle-bottom").dragTo(rel.locator(".react-flow__handle-top"));
await esperar("Seta criada");
log("arrastar da paleta + ligar pela alça:", await page.getByTestId("bloco-do-mapa").count(), "blocos |", await page.locator(".react-flow__edge").count(), "setas");

// O painel muda conforme o bloco: texto do aviso; rede e formato do post.
await no("aviso").click();
log("painel do aviso:", await painel().locator("#bloco-texto").count() === 1);
await painel().locator("#bloco-titulo").fill("Gravação confirmada (prova)");
await painel().locator("#bloco-texto").fill("A gravação de dezembro está confirmada para quinta, 14h.");
await painel().getByRole("button", { name: "Salvar bloco" }).click();
await esperar("Bloco salvo");
await no("publicacao").click();
log("painel do post:", (await painel().locator("#bloco-rede").count()) === 1 && (await painel().locator("#bloco-formato").count()) === 1);
await painel().locator("#bloco-titulo").fill("Reels de dezembro (prova)");
await painel().locator("#bloco-formato").selectOption("reels");
await painel().getByRole("button", { name: "Salvar bloco" }).click();
await esperar("Bloco salvo");
await page.screenshot({ path: `${OUT}/02-montado-pela-paleta-1440.png`, fullPage: true });

// 3. Publicar: o Roteiro vira tarefa; concluir a tarefa manda o aviso ao cliente.
await page.getByRole("button", { name: "Publicar" }).click();
await page.getByTestId("tela-do-mapa").and(page.locator('[data-modo="ao-vivo"]')).waitFor({ timeout: 30000 });
const estados = async () =>
  (await page.getByTestId("bloco-do-mapa").evaluateAll((els) => els.map((e) => `${e.dataset.especie}=${e.dataset.situacao}`))).join(" | ");
log("ao vivo:", await estados());
await no("roteiro").click();
await painel().getByRole("link", { name: "Abrir tarefa" }).click();
await page.waitForLoadState("networkidle");
await page.waitForFunction(() => (document.querySelector("#tarefa-titulo")?.value ?? "").length > 0, null, { timeout: 20000 });
await page.locator("#tarefa-coluna").selectOption("concluido");
await page.getByRole("button", { name: "Salvar", exact: true }).click();
await page.waitForTimeout(3000);
await page.goto(url);
await page.waitForLoadState("networkidle");
await page.locator(".react-flow__node").first().waitFor({ timeout: 20000 });
log("roteiro concluído:", await estados());

// 4. O cliente dá "Ciente" no aviso: o bloco conclui e o post nasce no calendário.
await page.goto(`${BASE}/app/aprovacoes`);
await page.waitForLoadState("networkidle");
const aviso = page.getByTestId("aprovacao").filter({ hasText: "Gravação confirmada (prova)" }).first();
log("cliente vê o aviso:", (await aviso.innerText()).includes("quinta, 14h"));
await aviso.getByRole("button", { name: "Ciente" }).click();
await page.waitForTimeout(3000);
await page.goto(url);
await page.waitForLoadState("networkidle");
await page.locator(".react-flow__node").first().waitFor({ timeout: 20000 });
log("depois do Ciente:", await estados());
await no("publicacao").click();
const verPost = painel().getByRole("link", { name: "Ver o post" });
log("o bloco liga ao post:", await verPost.count());
await page.screenshot({ path: `${OUT}/03-ao-vivo-1440.png`, fullPage: true });
await verPost.click();
await page.waitForLoadState("networkidle");
log("post no calendário:", await page.getByTestId("situacao-da-publicacao").innerText().catch(() => "?"), "|", await page.locator("#pub-titulo").inputValue().catch(() => "?"));

// 5. Celular: a lista com o seletor de bloco.
await page.setViewportSize({ width: 375, height: 812 });
await page.goto(url);
await page.waitForLoadState("networkidle");
log("celular:", JSON.stringify(await page.evaluate(() => ({ rola: document.documentElement.scrollWidth > document.documentElement.clientWidth, lista: getComputedStyle(document.querySelector('[data-testid="lista-do-mapa"]')).display }))));
await page.screenshot({ path: `${OUT}/04-celular-375.png`, fullPage: true });
await browser.close();
