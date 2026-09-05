/**
 * RELATÓRIO DE ATIVIDADES — a tela nova, provada como um gestor a usaria.
 *
 * O motor (`fn_activity_report`, migration 0217) já tem invariante contra
 * Postgres real. O que nunca tinha sido feito é o que este spec faz: abrir a
 * tela pela BARRA LATERAL, ler os números, trocar o período e conferir que a
 * troca chegou ao servidor, e sair de uma linha do relatório para o negócio de
 * onde ela veio.
 *
 * ─── O que a tela precisa responder, e como se mede ────────────────────────
 *  · A PORTA existe: item "Atividades" no grupo Análise, e clicar nele leva à
 *    tela — não basta a rota responder a quem digita a URL.
 *  · Os TRÊS NÚMEROS (equipe / agentes / automático) somam o total. É a
 *    afirmação central da tela: um mês atendido pela IA e um mês atendido pela
 *    equipe têm o mesmo desfecho no funil e histórias opostas.
 *  · O FILTRO DE PERÍODO alcança o servidor. Um `<select>` que muda o rótulo e
 *    não muda a consulta é controle decorativo — e ele seria indistinguível de
 *    um que funciona se o spec só olhasse o texto do seletor. A prova é a série
 *    diária: 7 dias desenha 8 barras, 30 dias desenha 31, e as atividades de 20
 *    dias atrás só entram na conta do período maior.
 *  · Cada linha LEVA ao negócio. Relatório que só lista é decorativo.
 *
 * ─── ⚠️ O que este spec NÃO afirma, e por quê ──────────────────────────────
 * Que o item novo CABE na barra lateral. Não cabia: medido em 1280×900, logado
 * como admin, `nav.scrollHeight` = 776 contra `clientHeight` = 763 — 13 px de
 * excesso, com "Audit Log" abaixo da dobra. Removendo do DOM só o `<a>` de
 * `/app/activities` a mesma medida devolvia 763 contra 763: a barra cabia com
 * margem NENHUMA e este item era o que a estourava.
 *
 * O conserto NÃO foi raspar densidade, e sim `/app/analise` — o hub do grupo,
 * pela mesma regra que o comentário de `Sidebar.tsx` já escrevia (grupo sem hub
 * que passa de quatro telas ganha um). Evolução da IA e Audit Log saíram do
 * menu para dentro dele; Atividades ficou, e sobrou 19px de folga. Quem guarda
 * o invariante da dobra continua sendo `navegacao.spec.ts` ("nenhum grupo fica
 * fora da dobra, e em 900px o menu não rola") — duplicar a asserção aqui só
 * faria dois vermelhos para o mesmo fato.
 *
 * Pré-requisitos (banco local do baseline, app buildada):
 *   pnpm e2e:env && pnpm e2e:build
 *   pnpm exec playwright test tests/e2e/relatorio-de-atividades.spec.ts
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA =
  process.env.E2E_EVIDENCIA ?? path.join(process.cwd(), ".superpowers/evidence/relatorio-atividades");

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
const NOME_DO_FUNIL = `Relatorio E2E ${SUFIXO}`;
const NEGOCIO_RECENTE = `Relatorio ${SUFIXO} recente`;
const NEGOCIO_ANTIGO = `Relatorio ${SUFIXO} antigo`;

/** Dentro dos 7 dias: 3 da equipe, 2 de agente, 1 automática. */
const RECENTES = { pessoas: 3, agentes: 2, automatico: 1 };
/** 20 dias atrás: FORA dos 7 dias e DENTRO dos 30. É o que o filtro precisa ver. */
const ANTIGAS = 4;

let pipelineId = "";
let etapaId = "";
let leadRecenteId = "";
let leadAntigoId = "";

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

/** O total que a tela declara, lido do DOM (não recalculado pelo teste). */
async function totalNaTela(page: Page): Promise<number> {
  const texto = await page.getByTestId("total-de-atividades").innerText();
  return Number(texto.replace(/\D/g, ""));
}

/** Quantas barras a série diária desenhou, e a soma do que elas declaram. */
async function serie(page: Page): Promise<{ barras: number; soma: number }> {
  return page.evaluate(() => {
    const barras = [...document.querySelectorAll("[data-dia]")];
    return {
      barras: barras.length,
      soma: barras.reduce((s, b) => s + Number(b.getAttribute("data-quantidade") ?? 0), 0),
    };
  });
}

