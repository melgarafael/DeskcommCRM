/**
 * AÇÕES EM LOTE NO QUADRO DO FUNIL — provado pela tela, com os gestos na mão.
 *
 * O motor (`fn_mover_leads_em_lote`, migration 0209) já tem invariante contra
 * Postgres real, e a aritmética da seleção (`lib/kanban/selecao.ts`) tem teste
 * de unidade. Nenhum dos dois toca o que este recurso É para quem usa: um
 * quadro onde se marca, se estende com shift, se conta e se move.
 *
 * ─── O que só a tela responde ──────────────────────────────────────────────
 *  · A caixa por card EXISTE e é achável (ela nasce `opacity-0` de propósito —
 *    medir `getComputedStyle` é a diferença entre "está lá" e "dá para ver").
 *  · A caixa da etapa tem o terceiro estado. `indeterminate` NÃO é atributo do
 *    HTML e não aparece no DOM serializado: só `el.indeterminate` responde. Um
 *    spec que checasse `checked` diria que "alguns" e "nenhum" são a mesma
 *    coisa — que é exatamente o defeito que o estado intermediário evita.
 *  · Shift+clique pega a FAIXA VISÍVEL, e não "os ids entre dois uuids".
 *  · A contagem "7/23" bate com quantas caixas estão marcadas de verdade.
 *  · Mover N de uma vez preserva a ORDEM relativa e põe todos no FIM do
 *    destino — e isso é relido depois de `reload()`, porque a promessa do
 *    recurso é sobre o que fica no banco, não sobre o que a tela desenhou.
 *
 * A fixture é um funil PRÓPRIO deste spec (duas etapas, nove cards). O banco de
 * e2e é compartilhado; usar o funil padrão faria este spec mover cards de
 * `kanban-owner-filter` e de `pipelines-gestao` sem avisar ninguém.
 *
 * Pré-requisitos (banco local do baseline, app buildada):
 *   pnpm e2e:env && pnpm e2e:build
 *   pnpm exec playwright test tests/e2e/lote-no-quadro-do-funil.spec.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA =
  process.env.E2E_EVIDENCIA ?? path.join(process.cwd(), ".superpowers/evidence/lote-no-funil");

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
const NOME_DO_FUNIL = `Lote E2E ${SUFIXO}`;
/** Nove cards: o suficiente para uma faixa ter meio, começo e fim distintos. */
const QUANTOS = 9;
const TITULO = (i: number) => `Lote ${SUFIXO} card ${String(i).padStart(2, "0")}`;
/** O card que já mora no destino — é ele que prova o "entram no FIM". */
const TITULO_ANCORADO = `Lote ${SUFIXO} ja estava no destino`;

let pipelineId = "";
let etapaOrigemId = "";
let etapaDestinoId = "";

