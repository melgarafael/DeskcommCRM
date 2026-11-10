/**
 * QUADRO DO FUNIL — AS COLUNAS VAZIAS ACOMPANHAM A ROLAGEM, E O CABEÇALHO
 * PRESO MANTÉM O CONTORNO DE CIMA (#3030).
 *
 * ─── O que só a TELA responde ──────────────────────────────────────────────
 *
 * O defeito é de geometria, e geometria não aparece em jsdom: lá `getBoundingClientRect`
 * devolve zeros. Os dois números que decidem este conserto só existem com layout de
 * verdade, num navegador com altura de viewport:
 *
 *  1. A ALTURA de cada coluna depois de rolar até o fim. Com `min-h-full` medido
 *     contra a altura VISÍVEL do quadro, a coluna vazia parava onde a tela terminava
 *     (`5.375 px` de rolagem contra a coluna comprida de `5.885 px`); a área de soltar
 *     card ia embora com ela. O conserto põe uma faixa (`items-stretch` + `min-h-full`)
 *     entre o quadro rolável e as colunas: TODAS ficam com a altura da mais comprida —
 *     o mesmo número, seja a coluna vazia ou cheia.
 *  2. A BORDA DE CIMA do cabeçalho preso. O cabeçalho é `sticky top-0`, mas a borda de
 *     cima era da COLUNA: rolando, ela saía da tela e o cabeçalho ficava solto. Agora o
 *     contorno é do próprio cabeçalho (`border-t` com `-mt-px`), então ele viaja junto.
 *
 * ─── A régua das medições ─────────────────────────────────────────────────
 *
 * Tudo é lido do DOM vivo (`getBoundingClientRect` e `getComputedStyle`), nunca da
 * classe escrita: `min-h-full` PRESENTE na coluna não prova altura nenhuma — o que
 * prova é o retângulo que o Chromium desenha. As colunas são ancoradas por
 * `data-etapa-do-quadro` (id da etapa) e o cabeçalho por `data-cabecalho-da-etapa`.
 *
 * A fixture é um funil PRÓPRIO deste spec (oito etapas; a primeira com 14 negócios,
 * as outras vazias ou com poucos) e um segundo funil de UMA etapa só — o banco de e2e
 * é compartilhado e usar o funil padrão mexeria nos cards de outras specs.
 *
 * Pré-requisitos (banco local do baseline, app buildada):
 *   pnpm e2e:env && pnpm e2e:build
 *   pnpm exec playwright test tests/e2e/quadro-do-funil-colunas.spec.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Locator, type Page } from "./helpers/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let creds: Creds;
const SUFIXO = `${Date.now()}`.slice(-7);

// ─── Funil principal: 8 etapas, a primeira comprida ───────────────────────
const NOME_PRINCIPAL = `Colunas E2E ${SUFIXO}`;
/** 14 na etapa comprida — o suficiente para o quadro rolar bastante além da tela. */
const QUANTOS = 14;
/** Quantos cards em cada etapa (a 1ª é a comprida; há etapas de 1 e de 4 cards). */
const CARDS_POR_ETAPA = [QUANTOS, 0, 1, 0, 4, 0, 0, 0];
const TITULO = (etapa: number, i: number) => `Col ${SUFIXO} e${etapa} c${String(i).padStart(2, "0")}`;
let etapas: { id: string; nome: string; cards: number }[] = [];

// ─── Funil de UMA etapa só ────────────────────────────────────────────────
const NOME_UNICA = `Colunas E2E ${SUFIXO} unica`;
let etapaUnicaId = "";

async function login(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}

async function limparFixtures(): Promise<void> {
  const { data } = await admin
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", creds.org_id)
    .like("name", `Colunas E2E ${SUFIXO}%`);
  const ids = ((data ?? []) as { id: string }[]).map((p) => p.id);
  if (ids.length === 0) return;
  await admin.from("crm_lead_activities").delete().in("pipeline_id", ids);
  await admin.from("crm_leads").delete().in("pipeline_id", ids);
  await admin.from("crm_stages").delete().in("pipeline_id", ids);
  await admin.from("crm_pipelines").delete().in("id", ids);
}