/**
 * Troca o período e ESPERA O RESULTADO, não a rede.
 *
 * ⚠️ Esperar por `waitForResponse` aqui parece o certo e é armadilha: o
 * `useActivityReport` tem `staleTime: 30_000`, então voltar a um período já
 * visitado dentro da janela é servido do cache e NÃO gera requisição nenhuma.
 * Medido: o `escolherPeriodo(7)` do fim deste spec estourava 30 s esperando uma
 * resposta que nunca ia existir — um vermelho que acusaria o produto por um
 * acerto dele. Quem diz que a troca terminou é a série redesenhada.
 *
 * Que a consulta muda DE VERDADE é provado separadamente, pelas URLs que o teste
 * captura (`days=` pedidos) — cache não apaga o primeiro pedido de cada janela.
 */
async function escolherPeriodo(page: Page, dias: number, barrasEsperadas: number): Promise<void> {
  await page.getByRole("combobox", { name: "Período" }).click();
  await page.getByRole("option", { name: `Últimos ${dias} dias` }).click();
  await expect
    .poll(async () => (await serie(page)).barras, { timeout: 30_000 })
    .toBe(barrasEsperadas);
}

async function criarLead(titulo: string): Promise<string> {
  const { data, error } = await admin
    .from("crm_leads")
    .insert({
      organization_id: creds.org_id,
      pipeline_id: pipelineId,
      stage_id: etapaId,
      title: titulo,
      position_in_stage: 1000,
      source: "manual",
    })
    .select("id")
    .single();
  if (error) throw new Error(`lead ${titulo}: ${error.message}`);
  return (data as { id: string }).id;
}

interface AtividadeSeed {
  leadId: string;
  tipo: string;
  actorKind: string;
  userId?: string | null;
  diasAtras: number;
  quantas: number;
}

async function semearAtividades(a: AtividadeSeed): Promise<void> {
  const linhas = Array.from({ length: a.quantas }, (_, i) => ({
    organization_id: creds.org_id,
    lead_id: a.leadId,
    source_module: "e2e",
    type: a.tipo,
    actor_kind: a.actorKind,
    performed_by_user_id: a.userId ?? null,
    // Meio-dia: um horário que não escorrega de dia por causa do fuso do
    // navegador que lê a tela (a série é agrupada no fuso do leitor).
    performed_at: new Date(
      Date.now() - a.diasAtras * 86_400_000 + i * 60_000,
    ).toISOString(),
    reason: `${SUFIXO} ${a.diasAtras}d #${i + 1}`,
    // `crm_lead_activities_ai_needs_evidence`: atividade de IA sem run/trace/
    // llm_call é recusada pelo banco. É a regra que impede o produto de afirmar
    // "a IA fez isto" sem ter o que mostrar — a fixture obedece em vez de
    // contornar.
    ...(a.actorKind === "ai" ? { evidence: { run_ids: [randomUUID()] } } : {}),
  }));
  const { error } = await admin.from("crm_lead_activities").insert(linhas);
  if (error) throw new Error(`atividades (${a.tipo}): ${error.message}`);
}

async function limparFixtures(): Promise<void> {
  const { data } = await admin
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", creds.org_id)
    .like("name", "Relatorio E2E %");
  const ids = ((data ?? []) as { id: string }[]).map((p) => p.id);
  if (ids.length === 0) return;
  await admin.from("crm_lead_activities").delete().in("pipeline_id", ids);
  await admin.from("crm_leads").delete().in("pipeline_id", ids);
  await admin.from("crm_stages").delete().in("pipeline_id", ids);
  await admin.from("crm_pipelines").delete().in("id", ids);
}

