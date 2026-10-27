// Prova dos Envios (docs/agencia/SPEC-envios.md) pelos dois lados, com o membro de
// teste: função temporária "Envios (prova)" (tarefas.criar) e membro TEMPORÁRIO
// (agent) da "Empresa Modelo (Testes)" para responder como cliente — ver
// envios-preparar.sql / envios-limpar.sql. Arquivos: /prova/prova-envio.mp4 (~20 MB,
// sobe em várias partes de 6 MB) e /prova/prova-arte.png.
import { chromium } from "/app/node_modules/@playwright/test/index.mjs";
import { mkdirSync } from "node:fs";

const BASE = "https://teste.emmovimento.tech";
const CLIENTE = "Empresa Modelo (Testes)";
const OUT = "/prova/evidencias-envios";
mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, storageState: "/prova/sessao-membro.json" });
const page = await ctx.newPage();
page.on("dialog", (d) => d.accept());
const envio = (titulo) => page.getByTestId("envio").filter({ hasText: titulo }).first();
const msg = () => page.getByTestId("mensagem-dos-envios");

async function novoEnvio({ tipo, titulo, arquivo, texto, descricao }) {
  await page.getByRole("button", { name: "Novo envio" }).click();
  const f = page.getByTestId("novo-envio");
  await f.locator("#envio-cliente").selectOption({ label: CLIENTE });
  await f.getByRole("radio", { name: tipo }).click();
  await f.locator("#envio-titulo").fill(titulo);
  if (arquivo) await f.locator("#envio-arquivo").setInputFiles(arquivo);
  if (texto) await f.locator("#envio-texto").fill(texto);
  if (descricao) await f.locator("#envio-descricao").fill(descricao);
  const t0 = Date.now();
  await f.getByRole("button", { name: /Enviar/ }).click();
  let viuProgresso = false;
  if (arquivo) viuProgresso = await page.getByTestId("progresso-do-envio").waitFor({ timeout: 15000 }).then(() => true, () => false);
  // Espera o envio APARECER na lista (a mensagem do envio anterior pode ainda estar na tela).
  await envio(titulo).waitFor({ timeout: 180000 });
  log(`${tipo} "${titulo}" em ${Math.round((Date.now() - t0) / 1000)} s | barra de progresso: ${viuProgresso} |`, (await msg().innerText()).replace(/\s+/g, " "));
}

// 1. A agência manda vídeo, arte, roteiro e aviso — pela tela Envios.
await page.goto(`${BASE}/agencia/envios`);
await page.waitForLoadState("networkidle");
log("menu Envios:", await page.getByRole("link", { name: "Envios" }).count());
await novoEnvio({ tipo: "Vídeo", titulo: "Reels da vitrine (prova)", arquivo: "/prova/prova-envio.mp4", descricao: "Legenda: Natal chegou na vitrine! 20% até domingo." });
await novoEnvio({ tipo: "Arte", titulo: "Arte do feed (prova)", arquivo: "/prova/prova-arte.png" });
await novoEnvio({ tipo: "Roteiro", titulo: "Roteiro do Reels 2 (prova)", texto: "CENA 1 — vitrine de longe.\nFALA: \"O Natal chegou!\"\nCENA 2 — produto em close." });
await novoEnvio({ tipo: "Aviso", titulo: "Gravação remarcada (prova)", texto: "A gravação passou para quinta, 14h. Deixe a vitrine montada." });
log("esperando o cliente:", await page.getByTestId("envio").and(page.locator('[data-situacao="pendente"]')).count());
await envio("Reels da vitrine").locator("button").first().click();
await page.getByTestId("video-do-envio").first().waitFor({ timeout: 15000 });
await page.screenshot({ path: `${OUT}/01-envios-da-agencia-1440.png`, fullPage: true });

// 2. Cancelar a arte apaga o arquivo da VPS (E8) — conferido no banco pelo script de fora.
await envio("Arte do feed").locator("button").first().click();
await envio("Arte do feed").getByRole("button", { name: "Cancelar envio" }).click();
await msg().filter({ hasText: "cancelado" }).waitFor({ timeout: 20000 });
await page.getByTestId("envio").filter({ hasText: "Arte do feed" }).waitFor({ state: "detached", timeout: 20000 }).catch(() => undefined);
log("arte cancelada:", (await page.getByTestId("envio").filter({ hasText: "Arte do feed" }).count()) === 0 ? "sumiu da lista" : "ainda na lista");

