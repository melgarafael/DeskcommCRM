/**
 * ACOMPANHAR A IA PELO CELULAR (ADR-0006, fase F4) — medido por geometria.
 *
 * O gestor, com o celular na mão, precisa pausar um agente, abrir o aviso da
 * Central, ver as execuções e a fila de follow-up, e mexer no construtor de
 * fluxo. O que esta spec mede, a 390px com toque emulado:
 *
 * 1. Agentes: o ⋯ do cartão tem 44px (o `size-8` sem prefixo o deixava em 32).
 * 2. Tela do agente: o seletor de operação ocupa a linha e não empurra a tela
 *    para o lado; «Pausar automático» fica na tela e pausa de verdade.
 * 3. Execuções: a tabela vira cartão. A tabela base embrulha tudo num
 *    `overflow-auto`, então "o <main> não transborda" NÃO prova o cartão — cada
 *    cartão tem a sua asserção: cabeçalho `display:none`, a caixa da tabela sem
 *    rolagem lateral, «Detalhes» dentro da tela e o rótulo do custo escrito.
 *    As execuções são semeadas em `llm_calls` (com `agent_id`), que é o que a
 *    rota `GET /api/v1/ai/agents/:id/runs` lê — NÃO em `ai_agent_runs`, que a
 *    aba deixou de ler (ver o cabeçalho da rota).
 * 4. Central de avisos: o link do destino tem 44px de altura.
 * 5. O que o agente sabe: com um material, os dois botões cabem na tela.
 * 6. Fila de follow-up: o cartão cabe e «Cancelar» fica na tela.
 * 7. Construtor: tocar num passo abre o painel ACIMA da barra de abas, e os
 *    botões de zoom têm 44px (a folha da lib declara 26px).
 * 8. Caso: «Ver conversa» pega o dedo até 21px acima e abaixo do centro, e não
 *    a 24px (controle).
 *
 * As alças de ligação do construtor NÃO ganharam área maior, e por isso não há
 * caso para elas: ficam dentro do viewport com zoom (44px de CSS viram 22px a
 * 50%), e uma área para fora do nó cobriria o vão entre dois passos, onde passa
 * a aresta que o toque seleciona. Está no comentário de `app/globals.css`.
 *
 * Organização PRÓPRIA (admin), semeada pelo service role e apagada no fim: as
 * specs da parte 7 dividem o banco, e esta não toca o agente padrão de ninguém.
 * Nada aqui depende de WAHA: a sessão de canal existe só porque a versão do
 * agente exige uma.
 *
 * ⚠️ EMULAÇÃO, DECLARADA: Chromium de computador com `isMobile` + `hasTouch`.
 * Prova a regra da tela, não o Safari do iPhone.
 *
 * Um login, num caso só: ver `e2e-dois-logins-nao-cabem-no-teto-padrao`.
 * Parte 7 do CI. Tempo PREVISTO (não medido): uns 90s no job.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { test, expect, type Locator, type Page } from "./helpers/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, {
  auth: { persistSession: false },
});

const EVIDENCIA = path.join(process.cwd(), "evidence", "ia-no-celular-20261023");
/** O piso de alvo de toque, o mesmo de `celular-cabe-na-tela.spec.ts`. */
const PISO_DE_TOQUE = 44;
/** O <main> tem 16px de respiro de cada lado a 390px. */
const BORDA_DIREITA = 390 - 16;

const senha = `Local-${randomUUID()}!`;
const NOME_DO_AGENTE = `Agente celular ${randomUUID().slice(0, 8)}`;
const NOME_DO_CONTATO = "Cliente da fila no celular";

const semente = { usuario: "", email: "", org: "", agente: "", ponteiro: "", caso: "" };
/** Quantas linhas cada tabela recebeu: a limpeza cobra que todas saiam. */
const semeadas: Record<string, number> = {};

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: "pt-BR" });
test.describe.configure({ timeout: 240_000 });

async function insere(tabela: string, valores: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(tabela).insert(valores).select("id").single();
  if (error) throw new Error(`${tabela}: ${error.message}`);
  semeadas[tabela] = (semeadas[tabela] ?? 0) + 1;
  return (data as { id: string }).id;
}

async function medir(alvo: Locator) {
  await alvo.scrollIntoViewIfNeeded();
  return alvo.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  });
}

async function rolagemDoMain(page: Page): Promise<number> {
  return page.locator("main").evaluate((m) => m.scrollWidth - m.clientWidth);
}