test.describe("Relatório de atividades — o período, pela tela", () => {
  test.describe.configure({ timeout: 240_000 });
  // Fuso FIXO: a série diária é agrupada no fuso de quem lê, e um spec que
  // herdasse o fuso da máquina mediria coisas diferentes em máquinas diferentes.
  test.use({ timezoneId: "America/Sao_Paulo" });

  test.beforeAll(async () => {
    if (!fs.existsSync(CREDS_PATH)) {
      execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
    }
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    await limparFixtures();

    const { data: funil, error: erroFunil } = await admin
      .from("crm_pipelines")
      .insert({
        organization_id: creds.org_id,
        name: NOME_DO_FUNIL,
        slug: `relatorio-e2e-${SUFIXO}`,
      })
      .select("id")
      .single();
    if (erroFunil) throw new Error(`funil: ${erroFunil.message}`);
    pipelineId = (funil as { id: string }).id;

    const { data: etapa, error: erroEtapa } = await admin
      .from("crm_stages")
      .insert({
        organization_id: creds.org_id,
        pipeline_id: pipelineId,
        name: "Etapa",
        slug: `etapa-${SUFIXO}`,
        position: 1000,
      })
      .select("id")
      .single();
    if (erroEtapa) throw new Error(`etapa: ${erroEtapa.message}`);
    etapaId = (etapa as { id: string }).id;

    leadRecenteId = await criarLead(NEGOCIO_RECENTE);
    leadAntigoId = await criarLead(NEGOCIO_ANTIGO);

    const manager = creds.users.manager!.id;
    await semearAtividades({
      leadId: leadRecenteId,
      tipo: "note",
      actorKind: "user",
      userId: manager,
      diasAtras: 1,
      quantas: RECENTES.pessoas,
    });
    await semearAtividades({
      leadId: leadRecenteId,
      tipo: "ai_turn",
      actorKind: "ai",
      diasAtras: 2,
      quantas: RECENTES.agentes,
    });
    await semearAtividades({
      leadId: leadRecenteId,
      tipo: "stage_changed",
      actorKind: "system",
      diasAtras: 3,
      quantas: RECENTES.automatico,
    });
    await semearAtividades({
      leadId: leadAntigoId,
      tipo: "note",
      actorKind: "user",
      userId: manager,
      diasAtras: 20,
      quantas: ANTIGAS,
    });
  });

  test.afterAll(async () => {
    await limparFixtures();
  });

  test("a porta existe na barra lateral, no grupo Análise, e leva à tela", async ({ page }) => {
    const errosDeConsole: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errosDeConsole.push(m.text());
    });

    await login(page, creds.users.manager!.email, creds.password);

    const sidebar = page.getByRole("navigation", { name: "Navegação principal" });
    const item = sidebar.getByRole("link", { name: "Atividades", exact: true });
    await expect(item, "tela sem porta é tela que só existe para quem digita a URL").toBeVisible({
      timeout: 30_000,
    });
    expect(await item.getAttribute("href")).toBe("/app/activities");

    // O grupo importa: "Atividades" é irmã de Desempenho e Audit Log, não de
    // Inbox. Ir parar no grupo errado é a diferença entre achar e caçar.
    const grupo = await item.evaluate((a) => {
      let el: Element | null = a;
      while (el && el.previousElementSibling === null) el = el.parentElement;
      // sobe até achar o cabeçalho de grupo mais próximo acima
      const titulos = [...document.querySelectorAll('nav[aria-label="Navegação principal"] h2')];
      const y = a.getBoundingClientRect().top;
      const acima = titulos.filter((h) => h.getBoundingClientRect().top < y);
      return (acima[acima.length - 1]?.textContent ?? "").trim();
    });
    expect(grupo, "Atividades pertence ao grupo Análise").toMatch(/an[áa]lise/i);

    await item.click();
    await page.waitForURL(/\/app\/activities/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Atividades", level: 1 })).toBeVisible();
    await captura(page, "01-tela-de-atividades");

    // Sem transbordo horizontal, sem erro de console novo.
    const transbordo = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(transbordo, "a tela não rola na horizontal").toBeLessThanOrEqual(0);
    const inesperados = errosDeConsole.filter(
      (e) => !/favicon|ResizeObserver|Download the React DevTools/i.test(e),
    );
    expect(inesperados, `erros de console: ${inesperados.join(" | ")}`).toEqual([]);
  });

  test("os três números somam o total, e a série diária conta a mesma história", async ({
    page,
  }) => {
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto("/app/activities");
    await expect(page.getByTestId("total-de-atividades")).toBeVisible({ timeout: 30_000 });

    const total = await totalNaTela(page);
    expect(total, "as 6 atividades recentes da fixture têm de estar aí dentro").toBeGreaterThanOrEqual(
      RECENTES.pessoas + RECENTES.agentes + RECENTES.automatico,
    );

    // A afirmação central da tela: equipe + agentes + automático = tudo. Se
    // esses três números não fecham, a resposta que a tela dá está errada, por
    // mais bonito que o gráfico esteja.
    const numeroDoCartao = async (forma: string): Promise<number> => {
      const texto = await page.getByTestId(`origem-${forma}`).innerText();
      // "A equipe\n7\n70%" → o primeiro número inteiro isolado.
      const m = texto.match(/^\s*[^\d]*?(\d+)\s*$/m);
      return Number(m?.[1] ?? NaN);
    };
    const equipe = await numeroDoCartao("filled");
    const agentes = await numeroDoCartao("ring");
    const automatico = await numeroDoCartao("dashed");
    expect(equipe + agentes + automatico, "os três cartões precisam somar o total").toBe(total);
    expect(agentes, "as 2 atividades de agente da fixture estão contadas").toBeGreaterThanOrEqual(
      RECENTES.agentes,
    );

    // A série diária é a MESMA conta em outra forma — divergir seria a tela
    // dizendo dois totais diferentes na mesma dobra.
    const s = await serie(page);
    expect(s.barras, "7 dias desenham 8 barras (a janela é inclusiva nas pontas)").toBe(8);
    expect(s.soma, "a soma das barras é o total do período").toBe(total);

    // Os rankings e a lista existem e não estão vazios.
    await expect(page.getByTestId("ranking-de-atores").locator("> div")).not.toHaveCount(0);
    await expect(page.getByTestId("ranking-de-tipos").locator("> div")).not.toHaveCount(0);
    await expect(page.getByTestId("lista-de-atividades").locator("li")).not.toHaveCount(0);
    await captura(page, "02-numeros-e-serie");
  });

  test("trocar o período muda a CONSULTA, não só o rótulo do seletor", async ({ page }) => {
    // As janelas que o cliente REALMENTE pediu ao servidor. É isto que separa um
    // seletor vivo de um decorativo: o rótulo mudar não prova nada.
    const janelasPedidas = new Set<string>();
    page.on("request", (r) => {
      const m = r.url().match(/\/api\/v1\/reports\/activities\?days=(\d+)/);
      if (m) janelasPedidas.add(m[1]!);
    });

    await login(page, creds.users.manager!.email, creds.password);
    await page.goto("/app/activities");
    await expect(page.getByTestId("total-de-atividades")).toBeVisible({ timeout: 30_000 });

    const totalEm7 = await totalNaTela(page);
    const serieEm7 = await serie(page);
    expect(serieEm7.barras).toBe(8);

    // As três janelas que o produto oferece — nem mais, nem menos.
    await page.getByRole("combobox", { name: "Período" }).click();
    await expect(page.getByRole("option")).toHaveCount(3);
    await page.keyboard.press("Escape");

    await escolherPeriodo(page, 30, 31);
    const totalEm30 = await totalNaTela(page);
    const serieEm30 = await serie(page);

    expect(serieEm30.barras, "30 dias desenham 31 barras").toBe(31);
    expect(serieEm30.soma, "a série continua somando o total do período").toBe(totalEm30);
    // A PROVA de que a janela chegou ao servidor: as 4 atividades de 20 dias
    // atrás entram só aqui. Um seletor decorativo devolveria o mesmo total.
    expect(
      totalEm30 - totalEm7,
      "as atividades de 20 dias atrás só existem no período maior",
    ).toBeGreaterThanOrEqual(ANTIGAS);
    await captura(page, "03-periodo-30-dias");

    await escolherPeriodo(page, 90, 91);
    expect(await totalNaTela(page)).toBeGreaterThanOrEqual(totalEm30);

    // E volta: o controle não é de mão única.
    await escolherPeriodo(page, 7, 8);
    expect(await totalNaTela(page)).toBe(totalEm7);

    // A prova de que a janela viajou: as três foram pedidas ao servidor.
    expect(
      [...janelasPedidas].sort(),
      "cada período escolhido virou uma consulta com a janela dele",
    ).toEqual(["30", "7", "90"]);
  });

  test("da linha do relatório se chega ao negócio — a lista não é decorativa", async ({ page }) => {
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto("/app/activities");
    await expect(page.getByTestId("total-de-atividades")).toBeVisible({ timeout: 30_000 });

    const lista = page.getByTestId("lista-de-atividades");
    const atalho = lista.getByRole("link", { name: NEGOCIO_RECENTE }).first();
    await expect(atalho, "cada linha aponta para o negócio de onde veio").toBeVisible();
    expect(await atalho.getAttribute("href")).toBe(`/app/leads/${leadRecenteId}`);

    await atalho.click();
    await page.waitForURL(new RegExp(`/app/leads/${leadRecenteId}`), { timeout: 30_000 });
    await expect(page.getByText(NEGOCIO_RECENTE).first()).toBeVisible({ timeout: 30_000 });
    await captura(page, "04-atalho-para-o-negocio");
  });

  test("o piso é viewer: quem só lê também vê o relatório da própria organização", async ({
    page,
  }) => {
    await login(page, creds.users.viewer!.email, creds.password);

    // A porta aparece para viewer — o item não declara `minRole`, e o piso da
    // rota é `viewer` de propósito: um piso mais alto esconderia da pessoa as
    // atividades dela mesma.
    const sidebar = page.getByRole("navigation", { name: "Navegação principal" });
    await expect(sidebar.getByRole("link", { name: "Atividades", exact: true })).toBeVisible({
      timeout: 30_000,
    });

    await page.goto("/app/activities");
    await expect(page.getByRole("heading", { name: "Atividades", level: 1 })).toBeVisible({
      timeout: 30_000,
    });
    // Não é uma casca: o relatório carregou de verdade para ele.
    await expect(page.getByTestId("total-de-atividades")).toBeVisible({ timeout: 30_000 });
    expect(await totalNaTela(page)).toBeGreaterThanOrEqual(
      RECENTES.pessoas + RECENTES.agentes + RECENTES.automatico,
    );
    await expect(page.getByText(/erro ao carregar/i)).toHaveCount(0);
    await captura(page, "05-viewer-le-o-relatorio");
  });
});