async function login(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

/**
 * A lista de cards de uma etapa — a área que o dnd registra como destino.
 *
 * ⚠️ NÃO ancore uma coluna por "o div que contém o nome da etapa": o `div` mais
 * interno que satisfaz isso é o CABEÇALHO, que não tem card nenhum dentro.
 * Medido: com aquele seletor a leitura da ordem devolvia lista vazia, e vazio
 * lê como "os cards não chegaram" — um vermelho que acusa o produto por um erro
 * do teste. `@hello-pangea/dnd` publica `data-rfd-droppable-id` com o id da
 * etapa, que é âncora estável e sem ambiguidade.
 */
function listaDaEtapa(page: Page, etapaId: string): Locator {
  return page.locator(`[data-rfd-droppable-id="${etapaId}"]`);
}

/** A coluna INTEIRA (cabeçalho + lista): o pai do droppable. */
function coluna(page: Page, etapaId: string): Locator {
  return listaDaEtapa(page, etapaId).locator("xpath=..");
}

/** A caixa de seleção de um card, pelo título dele. */
function caixaDoCard(page: Page, titulo: string): Locator {
  return page.getByRole("checkbox", { name: `Selecionar: ${titulo}` });
}

/** Quais dos nossos cards estão marcados AGORA, lidos do próprio DOM. */
async function marcados(page: Page): Promise<string[]> {
  const saida: string[] = [];
  for (let i = 1; i <= QUANTOS; i++) {
    const caixa = caixaDoCard(page, TITULO(i));
    if ((await caixa.count()) === 0) continue;
    if (await caixa.isChecked()) saida.push(TITULO(i));
  }
  return saida;
}

/** A ordem em que o quadro DESENHA os cards de uma etapa, de cima para baixo. */
async function ordemNaEtapa(page: Page, etapaId: string): Promise<string[]> {
  const titulos = await listaDaEtapa(page, etapaId).locator("h3").allInnerTexts();
  return titulos.map((x) => x.trim()).filter((x) => x.startsWith(`Lote ${SUFIXO}`));
}

/** A ordem gravada no banco: `position_in_stage` crescente. */
async function ordemNoBanco(etapaId: string): Promise<string[]> {
  const { data, error } = await admin
    .from("crm_leads")
    .select("title, position_in_stage")
    .eq("stage_id", etapaId)
    .order("position_in_stage", { ascending: true });
  if (error) throw new Error(`ordem no banco: ${error.message}`);
  return ((data ?? []) as { title: string }[]).map((l) => l.title);
}

async function limparFixtures(): Promise<void> {
  const { data } = await admin
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", creds.org_id)
    .like("name", "Lote E2E %");
  const ids = ((data ?? []) as { id: string }[]).map((p) => p.id);
  if (ids.length === 0) return;
  await admin.from("crm_lead_activities").delete().in("pipeline_id", ids);
  await admin.from("crm_leads").delete().in("pipeline_id", ids);
  await admin.from("crm_stages").delete().in("pipeline_id", ids);
  await admin.from("crm_pipelines").delete().in("id", ids);
}

test.describe("Quadro do funil — agir em vários cards de uma vez", () => {
  test.describe.configure({ timeout: 240_000 });

  test.beforeAll(async () => {
    if (!fs.existsSync(CREDS_PATH)) {
      execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
    }
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    // O Playwright reinicia o worker depois de um vermelho e o `beforeAll` roda
    // de novo com outro `SUFIXO` — sem esta linha os funis de execuções
    // anteriores ficam para trás no banco compartilhado.
    await limparFixtures();

    const { data: funil, error: erroFunil } = await admin
      .from("crm_pipelines")
      .insert({
        organization_id: creds.org_id,
        name: NOME_DO_FUNIL,
        slug: `lote-e2e-${SUFIXO}`,
      })
      .select("id")
      .single();
    if (erroFunil) throw new Error(`funil: ${erroFunil.message}`);
    pipelineId = (funil as { id: string }).id;

    for (const [nome, posicao] of [
      ["Origem", 1000],
      ["Destino", 2000],
    ] as [string, number][]) {
      const { data, error } = await admin
        .from("crm_stages")
        .insert({
          organization_id: creds.org_id,
          pipeline_id: pipelineId,
          name: nome,
          slug: `${nome.toLowerCase()}-${SUFIXO}`,
          position: posicao,
        })
        .select("id")
        .single();
      if (error) throw new Error(`etapa ${nome}: ${error.message}`);
      if (nome === "Origem") etapaOrigemId = (data as { id: string }).id;
      else etapaDestinoId = (data as { id: string }).id;
    }

    const linhas = Array.from({ length: QUANTOS }, (_, i) => ({
      organization_id: creds.org_id,
      pipeline_id: pipelineId,
      stage_id: etapaOrigemId,
      title: TITULO(i + 1),
      position_in_stage: (i + 1) * 1000,
      source: "manual",
    }));
    linhas.push({
      organization_id: creds.org_id,
      pipeline_id: pipelineId,
      stage_id: etapaDestinoId,
      title: TITULO_ANCORADO,
      position_in_stage: 5000,
      source: "manual",
    });
    const { error: erroLeads } = await admin.from("crm_leads").insert(linhas);
    if (erroLeads) throw new Error(`leads: ${erroLeads.message}`);
  });

  test.afterAll(async () => {
    await limparFixtures();
  });

  test("cada card tem caixa, e ela é achável — não é folclore de modificador", async ({
    page,
  }) => {
    const errosDeConsole: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errosDeConsole.push(m.text());
    });

    await login(page, creds.users.manager!.email, creds.password);
    await page.goto(`/app/pipelines/${pipelineId}`);
    await expect(page.getByText(TITULO(1), { exact: true })).toBeVisible({ timeout: 30_000 });

    // Uma caixa por card do nosso funil — contagem, não impressão.
    for (let i = 1; i <= QUANTOS; i++) {
      await expect(caixaDoCard(page, TITULO(i))).toHaveCount(1);
    }

    // ⚠️ A caixa nasce `opacity-0` (o card tem orçamento fixo de largura e uma
    // caixa que empurra o título faria o quadro tremer no hover). "Existe no
    // DOM" seria verde com a caixa INALCANÇÁVEL — quem responde é a opacidade
    // computada, antes e durante o hover.
    const primeira = caixaDoCard(page, TITULO(1));
    const opacidadeEmRepouso = await primeira.evaluate((el) =>
      Number(getComputedStyle(el).opacity),
    );
    await page.getByText(TITULO(1), { exact: true }).hover();
    await page.waitForTimeout(300);
    const opacidadeNoHover = await primeira.evaluate((el) => Number(getComputedStyle(el).opacity));
    expect(
      opacidadeNoHover,
      `caixa invisível mesmo com o mouse em cima (repouso ${opacidadeEmRepouso}, hover ${opacidadeNoHover})`,
    ).toBeGreaterThan(0.9);

    await captura(page, "01-quadro-com-caixas");

    const inesperados = errosDeConsole.filter(
      (e) => !/favicon|ResizeObserver|Download the React DevTools/i.test(e),
    );
    expect(inesperados, `erros de console: ${inesperados.join(" | ")}`).toEqual([]);
  });

  test("a caixa da etapa tem o terceiro estado: indeterminado quando é parcial", async ({
    page,
  }) => {
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto(`/app/pipelines/${pipelineId}`);
    await expect(page.getByText(TITULO(1), { exact: true })).toBeVisible({ timeout: 30_000 });

    const caixaDaEtapa = page.getByRole("checkbox", { name: /(Selecionar|Desmarcar) todos em Origem/ });
    await expect(caixaDaEtapa).toHaveCount(1);

    // NADA marcado: nem `checked`, nem `indeterminate`.
    expect(await caixaDaEtapa.evaluate((el) => (el as HTMLInputElement).indeterminate)).toBe(false);
    expect(await caixaDaEtapa.isChecked()).toBe(false);

    // UM marcado → PARCIAL. `indeterminate` é propriedade do elemento, não
    // atributo: só o DOM vivo responde.
    await caixaDoCard(page, TITULO(1)).click();
    await expect(caixaDoCard(page, TITULO(1))).toBeChecked();
    expect(
      await caixaDaEtapa.evaluate((el) => (el as HTMLInputElement).indeterminate),
      "seleção parcial precisa ser visualmente diferente de nenhuma e de todas",
    ).toBe(true);
    expect(await caixaDaEtapa.isChecked()).toBe(false);
    await captura(page, "02-etapa-indeterminada");

    // TODOS pela caixa da etapa → `checked`, e o indeterminado sai.
    await caixaDaEtapa.click();
    await expect(caixaDaEtapa).toBeChecked();
    expect(await caixaDaEtapa.evaluate((el) => (el as HTMLInputElement).indeterminate)).toBe(false);
    expect((await marcados(page)).length, "a etapa inteira, de uma vez").toBe(QUANTOS);
    await captura(page, "03-etapa-inteira");

    // E desmarca tudo pelo mesmo controle — não é de mão única.
    await caixaDaEtapa.click();
    expect((await marcados(page)).length).toBe(0);
    expect(await caixaDaEtapa.evaluate((el) => (el as HTMLInputElement).indeterminate)).toBe(false);
  });

  test("shift+clique seleciona a FAIXA visível; ctrl+clique marca um a um sem abrir o dossiê", async ({
    page,
  }) => {
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto(`/app/pipelines/${pipelineId}`);
    await expect(page.getByText(TITULO(1), { exact: true })).toBeVisible({ timeout: 30_000 });

    // Âncora no 2º card, shift+clique no 5º → a faixa 2..5, e SÓ ela.
    await caixaDoCard(page, TITULO(2)).click();
    await page.getByText(TITULO(5), { exact: true }).click({ modifiers: ["Shift"] });

    const faixa = await marcados(page);
    expect(faixa, "a faixa é o que está ENTRE os dois na tela, inclusive").toEqual([
      TITULO(2),
      TITULO(3),
      TITULO(4),
      TITULO(5),
    ]);
    await captura(page, "04-faixa-do-shift");

    // Shift+clique NÃO abre o dossiê — o gesto de selecionar não é o de abrir.
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // ctrl+clique acrescenta UM, sem tocar na faixa e sem abrir nada.
    await page.getByText(TITULO(8), { exact: true }).click({ modifiers: ["ControlOrMeta"] });
    expect(await marcados(page)).toEqual([
      TITULO(2),
      TITULO(3),
      TITULO(4),
      TITULO(5),
      TITULO(8),
    ]);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // ctrl+clique de novo no mesmo card TIRA — alternar, não empilhar.
    await page.getByText(TITULO(8), { exact: true }).click({ modifiers: ["ControlOrMeta"] });
    expect(await marcados(page)).toEqual([TITULO(2), TITULO(3), TITULO(4), TITULO(5)]);
  });

  test('a contagem "n/total" da etapa e a da barra batem com o que está marcado', async ({
    page,
  }) => {
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto(`/app/pipelines/${pipelineId}`);
    await expect(page.getByText(TITULO(1), { exact: true })).toBeVisible({ timeout: 30_000 });

    const colunaOrigem = coluna(page, etapaOrigemId);
    // Sem seleção: o crachá mostra só o total.
    await expect(colunaOrigem.getByText(String(QUANTOS), { exact: true }).first()).toBeVisible();

    await caixaDoCard(page, TITULO(1)).click();
    await page.getByText(TITULO(4), { exact: true }).click({ modifiers: ["Shift"] });

    const quantosMarcados = (await marcados(page)).length;
    expect(quantosMarcados).toBe(4);

    // O crachá da etapa: "4/9", e não um número que ninguém conferiu.
    await expect(
      colunaOrigem.getByText(`${quantosMarcados}/${QUANTOS}`, { exact: true }),
      "a contagem da etapa precisa bater com as caixas realmente marcadas",
    ).toBeVisible();

    // A barra de ações traz a MESMA conta, e é ela que o usuário lê antes de agir.
    const barra = page.locator("[data-lote-selecionados]");
    await expect(barra).toBeVisible();
    expect(await barra.getAttribute("data-lote-selecionados")).toBe(String(quantosMarcados));
    await expect(barra.getByText(new RegExp(`${quantosMarcados} selecionados`))).toBeVisible();
    await captura(page, "05-contagem-e-barra");

    // A barra não pode transbordar a página — ela é `sticky` e centralizada, e
    // um excesso ficaria invisível dos DOIS lados em vez de cortado.
    const transbordo = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(transbordo, "a página não rola na horizontal com a barra aberta").toBeLessThanOrEqual(0);
  });

  test("mover vários de uma vez: os cards vão para a etapa nova, no fim e na mesma ordem", async ({
    page,
  }) => {
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto(`/app/pipelines/${pipelineId}`);
    await expect(page.getByText(TITULO(1), { exact: true })).toBeVisible({ timeout: 30_000 });

    expect(await ordemNoBanco(etapaDestinoId), "fixture: o destino começa com um card").toEqual([
      TITULO_ANCORADO,
    ]);

    // Três cards, escolhidos pela faixa — 3, 4 e 5.
    await caixaDoCard(page, TITULO(3)).click();
    await page.getByText(TITULO(5), { exact: true }).click({ modifiers: ["Shift"] });
    expect(await marcados(page)).toEqual([TITULO(3), TITULO(4), TITULO(5)]);

    const resposta = page.waitForResponse(
      (r) => r.url().includes("/api/v1/leads/bulk") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: /mover para/i }).click();
    await page.getByRole("menuitem", { name: "Destino", exact: true }).click();
    const r = await resposta;
    expect(r.status(), "manager pode mover em lote").toBe(200);

    // ── A PROVA É DEPOIS DO RELOAD. Toast não é persistência. ──────────────
    await page.reload();
    await expect(page.getByText(TITULO(1), { exact: true })).toBeVisible({ timeout: 30_000 });

    const noBanco = await ordemNoBanco(etapaDestinoId);
    expect(noBanco, "os três entraram no FIM do destino, na ordem em que estavam").toEqual([
      TITULO_ANCORADO,
      TITULO(3),
      TITULO(4),
      TITULO(5),
    ]);

    // E o quadro DESENHA a mesma ordem — banco e tela não podem divergir.
    expect(await ordemNaEtapa(page, etapaDestinoId)).toEqual([
      TITULO_ANCORADO,
      TITULO(3),
      TITULO(4),
      TITULO(5),
    ]);
    expect(await ordemNaEtapa(page, etapaOrigemId)).toEqual([
      TITULO(1),
      TITULO(2),
      TITULO(6),
      TITULO(7),
      TITULO(8),
      TITULO(9),
    ]);

    // Posições DISTINTAS: é o que impede o `midpoint()` do arrasto seguinte de
    // virar NaN — o defeito que a migration 0209 existe para consertar.
    const { data } = await admin
      .from("crm_leads")
      .select("position_in_stage")
      .eq("stage_id", etapaDestinoId);
    const posicoes = ((data ?? []) as { position_in_stage: number }[]).map(
      (l) => l.position_in_stage,
    );
    expect(new Set(posicoes).size, "nenhum card empatou de posição no destino").toBe(
      posicoes.length,
    );

    // A seleção some depois de agir: barra pendurada sobre um lote que já foi é
    // convite a repetir a ação.
    await expect(page.locator("[data-lote-selecionados]")).toHaveCount(0);
    await captura(page, "06-depois-de-mover");
  });

  test("quem não pode reatribuir não vê o controle: agent não recebe 'Responsável…'", async ({
    page,
  }) => {
    await login(page, creds.users.agent!.email, creds.password);
    await page.goto(`/app/pipelines/${pipelineId}`);
    await expect(page.getByText(TITULO(1), { exact: true })).toBeVisible({ timeout: 30_000 });

    await caixaDoCard(page, TITULO(1)).click();
    const barra = page.locator("[data-lote-selecionados]");
    await expect(barra).toBeVisible();

    // `agent` PODE mover/etiquetar/excluir (piso da rota é agent+) e NÃO pode
    // reatribuir dono (piso manager+). O controle que ele não pode usar não é
    // oferecido — controle decorativo é pior que controle ausente, porque um
    // 403 na cara lê como "o sistema falhou".
    await expect(
      barra.getByRole("button", { name: /respons[áa]vel/i }),
      "atribuir em lote é ≥manager, e o botão não pode aparecer para agent",
    ).toHaveCount(0);
    await expect(barra.getByRole("button", { name: /mover para/i })).toBeVisible();
    await captura(page, "07-agent-sem-responsavel");

    // E o mesmo controle EXISTE para quem pode — senão o zero acima seria
    // verde por o seletor estar errado, não por a permissão funcionar.
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto(`/app/pipelines/${pipelineId}`);
    await expect(page.getByText(TITULO(1), { exact: true })).toBeVisible({ timeout: 30_000 });
    await caixaDoCard(page, TITULO(1)).click();
    await expect(
      page.locator("[data-lote-selecionados]").getByRole("button", { name: /respons[áa]vel/i }),
      "controle positivo: para manager o botão existe",
    ).toBeVisible();
  });
});