/** Cada cartão com a SUA prova: o `<main>` não enxerga a rolagem da caixa da tabela. */
async function provaOCartao(tabela: Locator, rotulo: string) {
  expect(await tabela.locator("thead").evaluate((el) => getComputedStyle(el).display), `${rotulo}: cabeçalho`).toBe(
    "none",
  );
  const rolagem = await tabela.evaluate((t) => t.parentElement!.scrollWidth - t.parentElement!.clientWidth);
  expect(rolagem, `${rolagem}px: a caixa da tabela de ${rotulo} rola para o lado`).toBeLessThanOrEqual(1);
}

async function semear() {
  const email = `ia-no-celular-${randomUUID()}@invariant.test`;
  const criado = await db.auth.admin.createUser({ email, password: senha, email_confirm: true });
  if (criado.error || !criado.data.user) throw criado.error ?? new Error("sem usuário");
  semente.usuario = criado.data.user.id;
  semente.email = email;

  const org = await insere("organizations", {
    slug: `ia-no-celular-${randomUUID()}`,
    legal_name: "IA no celular",
    display_name: "IA no celular",
    onboarded_at: new Date().toISOString(),
  });
  semente.org = org;
  await insere("user_organizations", {
    organization_id: org,
    user_id: semente.usuario,
    role: "admin",
    accepted_at: new Date().toISOString(),
  });

  const sessao = await insere("channel_sessions", {
    organization_id: org,
    waha_session_name: `e2e-ia-no-celular-${randomUUID()}`,
    webhook_secret_encrypted: "e2e",
  });
  const agente = await insere("ai_agents", {
    organization_id: org,
    name: NOME_DO_AGENTE,
    kind: "mcp_agent",
    system_prompt: "Atenda com objetividade.",
    model: "claude-sonnet-4-6",
  });
  semente.agente = agente;
  const versao = await insere("ai_agent_versions", {
    organization_id: org,
    agent_id: agente,
    version_number: 1,
    system_prompt: "Atenda com objetividade.",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    channel_session_id: sessao,
    status: "published",
    published_at: new Date().toISOString(),
  });
  // Publicada: é o que habilita «Pausar automático».
  const ponteiro = await db.from("ai_agents").update({ published_version_id: versao }).eq("id", agente);
  if (ponteiro.error) throw new Error(`published_version_id: ${ponteiro.error.message}`);

  // A aba Execuções lê `llm_calls` filtrada por `agent_id` (a rota mudou de
  // tabela; `ai_agent_runs` não tem escritor no motor de produção).
  for (const [i, custo] of [1234, 87].entries()) {
    await insere("llm_calls", {
      organization_id: org,
      agent_id: agente,
      purpose: "agent_turn",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      status: "ok",
      input_tokens: 1200,
      output_tokens: 340,
      cost_cents: custo,
      latency_ms: 2380,
      created_at: new Date(Date.now() - (i + 1) * 60_000).toISOString(),
    });
  }

  // Sem referência: o destino é geral («Abrir evolução do assistente», gestor).
  await insere("agent_inbox_items", {
    organization_id: org,
    kind: "promotion_review",
    severity: "info",
    title: "Há propostas novas para o assistente",
  });

  await insere("ai_knowledge_sources", {
    organization_id: org,
    agent_id: agente,
    source_type: "faq",
    name: "Perguntas frequentes",
    status: "ready",
  });

  // Uma promessa agendada (`cron_jobs`, o mesmo formato de `seed-e2e-followup-promise`):
  // daqui a 3 dias, então nenhum relógio a dispara durante a spec.
  const contato = await insere("contacts", { organization_id: org, display_name: NOME_DO_CONTATO });

  // Um caso aberto, com a conversa que «Ver conversa» abre (o mesmo formato de
  // `conversa-do-caso.spec.ts`).
  const conversa = await insere("conversations", {
    organization_id: org,
    contact_id: contato,
    channel_session_id: sessao,
    status: "ai_handling",
    assignee_kind: "ai",
    last_inbound_at: new Date().toISOString(),
  });
  semente.caso = await insere("agent_cases", {
    organization_id: org,
    conversation_id: conversa,
    status: "awaiting_human",
    title: "Caso do celular",
    summary: "Cliente quer trocar o tamanho do pedido.",
    blocker: "precisa de alguém com alçada",
    source: "agent",
  });

  const daquiATresDias = new Date(Date.now() + 3 * 86_400_000).toISOString();
  await insere("cron_jobs", {
    organization_id: org,
    contact_id: contato,
    kind: "at",
    job_kind: "followup_turn",
    next_run_at: daquiATresDias,
    enabled: true,
    payload: {
      reason: "Cliente pediu para retornar depois do feriado com uma explicação bem comprida",
      promise: "Vamos avisar assim que o produto voltar ao estoque",
      promised_at: daquiATresDias,
      context_snapshot: null,
    },
  });

  const pos = (y: number) => ({ x: 0, y });
  semente.ponteiro = await insere("followup_flow_pointers", {
    organization_id: org,
    name: "Fluxo do celular",
    draft_graph: {
      nodes: [
        { id: "t1", type: "trigger", label: "Início", position: pos(0), config: {} },
        { id: "w1", type: "wait", label: "Espera", position: pos(120), config: { mode: "fixed", duration_ms: 300_000 } },
        { id: "end1", type: "end", label: "Fim", position: pos(240), config: { outcome: "exhausted" } },
      ],
      edges: [
        { id: "edge1", source: "t1", target: "w1", priority: 0, condition: { type: "always" } },
        { id: "edge2", source: "w1", target: "end1", priority: 0, condition: { type: "always" } },
      ],
    },
  });
}