async function semearFunil(nome: string, cardsPorEtapa: number[]): Promise<{ pipelineId: string; ids: string[] }> {
  const { data: funil, error } = await admin
    .from("crm_pipelines")
    .insert({ organization_id: creds.org_id, name: nome, slug: nome.toLowerCase().replace(/[^a-z0-9]+/g, "-") })
    .select("id")
    .single();
  if (error) throw new Error(`funil ${nome}: ${error.message}`);
  const pipelineId = (funil as { id: string }).id;

  const ids: string[] = [];
  const linhas: Record<string, unknown>[] = [];
  for (let e = 0; e < cardsPorEtapa.length; e++) {
    const { data: etapa, error: erroEtapa } = await admin
      .from("crm_stages")
      .insert({
        organization_id: creds.org_id,
        pipeline_id: pipelineId,
        name: e === 0 ? "Comprida" : `Etapa ${e + 1}`,
        slug: `etapa-${e + 1}-${SUFIXO}`,
        position: (e + 1) * 1000,
      })
      .select("id")
      .single();
    if (erroEtapa) throw new Error(`etapa ${e + 1}: ${erroEtapa.message}`);
    const stageId = (etapa as { id: string }).id;
    ids.push(stageId);
    for (let i = 0; i < cardsPorEtapa[e]!; i++) {
      linhas.push({
        organization_id: creds.org_id,
        pipeline_id: pipelineId,
        stage_id: stageId,
        title: TITULO(e, i + 1),
        position_in_stage: (i + 1) * 1000,
        source: "manual",
      });
    }
  }
  if (linhas.length > 0) {
    const { error: erroLeads } = await admin.from("crm_leads").insert(linhas);
    if (erroLeads) throw new Error(`leads de ${nome}: ${erroLeads.message}`);
  }
  return { pipelineId, ids };
}

/** O contêiner que ROLA nos dois eixos — a referência da altura visível. */
function quadro(page: Page): Locator {
  return page.locator("[data-quadro-do-funil]");
}

/** Rola o quadro até o fim (para baixo) e espera o `sticky` assentar. */
async function rolarAteOFim(page: Page): Promise<void> {
  await quadro(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(400);
}

interface MedidaDaColuna {
  id: string;
  altura: number;
  topo: number;
}

/** A altura DESENHADA de cada coluna, e onde o topo dela está na tela. */
function medirColunas(page: Page): Promise<MedidaDaColuna[]> {
  return page.$$eval("[data-etapa-do-quadro]", (els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return {
        id: el.getAttribute("data-etapa-do-quadro") ?? "",
        altura: r.height,
        topo: r.top,
      };
    }),
  );
}

/** A altura da lista de cards (a área que o dnd registra como destino de soltar). */
function alturaDaLista(page: Page, stageId: string): Promise<number> {
  return page
    .locator(`[data-rfd-droppable-id="${stageId}"]`)
    .evaluate((el) => el.getBoundingClientRect().height);
}

async function abrirQuadro(page: Page, pipelineId: string, primeiroTitulo: string): Promise<void> {
  await login(page, creds.users.manager!.email, creds.password);
  await page.goto(`/app/pipelines/${pipelineId}`);
  await expect(page.getByText(primeiroTitulo, { exact: true })).toBeVisible({ timeout: 30_000 });
}

