/**
 * Sonda do orquestrador — por que a aba Timeline do contato aparece VAZIA
 * enquanto o banco tem 5 atividades para o mesmo contato?
 *
 * A tela não mostrou nem o estado vazio ("Nenhuma atividade registrada ainda"),
 * nem esqueleto, nem erro. Nada. Isso é um quarto estado que o componente não
 * declara — então a resposta não está no pixel, está no que a rota devolveu.
 *
 * Esta sonda não julga a tela: ela grava o que a API respondeu e o que o console
 * gritou, para o veredito sair de dado e não de suposição.
 *
 * Run: E2E_PORT=3020 npx tsx tests/sonda-timeline-contato.ts
 */
import { chromium } from "@playwright/test";

import { BASE, EVIDENCE, login, shotPage } from "./qa-helpers";

const CONTATO_ID = "5b37994e-4ba0-46ff-99ca-7b8364a67909"; // Ana Souza LGPD E2E

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const errosConsole: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errosConsole.push(m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => errosConsole.push(`pageerror: ${e.message.slice(0, 300)}`));

  // Guardado em PROPRIEDADE, não em `let`: atribuição que só acontece dentro de
  // callback não é vista pela análise de fluxo do TS, que estreita a variável
  // para `null` e faz o ramo verdadeiro virar `never`. Acesso a propriedade
  // preserva o tipo declarado.
  const capturas: { timeline: { status: number; corpo: string } | null } = { timeline: null };
  // Um 429 sem endereço é ruído; com endereço é diagnóstico. Se quem apanhar for
  // o realtime-token, o canal volta a assinar como anônimo e o defeito que já
  // corrigimos ressuscita calado — exatamente a falha que não se vê.
  const estourados: string[] = [];
  page.on("response", async (r) => {
    if (r.status() === 429) estourados.push(r.url().replace(BASE, ""));
    if (!r.url().includes("/timeline")) return;
    capturas.timeline = {
      status: r.status(),
      corpo: (await r.text().catch(() => "")).slice(0, 600),
    };
  });

  await login(page, "admin");
  await page.goto(`${BASE}/app/contacts/${CONTATO_ID}`, { waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "Linha do tempo" }).click();

  // Espera por CONTEÚDO, nunca por relógio (BRIEFING §7.1) — a busca só dispara
  // depois do clique, e um `waitForTimeout` ganha nesta máquina e perde na do CI.
  // Aceita os DOIS desfechos legítimos: linha renderizada OU estado vazio. Se
  // esperasse só pela linha, uma timeline honestamente vazia travaria a sonda.
  const painel = page.locator("main");
  await painel
    .locator("li")
    .or(painel.getByText("Nenhuma atividade registrada"))
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });

  // O que o usuário realmente enxerga na área abaixo das abas.
  const textoVisivel = (await painel.innerText().catch(() => "")).slice(0, 400);
  // Escopado ao painel: o menu lateral também é lista, e contar `li` solto
  // inflaria o número com navegação — medida frouxa que eu mesmo reprovaria.
  const linhas = await painel.locator("li").count();

  await shotPage(page, "sonda-timeline-contato.png");

  console.info("=== RESPOSTA DA ROTA /timeline ===");
  console.info(capturas.timeline ? `HTTP ${capturas.timeline.status}\n${capturas.timeline.corpo}` : "NENHUMA CHAMADA À ROTA");
  console.info("\n=== QUEM LEVOU 429 ===");
  console.info(estourados.length ? estourados.join("\n") : "(nenhum)");
  console.info("\n=== ERROS DE CONSOLE ===");
  console.info(errosConsole.length ? errosConsole.join("\n") : "(nenhum)");
  console.info("\n=== ITENS <li> RENDERIZADOS ===");
  console.info(String(linhas));
  console.info("\n=== TEXTO VISÍVEL ===");
  console.info(textoVisivel);
  console.info(`\nprint: ${EVIDENCE}/sonda-timeline-contato.png`);

  await browser.close();
}

void main();