test.beforeAll(semear);

/**
 * Filhos antes dos pais, à mão: `conversations` tem FK RESTRICT para `contacts` e
 * `channel_sessions`, e `ai_agent_versions` para `channel_sessions` — deixar
 * tudo para a cascata da organização é apostar na ordem em que o Postgres
 * dispara as cascatas. Cada passo confere o `error` E quantas linhas saíram; as
 * falhas se acumulam (um filho preso não impede de tentar o resto) e a limpeza
 * termina com `throw` se qualquer coisa ficou para trás.
 */
test.afterAll(async () => {
  const falhas: string[] = [];
  const passos: Array<[tabela: string, coluna: string, valor: string]> = [
    ["agent_cases", "organization_id", semente.org],
    ["conversations", "organization_id", semente.org],
    ["llm_calls", "organization_id", semente.org],
    // Leva as versões (CASCADE), que seguram `channel_sessions` por RESTRICT.
    ["ai_agents", "organization_id", semente.org],
    // O resto (contato, sessão, promessa, fluxo, material, aviso) sai em cascata.
    ["organizations", "id", semente.org],
  ];
  for (const [tabela, coluna, valor] of passos) {
    const esperadas = semeadas[tabela] ?? 0;
    if (!valor || esperadas === 0) continue;
    const { data, error } = await db.from(tabela).delete().eq(coluna, valor).select("id");
    if (error) falhas.push(`${tabela}: ${error.message}`);
    else if ((data?.length ?? 0) < esperadas) falhas.push(`${tabela}: saíram ${data?.length ?? 0} de ${esperadas}`);
  }
  if (semente.usuario) {
    const u = await db.auth.admin.deleteUser(semente.usuario);
    if (u.error) falhas.push(`usuário: ${u.error.message}`);
  }
  if (falhas.length > 0) throw new Error(`a limpeza deixou sobra no banco — ${falhas.join("; ")}`);
});