test.describe("Quadro do funil — coluna vazia acompanha a rolagem e cabeçalho preso com topo", () => {
  test.describe.configure({ timeout: 240_000 });

  let pipelinePrincipal = "";
  let pipelineUnica = "";

  test.beforeAll(async () => {
    if (!fs.existsSync(CREDS_PATH)) {
      execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
    }
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    // O worker do Playwright reinicia depois de um vermelho e o `beforeAll` roda de
    // novo com outro `SUFIXO`: sem esta limpeza os funis das execuções anteriores
    // ficam no banco compartilhado.
    await limparFixtures();

    const principal = await semearFunil(NOME_PRINCIPAL, CARDS_POR_ETAPA);
    pipelinePrincipal = principal.pipelineId;
    etapas = principal.ids.map((id, i) => ({
      id,
      nome: i === 0 ? "Comprida" : `Etapa ${i + 1}`,
      cards: CARDS_POR_ETAPA[i]!,
    }));

    const unica = await semearFunil(NOME_UNICA, [QUANTOS]);
    pipelineUnica = unica.pipelineId;
    etapaUnicaId = unica.ids[0]!;
  });

  test.afterAll(async () => {
    await limparFixtures();
  });

  test("depois de rolar até o fim, TODAS as colunas têm a altura da mais comprida", async ({
    page,
  }) => {
    await abrirQuadro(page, pipelinePrincipal, TITULO(0, 1));

    const visivel = await quadro(page).evaluate((el) => el.clientHeight);
    const rolagemTotal = await quadro(page).evaluate((el) => el.scrollHeight);

    const antes = await medirColunas(page);
    expect(antes.length, "as 8 etapas do funil principal").toBe(8);

    await rolarAteOFim(page);
    const scrollTop = await quadro(page).evaluate((el) => el.scrollTop);
    expect(scrollTop, "o quadro realmente rolou (há conteúdo abaixo da dobra)").toBeGreaterThan(0);

    const depois = await medirColunas(page);
    const comprida = depois.find((c) => c.id === etapas[0]!.id)!;
    const cardsPorId = new Map(etapas.map((e) => [e.id, e.cards]));
    const vazias = depois.filter((c) => cardsPorId.get(c.id) === 0);
    expect(vazias.length, "há colunas VAZIAS no funil de prova").toBeGreaterThan(0);

    // A coluna comprida tem de passar da altura visível — senão não havia o que rolar.
    expect(comprida.altura, "a etapa comprida cresce além da tela").toBeGreaterThan(visivel + 100);

    // O ponto do conserto: as vazias NÃO param na altura visível.
    for (const v of vazias) {
      expect(
        v.altura,
        `coluna vazia (${v.id}) parou na altura visível em vez de acompanhar a comprida`,
      ).toBeGreaterThan(visivel + 100);
    }

    // E o número é o MESMO da mais comprida, etapa por etapa (tolerância de 1 px
    // para arredondamento de sub-pixel do Chromium).
    const alturas = depois.map((c) => c.altura);
    const maior = Math.max(...alturas);
    const menor = Math.min(...alturas);
    expect(
      maior - menor,
      `alturas das colunas divergem: ${JSON.stringify(depois.map((c) => [c.id, Math.round(c.altura)]))}`,
    ).toBeLessThanOrEqual(1);

    // A ÁREA DE SOLTAR CARD inteira: a lista de uma vazia tem a mesma altura da lista
    // da comprida — o vazio até o fim da coluna continua sendo destino do arraste.
    const listaVazia = await alturaDaLista(page, vazias[0]!.id);
    const listaComprida = await alturaDaLista(page, etapas[0]!.id);
    expect(
      Math.abs(listaVazia - listaComprida),
      `área de soltar da vazia (${Math.round(listaVazia)}px) difere da comprida (${Math.round(listaComprida)}px)`,
    ).toBeLessThanOrEqual(1);

    expect(rolagemTotal).toBeGreaterThan(visivel);
  });

  test("o cabeçalho preso da etapa fica no alto COM o contorno de cima depois da rolagem", async ({
    page,
  }) => {
    await abrirQuadro(page, pipelinePrincipal, TITULO(0, 1));
    await rolarAteOFim(page);

    const caixaDoQuadro = await quadro(page).boundingBox();
    expect(caixaDoQuadro).not.toBeNull();

    for (const etapa of etapas) {
      const cabecalho = page.locator(
        `[data-etapa-do-quadro="${etapa.id}"] [data-cabecalho-da-etapa]`,
      );
      const caixa = await cabecalho.boundingBox();
      expect(caixa, `cabeçalho da etapa ${etapa.nome} visível`).not.toBeNull();

      // Preso no alto: o topo do cabeçalho está na borda de cima do quadro (sticky
      // `top-0`), não fora da tela. Tolerância de 2 px para o arredondamento.
      expect(
        caixa!.y,
        `cabeçalho da etapa ${etapa.nome} solto no meio da rolagem (y=${caixa!.y}, quadro=${caixaDoQuadro!.y})`,
      ).toBeGreaterThanOrEqual(caixaDoQuadro!.y - 2);
      expect(caixa!.y).toBeLessThanOrEqual(caixaDoQuadro!.y + 4);

      // O CONTORNO DE CIMA é do próprio cabeçalho (o defeito era a borda ser da
      // coluna e sair da tela). Lido do `getComputedStyle`, não da classe escrita.
      const borda = await cabecalho.evaluate((el) => {
        const s = getComputedStyle(el);
        return { largura: s.borderTopWidth, estilo: s.borderTopStyle, cor: s.borderTopColor };
      });
      expect(
        parseFloat(borda.largura),
        `cabeçalho de ${etapa.nome} sem espessura de borda em cima (${borda.largura})`,
      ).toBeGreaterThanOrEqual(1);
      expect(borda.estilo, `borda de cima de ${etapa.nome} não é sólida`).toBe("solid");
      expect(
        borda.cor,
        `borda de cima de ${etapa.nome} transparente (${borda.cor})`,
      ).not.toMatch(/rgba?\([^)]*,\s*0\s*\)$/);

      // E o topo do cabeçalho está DENTRO da faixa visível do quadro.
      expect(caixa!.y + caixa!.height).toBeLessThanOrEqual(caixaDoQuadro!.y + caixaDoQuadro!.height + 2);
    }
  });

  test("CONTROLE: quadro com UMA etapa só segue correto (a coluna ocupa a altura visível)", async ({
    page,
  }) => {
    await abrirQuadro(page, pipelineUnica, TITULO(0, 1));

    const colunas = await medirColunas(page);
    expect(colunas.length, "o funil de uma etapa desenha uma coluna").toBe(1);

    const visivel = await quadro(page).evaluate((el) => el.clientHeight);
    // Com uma etapa comprida, a coluna é mais alta que a tela (não há o que
    // esticar além dela); o que se prova aqui é que a faixa de uma coluna só
    // não colapsa nada nem inventa altura.
    expect(colunas[0]!.altura).toBeGreaterThan(visivel);

    await rolarAteOFim(page);
    const cabecalho = page.locator(
      `[data-etapa-do-quadro="${etapaUnicaId}"] [data-cabecalho-da-etapa]`,
    );
    const borda = await cabecalho.evaluate((el) => getComputedStyle(el).borderTopWidth);
    expect(parseFloat(borda)).toBeGreaterThanOrEqual(1);
  });

  test("CONTROLE: colunas de alturas DIFERENTES (0, 1 e 4 cards) seguem todas iguais à mais comprida", async ({
    page,
  }) => {
    await abrirQuadro(page, pipelinePrincipal, TITULO(0, 1));
    await rolarAteOFim(page);

    const depois = await medirColunas(page);
    const porId = new Map(depois.map((c) => [c.id, c.altura]));

    // As três etapas curtas/intermediárias: 0, 1 e 4 cards.
    const curtas = etapas.filter((e) => e.cards < QUANTOS);
    expect(curtas.length).toBe(7);
    const comprida = porId.get(etapas[0]!.id)!;
    for (const e of curtas) {
      expect(
        Math.abs(porId.get(e.id)! - comprida),
        `etapa ${e.nome} (${e.cards} cards) com ${Math.round(porId.get(e.id)!)}px, comprida com ${Math.round(comprida)}px`,
      ).toBeLessThanOrEqual(1);
    }
  });

  test("CONTROLE: o arraste continua inteiro — a rolagem automática do @hello-pangea/dnd segue viva", async ({
    page,
  }) => {
    // O conserto NÃO cria um contêiner rolável novo (o `dnd` não suporta `Droppable`
    // dentro de outro rolável); esta medição prova que a rolagem automática do arraste
    // continua acontecendo com a faixa no meio. Sem o arraste, ela não testa nada.
    await abrirQuadro(page, pipelinePrincipal, TITULO(0, 1));

    // O gesto parte do respiro do CARD (canto de cima, à esquerda), não do título: o
    // título é um `<button>`, e o dnd não começa arraste em elemento interativo — com o
    // ponteiro nele, nenhum arraste começava, com ou sem o conserto.
    const cartao = page
      .locator("[data-rfd-draggable-id]")
      .filter({ has: page.getByText(TITULO(0, 1), { exact: true }) });
    const caixaCartao = await cartao.boundingBox();
    const caixaQuadro = await quadro(page).boundingBox();
    expect(caixaCartao).not.toBeNull();
    expect(caixaQuadro).not.toBeNull();

    const x = caixaCartao!.x + 6;
    const y = caixaCartao!.y + 4;

    await page.mouse.move(x, y);
    await page.mouse.down();
    // Pequeno passo para disparar o início do arraste (o dnd exige um movimento).
    await page.mouse.move(x, y + 12, { steps: 5 });
    await page.waitForTimeout(150);
    // Leva o ponteiro para a borda de BAIXO do quadro e segura: é isso que aciona
    // a rolagem automática.
    const alvoY = caixaQuadro!.y + caixaQuadro!.height - 6;
    await page.mouse.move(x, alvoY, { steps: 25 });
    await page.waitForTimeout(1200);

    // Sem esta guarda, "o arraste nem começou" e "a rolagem automática morreu" davam o
    // MESMO zero abaixo. O dnd tira o card arrastado do fluxo com `position: fixed`.
    const arrastando = await page.$$eval("[data-rfd-draggable-id]", (els) =>
      els.filter((el) => getComputedStyle(el).position === "fixed").length,
    );
    expect(arrastando, "o arraste nem começou — o gesto não pegou o card").toBe(1);
    const rolouSozinho = await quadro(page).evaluate((el) => el.scrollTop);
    await page.mouse.up();
    await page.waitForTimeout(300);

    expect(
      rolouSozinho,
      "o quadro não rolou sozinho durante o arraste — a rolagem automática do dnd morreu",
    ).toBeGreaterThan(0);
  });
});