// 3. O cliente, na organização dele: vídeo toca AQUI, roteiro em texto, aviso com "Ciente".
await page.goto(`${BASE}/app/aprovacoes`);
await page.waitForLoadState("networkidle");
const cartao = (t) => page.getByTestId("aprovacao").filter({ hasText: t }).first();
const video = cartao("Reels da vitrine").getByTestId("video-do-envio");
await video.waitFor({ timeout: 15000 });
const meta = await video.evaluate(
  (v) =>
    new Promise((ok) => {
      if (v.readyState >= 1) return ok({ readyState: v.readyState, duracao: Math.round(v.duration), largura: v.videoWidth });
      v.addEventListener("loadedmetadata", () => ok({ readyState: v.readyState, duracao: Math.round(v.duration), largura: v.videoWidth }), { once: true });
      v.addEventListener("error", () => ok({ erro: v.error?.code }), { once: true });
      setTimeout(() => ok({ readyState: v.readyState, tempoEsgotado: true }), 20000);
    }),
);
log("vídeo no cliente:", JSON.stringify(meta), "| é do nosso domínio:", (await video.getAttribute("src"))?.startsWith(BASE));
log("descrição ao lado:", (await cartao("Reels da vitrine").innerText()).includes("20% até domingo"));
log("roteiro em texto:", (await cartao("Roteiro do Reels 2").getByTestId("texto-do-envio").innerText()).slice(0, 40));
log("link para o Drive nos envios desta prova:", await page.getByTestId("aprovacao").filter({ hasText: "(prova)" }).locator('a[href*="drive.google.com"]').count());
await page.screenshot({ path: `${OUT}/02-cliente-ve-1440.png`, fullPage: true });

await cartao("Gravação remarcada").getByRole("button", { name: "Ciente" }).click();
await page.waitForTimeout(2500);
await cartao("Reels da vitrine").getByRole("button", { name: "Pedir ajustes" }).click();
await cartao("Reels da vitrine").getByLabel("O que precisa mudar").fill("Colocar o preço no começo do vídeo.");
await cartao("Reels da vitrine").getByRole("button", { name: "Enviar pedido de ajustes" }).click();
await page.waitForTimeout(2500);
await cartao("Roteiro do Reels 2").getByRole("button", { name: "Aprovar" }).click();
await page.waitForTimeout(3000);
await page.reload();
await page.waitForLoadState("networkidle");
log("aviso:", (await cartao("Gravação remarcada").innerText()).includes("ciente") ? "marcado ciente" : "?");

// 4. A agência vê o pedido e manda a v2; o cliente aprova.
await page.goto(`${BASE}/agencia/envios`);
await page.waitForLoadState("networkidle");
log("agência vê:", (await envio("Reels da vitrine").innerText()).replace(/\s+/g, " ").slice(0, 160));
await envio("Reels da vitrine").locator("button").first().click();
await envio("Reels da vitrine").getByRole("button", { name: "Enviar nova versão" }).click();
await page.getByTestId("novo-envio").locator("#envio-arquivo").setInputFiles("/prova/prova-envio.mp4");
await page.getByTestId("novo-envio").getByRole("button", { name: /Enviar/ }).click();
await msg().filter({ hasText: "aprovar" }).waitFor({ timeout: 180000 });
await page.goto(`${BASE}/app/aprovacoes`);
await page.waitForLoadState("networkidle");
const v2 = page.getByTestId("aprovacao").filter({ hasText: "v2" }).first();
await v2.getByRole("button", { name: "Aprovar" }).click();
await page.waitForTimeout(4000);

// 5. Aprovado sem Drive conectado: fica na VPS e a tela diz por quê (E7).
await page.goto(`${BASE}/agencia/envios`);
await page.waitForLoadState("networkidle");
log("cópia do vídeo:", (await page.getByTestId("copia-do-envio").filter({ hasText: "Drive" }).allInnerTexts()).map((t) => t.slice(0, 120)).join(" || "));
await page.screenshot({ path: `${OUT}/03-aprovado-esperando-drive-1440.png`, fullPage: true });

// 6. Celular: a tela do cliente com o vídeo.
await page.setViewportSize({ width: 375, height: 812 });
await page.goto(`${BASE}/app/aprovacoes`);
await page.waitForLoadState("networkidle");
await page.waitForTimeout(1500);
log("celular:", JSON.stringify(await page.evaluate(() => ({ rola: document.documentElement.scrollWidth > document.documentElement.clientWidth }))));
await page.screenshot({ path: `${OUT}/04-cliente-375.png`, fullPage: true });
await browser.close();