test("[P1] o gestor pausa o agente, abre o aviso e acompanha a IA pelo celular", async ({ page }) => {
  mkdirSync(EVIDENCIA, { recursive: true });
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(semente.email);
  await page.getByLabel(/senha/i).fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(?:\/|$)/, { timeout: 60_000 });
  // Sem toque emulado o `pointer-coarse:` não vale, e o caso mediria o mouse.
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);

  await test.step("1. agentes: o ⋯ tem 44px", async () => {
    await page.goto("/app/ai/agents");
    const cartao = page.locator("li").filter({ hasText: NOME_DO_AGENTE });
    const menu = cartao.getByRole("button", { name: "Menu de ações" });
    await expect(menu).toBeVisible({ timeout: 30_000 });
    const r = await medir(menu);
    expect(r.height, "altura do ⋯").toBeGreaterThanOrEqual(PISO_DE_TOQUE);
    expect(r.width, "largura do ⋯").toBeGreaterThanOrEqual(PISO_DE_TOQUE);
    expect(r.right).toBeLessThanOrEqual(BORDA_DIREITA);
    expect(await rolagemDoMain(page), "a lista de agentes rola para o lado").toBeLessThanOrEqual(1);
  });

  await test.step("2. tela do agente: o seletor cabe e «Pausar automático» pausa", async () => {
    await page.goto(`/app/ai/agents/${semente.agente}`);
    const operacao = page.getByRole("region", { name: "Operação do agente" });
    await expect(operacao).toBeVisible({ timeout: 30_000 });
    expect(
      await operacao.evaluate((el) => el.scrollWidth - el.clientWidth),
      "o seletor de operação empurra a caixa para o lado",
    ).toBeLessThanOrEqual(1);
    const seletor = operacao.getByRole("combobox", { name: "Modo de operação" });
    const s = await medir(seletor);
    expect(s.height, "altura do seletor").toBeGreaterThanOrEqual(PISO_DE_TOQUE);
    expect(s.right, "o seletor passa da borda").toBeLessThanOrEqual(BORDA_DIREITA);

    const pausar = operacao.getByRole("button", { name: "Pausar automático" });
    const p = await medir(pausar);
    // Sem asserção de altura aqui: o `size="sm"` já dá `h-11` abaixo de lg, com ou sem este PR.
    expect(p.right, "«Pausar automático» passa da borda").toBeLessThanOrEqual(BORDA_DIREITA);
    await page.screenshot({ path: path.join(EVIDENCIA, "01-operacao-do-agente.png") });
    await pausar.tap();
    await expect(operacao.getByRole("button", { name: "Retomar automático" })).toBeVisible({ timeout: 30_000 });
  });

  await test.step("3. execuções em cartão", async () => {
    await page.getByRole("tab", { name: "Execuções" }).tap();
    const painel = page.getByRole("tabpanel", { name: "Execuções" });
    const linhas = painel.locator("tbody tr");
    await expect(linhas).toHaveCount(2, { timeout: 30_000 });
    await provaOCartao(painel.locator("table"), "execuções");
    for (const linha of await linhas.all()) {
      const detalhes = await medir(linha.getByRole("button", { name: "Detalhes" }));
      // Só a borda: a altura vem do `size="sm"` (h-11) com ou sem o cartão.
      expect(detalhes.right, "«Detalhes» passa da borda").toBeLessThanOrEqual(BORDA_DIREITA);
    }
    // O cabeçalho sumiu: o rótulo do número vem do próprio cartão, pelo `::before`.
    const rotulos = await linhas
      .first()
      .locator("td[data-rotulo]")
      .evaluateAll((tds) =>
        tds.map((td) => ({ rotulo: td.getAttribute("data-rotulo"), content: getComputedStyle(td, "::before").content })),
      );
    expect(rotulos.map((r) => r.rotulo)).toEqual(["Custo", "Latência"]);
    for (const r of rotulos) expect(["none", "normal", ""], `${r.rotulo} sem rótulo desenhado`).not.toContain(r.content);
    expect(await rolagemDoMain(page), "a aba de execuções rola para o lado").toBeLessThanOrEqual(1);
    await page.screenshot({ path: path.join(EVIDENCIA, "02-execucoes-em-cartao.png") });
  });

  await test.step("4. Central de avisos: o destino tem 44px", async () => {
    await page.goto("/app/ai/inbox");
    const destino = page.getByRole("link", { name: "Abrir evolução do assistente" });
    await expect(destino).toBeVisible({ timeout: 30_000 });
    const r = await medir(destino);
    expect(r.height, "altura do link do destino").toBeGreaterThanOrEqual(PISO_DE_TOQUE);
    expect(r.right).toBeLessThanOrEqual(BORDA_DIREITA);
    expect(await rolagemDoMain(page), "a Central rola para o lado").toBeLessThanOrEqual(1);
  });

  await test.step("5. O que o agente sabe: os dois botões cabem", async () => {
    await page.goto("/app/ai/knowledge/sources");
    const adicionar = page.getByTestId("acervo-adicionar");
    await expect(page.getByTestId("acervo-reindexar-tudo")).toBeVisible({ timeout: 30_000 });
    for (const botao of [page.getByTestId("acervo-reindexar-tudo"), adicionar]) {
      const r = await medir(botao);
      expect(r.left).toBeGreaterThanOrEqual(15);
      expect(r.right, "botão do acervo passa da borda").toBeLessThanOrEqual(BORDA_DIREITA);
    }
    expect(await rolagemDoMain(page), "o acervo rola para o lado").toBeLessThanOrEqual(1);
  });

  await test.step("6. fila de follow-up em cartão", async () => {
    await page.goto("/app/ai/followups");
    await page.getByRole("tab", { name: "Fila" }).tap();
    const linha = page.getByTestId("queue-row").filter({ hasText: NOME_DO_CONTATO });
    await expect(linha).toBeVisible({ timeout: 30_000 });
    await provaOCartao(page.getByRole("tabpanel", { name: "Fila" }).locator("table"), "fila");
    const r = await medir(linha);
    expect(r.right, "o cartão da fila passa da borda").toBeLessThanOrEqual(BORDA_DIREITA);
    const cancelar = await medir(linha.getByTestId("cancelar-item-da-fila"));
    // Só a borda: a altura vem do `size="sm"` (h-11) com ou sem o cartão.
    expect(cancelar.right, "«Cancelar» passa da borda").toBeLessThanOrEqual(BORDA_DIREITA);
    await page.screenshot({ path: path.join(EVIDENCIA, "03-fila-em-cartao.png") });
  });

  await test.step("7. construtor: o painel fica acima da barra e o zoom tem 44px", async () => {
    await page.goto(`/app/ai/followups/${semente.ponteiro}`);
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 60_000 });

    // A lib dá 26px; a regra de ponteiro grosso, 44. Zoom e encaixe ficam livres
    // (o centro cai no próprio botão). O cadeado de interação, o de baixo, segue
    // sob o «Adicionar nó» flutuante como já ficava antes: não é alvo daqui.
    for (const classe of ["zoomin", "zoomout", "fitview"]) {
      const botao = page.locator(`.react-flow__controls-${classe}`);
      // No meio da tela: na borda de baixo quem recebe o toque seria a barra de abas.
      await botao.evaluate((el) => el.scrollIntoView({ block: "center" }));
      const r = await botao.evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
      expect(r.width, classe).toBeGreaterThanOrEqual(PISO_DE_TOQUE);
      expect(r.height, classe).toBeGreaterThanOrEqual(PISO_DE_TOQUE);
      const livre = await botao.evaluate((el) => {
        const c = el.getBoundingClientRect();
        const alvo = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2);
        return alvo !== null && (alvo === el || el.contains(alvo));
      });
      expect(livre, `o centro de ${classe} cai em outro elemento`).toBe(true);
    }

    await page.getByTestId("node-card-w1").tap();
    const painel = page.getByTestId("node-config-sheet");
    await expect(painel).toBeVisible({ timeout: 30_000 });
    const barra = page.locator("nav[data-barra-inferior]");
    await expect(barra).toBeVisible();
    const fundoDoPainel = await painel.evaluate((el) => el.getBoundingClientRect().bottom);
    const topoDaBarra = await barra.evaluate((el) => el.getBoundingClientRect().top);
    expect(fundoDoPainel, "o painel do passo desce por trás da barra de abas").toBeLessThanOrEqual(topoDaBarra + 1);
    await page.screenshot({ path: path.join(EVIDENCIA, "04-painel-acima-da-barra.png") });
  });

  await test.step("8. caso: «Ver conversa» pega o dedo até 21px do centro", async () => {
    await page.goto(`/app/ai/cases?caso=${semente.caso}`);
    const link = page.getByRole("link", { name: "Ver conversa" });
    await expect(link).toBeVisible({ timeout: 30_000 });
    await link.evaluate((el) => el.scrollIntoView({ block: "center" }));
    // DESVIO DE MÉTODO, escrito: a área declarada é 16px (a caixa `inline-block`
    // do text-xs) + 2×14px (`-inset-3.5`) = 44px, ou seja, ±22px do centro. Mede
    // a 21px, não a 22: a 22 o ponto cai exatamente na borda, e o arredondamento
    // de subpixel da caixa decide sozinho. O controle a 24px (2px fora) tem de
    // NÃO cair no link — se cair, a área é maior que a declarada e os 21px não
    // provam o `-inset-3.5`.
    // Os 21px sozinhos NÃO provam o `inline-block`: num link `inline` a caixa é a
    // da fonte (~14,5px), e 14,5 + 28 ainda dá ±21,25. Quem prova o
    // `inline-block` é a altura medida do `::before`, que só chega a 44 com a
    // caixa de 16px.
    const m = await link.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const cai = (dy: number) => {
        const alvo = document.elementFromPoint(x, y + dy);
        return alvo !== null && (alvo === el || el.contains(alvo));
      };
      return {
        antes: parseFloat(getComputedStyle(el, "::before").height),
        acima21: cai(-21),
        abaixo21: cai(21),
        acima24: cai(-24),
        abaixo24: cai(24),
      };
    });
    expect(m.antes, "altura da área de toque (::before)").toBeGreaterThanOrEqual(PISO_DE_TOQUE - 0.5);
    expect(m.acima21, "21px acima do centro não cai no link").toBe(true);
    expect(m.abaixo21, "21px abaixo do centro não cai no link").toBe(true);
    expect(m.acima24, "controle: 24px acima ainda cai no link").toBe(false);
    expect(m.abaixo24, "controle: 24px abaixo ainda cai no link").toBe(false);
    await page.screenshot({ path: path.join(EVIDENCIA, "05-ver-conversa.png") });
  });
});
