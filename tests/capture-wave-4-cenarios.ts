/**
 * WAVE 4 — CORE 4: a próxima ação do agente sobe para o card com a decisão humana.
 *
 * ARMADO ANTES DA ENTREGA, de propósito. Um aparato escrito depois do código
 * tende a descrever o que o código faz; escrito antes, ele descreve o que o
 * contrato exige. A diferença aparece justamente nos critérios que ninguém
 * lembraria de pedir depois — 13.c (a recusa também é sinal) e 13.e (autorização
 * vencida).
 *
 * O QUE ESTE ARQUIVO CONSTRÓI, E POR QUÊ CONSTRÓI:
 *
 * O dado real motiva a wave, mas NÃO consegue prová-la. `lead_state` tem linhas
 * com `next_action` escritas pelo agente — e a interseção com negócios abertos é
 * ZERO: nenhum contato que tem próxima ação tem lead. O único contato da org que
 * tem lead E estado do harness (Carlos, 33 checkpoints) está com `next_action`
 * nulo. Ou seja: hoje o board não teria o que mostrar, faça o card o que fizer.
 *
 * Então os casos são construídos aqui, descartáveis, marcados com o id da rodada
 * e removidos no `finally` — inclusive os de rodadas que morreram no meio. O que
 * NÃO é aceitável é o inverso: inventar o dado, achar verde e chamar de prova de
 * que a demo funciona. Por isso o cenário 0 mede o banco REAL e reporta o vão,
 * separado dos cenários de comportamento.
 *
 * Run: E2E_PORT=3020 npx tsx tests/capture-wave-4-cenarios.ts
 */

import { chromium, type Locator, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import pg from "pg";

import { applyLeadStateUpdate } from "@/lib/agent-engine/agent/lead-state";
import { carregarEnvLocal } from "../scripts/lib/env-de-teste";

import {
  BASE,
  CREDS,
  EVIDENCE,
  cardLocator,
  carimbar,
  gotoBoard,
  login,
  shotCard,
  shotPage,
} from "./qa-helpers";

const envVars = carregarEnvLocal();
const admin = createClient(envVars.NEXT_PUBLIC_SUPABASE_URL!, envVars.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const pool = new pg.Pool({ connectionString: envVars.SUPABASE_DB_URL });

const ORG = CREDS.org_id as string;
const PIPELINE = (CREDS.crm_vivo as { pipeline_id: string }).pipeline_id;
const STAGE = Object.values((CREDS.crm_vivo as { stage_ids: Record<string, string> }).stage_ids)[0]!;
const DONO = (CREDS.users as Record<string, { id: string }>).manager!.id;

/** Prefixo fixo: é por ele que a limpeza acha sobra de rodada que morreu no meio. */
const PREFIXO = "QA-W4";
const RUN = randomUUID().slice(0, 8);
/**
 * `contacts_phone_e164_format` é constraint de verdade: telefone tem de ser
 * dígitos. Derivo um número estável do id da rodada em vez de colar hex no meio
 * do telefone — foi assim que a primeira execução deste arquivo morreu.
 */
const TELEFONE_BASE = 900_000_000 + (parseInt(RUN, 16) % 90_000_000);

type Estado = "PASS" | "FALHA" | "BLOQUEADO";
const resultados: { n: string; nome: string; estado: Estado; detalhe: string }[] = [];
function record(n: string, nome: string, ok: boolean, detalhe: string, estado?: Estado): void {
  const e: Estado = estado ?? (ok ? "PASS" : "FALHA");
  resultados.push({ n, nome, estado: e, detalhe });
  console.info(`${e.padEnd(9)} [cenário ${n}] ${nome} — ${detalhe}`);
}

// ---------------------------------------------------------------------------
// Os casos
// ---------------------------------------------------------------------------

interface Caso {
  contactId: string;
  /** Em ordem de criação. Só o caso D tem dois. */
  leadIds: string[];
  titulos: string[];
  acao: string | null;
}

/**
 * Cada caso tem contato próprio: `lead_state` é único por contato, então dois
 * casos no mesmo contato compartilhariam a próxima ação e um consumiria o outro.
 */
async function montarCasos(): Promise<Record<string, Caso>> {
  const spec: { chave: string; leads: number; acao: string | null }[] = [
    { chave: "A", leads: 1, acao: `Enviar o orçamento do protocolo (${RUN}/A)` },
    { chave: "C", leads: 1, acao: `Ligar para confirmar o horário (${RUN}/C)` },
    { chave: "D", leads: 2, acao: `Confirmar qual negócio seguir (${RUN}/D)` },
    { chave: "E", leads: 1, acao: `Mandar o contrato versão UM (${RUN}/E)` },
    { chave: "N", leads: 1, acao: null },
  ];

  const casos: Record<string, Caso> = {};
  for (const s of spec) {
    const contato = await inserir("contacts", {
      organization_id: ORG,
      name: `${PREFIXO} ${RUN} contato ${s.chave}`,
      display_name: `${PREFIXO} ${RUN} contato ${s.chave}`,
      phone_number: `+5511${TELEFONE_BASE + s.chave.charCodeAt(0) - 65}`,
      source: "manual",
    });

    const leadIds: string[] = [];
    const titulos: string[] = [];
    for (let i = 0; i < s.leads; i++) {
      const titulo = `${PREFIXO} ${RUN} ${s.chave}${s.leads > 1 ? i + 1 : ""} — negócio de prova`;
      titulos.push(titulo);
      leadIds.push(
        await inserir("crm_leads", {
          organization_id: ORG,
          pipeline_id: PIPELINE,
          stage_id: STAGE,
          contact_id: contato,
          title: titulo,
          status: "open",
          source: "manual",
          value_cents: 100_000 + i * 50_000,
          currency: "BRL",
          // Dono humano: o cenário 14 exige a perna positiva "o card tem dono".
          owner_kind: "user",
          owner_user_id: DONO,
          owner_agent_id: null,
          position_in_stage: 8000 + i,
          // DISTINTOS de propósito no caso D. Com empate, "não aparece em lugar
          // nenhum" também satisfaria 13.d — e aí o teste passaria sem distinguir
          // implementação certa de implementação preguiçosa. Com timestamps
          // distintos existe UMA resposta certa (o mais recente), e o join ingênuo
          // por contact_id aparece nos dois.
          last_activity_at: new Date(Date.now() - (i + 1) * 3_600_000).toISOString(),
        }),
      );
    }

    if (s.acao !== null || s.chave === "N") {
      // O caso N tem `lead_state` COM a linha e SEM ação: é a diferença entre
      // "o agente não conhece este lead" e "o agente conhece e não propôs nada".
      // Só o segundo prova o cenário 14.
      //
      // Escrito pelo ESCRITOR REAL, não por SQL cru. Motivo caro: `next_action_seq`
      // — a identidade da proposta — só avança neste caminho. Semear por fora
      // produziria um estado que o sistema nunca cria (texto presente com seq
      // zerada) e mediria o produto contra uma premissa falsa.
      await escreverProximaAcao(contato, s.acao);
    }

    casos[s.chave] = { contactId: contato, leadIds, titulos, acao: s.acao };
    console.info(
      `[caso ${s.chave}] contato ${contato.slice(0, 8)} · ${s.leads} lead(s) · ação=${s.acao ?? "(nenhuma)"}`,
    );
  }
  return casos;
}

/**
 * Troca a próxima ação pelo ÚNICO caminho de escrita que existe.
 *
 * Custou um vermelho falso: a primeira versão do 13.e trocava o texto por
 * `update lead_state set next_action = ...`, e a seq não se movia. Como a
 * autorização compara a SEQ, o servidor aprovava — corretamente, porque para
 * ele nada tinha mudado. Eu tinha fabricado um estado que o produto não produz
 * e reprovado o produto por não se defender dele.
 */
async function escreverProximaAcao(contactId: string, acao: string | null): Promise<void> {
  const r = await applyLeadStateUpdate(pool, { tenantId: ORG, leadId: contactId }, { next_action: acao });
  if (r.ok !== true) throw new Error(`escrever next_action: ${JSON.stringify(r).slice(0, 200)}`);
}

async function inserir(tabela: string, linha: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.from(tabela).insert(linha as never).select("id").single();
  if (error || !data) throw new Error(`inserir ${tabela}: ${error?.code} ${error?.message}`);
  return (data as { id: string }).id;
}

/**
 * Remove TUDO que tem o prefixo — não só o desta rodada.
 *
 * Uma rodada que morre entre o insert e o `finally` deixa card órfão no board
 * compartilhado. Limpar só o próprio run id transformaria cada crash em lixo
 * permanente na demo que outra sessão está usando.
 */
async function limpar(): Promise<{ leads: number; contatos: number }> {
  const alvo = `${PREFIXO} %`;
  const leads = await pool.query<{ id: string }>(
    `select id from crm_leads where organization_id = $1 and title like $2`,
    [ORG, alvo],
  );
  const ids = leads.rows.map((r) => r.id);
  if (ids.length > 0) {
    await pool.query(`delete from crm_lead_activities where lead_id = any($1::uuid[])`, [ids]);
    await pool.query(`delete from crm_leads where id = any($1::uuid[])`, [ids]);
  }
  const contatos = await pool.query<{ id: string }>(
    `select id from contacts where organization_id = $1 and name like $2`,
    [ORG, alvo],
  );
  const cids = contatos.rows.map((r) => r.id);
  if (cids.length > 0) {
    await pool.query(`delete from lead_state where contact_id = any($1::uuid[])`, [cids]);
    await pool.query(`delete from contacts where id = any($1::uuid[])`, [cids]);
  }
  return { leads: ids.length, contatos: cids.length };
}

// ---------------------------------------------------------------------------
// Leitura de tela
// ---------------------------------------------------------------------------

const APROVAR = /aprovar|aprovo|confirmar a[çc][ãa]o/i;
// O flag `i` NÃO é detalhe: sem ele esta regex reprovou um botão "Descartar"
// correto, e o vermelho apontou para quem construiu em vez de para quem mediu.
const IGNORAR = /ignorar|descartar|recusar|dispensar|n[ãa]o agora|^[✕×x]$/i;

/** aria-label quando existe e não é vazio; senão o texto visível. */
async function nomeAcessivel(b: Locator): Promise<string> {
  const rotulo = ((await b.getAttribute("aria-label")) ?? "").trim();
  if (rotulo) return rotulo;
  return ((await b.textContent()) ?? "").trim();
}

/** Nomes acessíveis dos botões DENTRO do card — a falha se autodiagnostica. */
async function botoesDoCard(card: Locator): Promise<string[]> {
  const botoes = card.getByRole("button");
  const n = await botoes.count();
  const nomes: string[] = [];
  for (let i = 0; i < n; i++) {
    nomes.push((await nomeAcessivel(botoes.nth(i))) || "(sem nome)");
  }
  return nomes;
}

/**
 * Clica o botão do card cujo NOME ACESSÍVEL casa — não a n-ésima posição.
 *
 * Posição é o que um teste escreve quando não sabe o que está clicando: bastaria
 * DevVivo inverter a ordem de "Aprovar" e "Ignorar" para o teste aprovar quando
 * quisesse recusar, e continuar verde.
 */
async function clicarBotao(card: Locator, padrao: RegExp): Promise<string | null> {
  const botoes = card.getByRole("button");
  const n = await botoes.count();
  for (let i = 0; i < n; i++) {
    const b = botoes.nth(i);
    const nome = await nomeAcessivel(b);
    if (padrao.test(nome)) {
      await b.click();
      return nome;
    }
  }
  return null;
}

/**
 * A faixa ③ do card (contrato §5). Não existe seletor semântico para ela hoje,
 * então ancoro pela posição E confirmo pela geometria: a faixa tem altura fixa
 * de ~24px (h-6). Se o card for reestruturado, a checagem falha dizendo o que
 * encontrou, em vez de medir a div errada em silêncio.
 */
async function faixaDoAgente(card: Locator): Promise<{ el: Locator; texto: string; altura: number }> {
  const el = card.locator(":scope > div").nth(1);
  if ((await el.count()) === 0) {
    throw new Error("[faixa] card sem a 2ª div direta — anatomia mudou; releia o contrato §5");
  }
  const box = await el.boundingBox();
  const altura = box?.height ?? -1;
  if (altura < 12 || altura > 44) {
    const todas = await card.locator(":scope > div").allTextContents();
    throw new Error(
      `[faixa] a 2ª div tem ${Math.round(altura)}px — não é a faixa do agente (h-6 ≈ 24px).\n` +
        `Divs do card: ${todas.map((t) => `"${t.replace(/\s+/g, " ").slice(0, 40)}"`).join(" | ")}`,
    );
  }
  return { el, texto: ((await el.innerText()) ?? "").replace(/\s+/g, " ").trim(), altura };
}

/** Linhas visíveis do painel de timeline do contato. */
async function linhasDaTimeline(page: Page): Promise<string[]> {
  const texto = await page.evaluate(() => {
    const paineis = Array.from(document.querySelectorAll('[role="tabpanel"]')) as HTMLElement[];
    const visivel = paineis.find((p) => p.offsetParent !== null) ?? paineis[0];
    return visivel?.innerText ?? "";
  });
  return texto
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

async function abrirTimeline(page: Page, contactId: string): Promise<void> {
  await page.goto(`${BASE}/app/contacts/${contactId}`);
  await page.waitForLoadState("networkidle").catch(() => null);
  const aba = page
    .getByRole("tab", { name: /linha do tempo|timeline/i })
    .or(page.getByRole("button", { name: /^(Linha do tempo|Timeline)$/i }));
  if ((await aba.count()) > 0) await aba.first().click();
  // Espera por CONTEÚDO, nunca por relógio: o fetch da timeline dispara depois
  // da hidratação, e ler antes dele devolve painel vazio — que passaria em toda
  // asserção de ausência.
  await page
    .waitForFunction(() => {
      const paineis = Array.from(document.querySelectorAll('[role="tabpanel"]')) as HTMLElement[];
      const v = paineis.find((p) => p.offsetParent !== null) ?? paineis[0];
      return (v?.innerText ?? "").trim().length > 0;
    }, { timeout: 20_000 })
    .catch(() => null);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ROTULO_CRU = /\b(next_action_approved|next_action_dismissed|stage_changed|ai_turn|note)\b/;

/**
 * Avalia a linha que NASCEU depois da ação — não a timeline inteira.
 *
 * Procurar "aprovada" no texto todo passaria por uma linha antiga de outro lead.
 * O delta isola o que a MINHA ação escreveu, que é a única coisa que 13.b/13.c
 * afirmam.
 */
function linhasNovas(antes: string[], depois: string[]): string[] {
  const contagem = new Map<string, number>();
  for (const l of antes) contagem.set(l, (contagem.get(l) ?? 0) + 1);
  const novas: string[] = [];
  for (const l of depois) {
    const c = contagem.get(l) ?? 0;
    if (c > 0) contagem.set(l, c - 1);
    else novas.push(l);
  }
  return novas;
}

/** O ator é humano? O marcador é geométrico (§5): disco preenchido = pessoa. */
async function temAtorHumano(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const paineis = Array.from(document.querySelectorAll('[role="tabpanel"]')) as HTMLElement[];
    const v = paineis.find((p) => p.offsetParent !== null) ?? paineis[0];
    if (!v) return false;
    return v.querySelectorAll("[class*='bg-accent-soft'], [class*='bg-accent']").length > 0;
  });
}

async function atividadesDoLead(leadId: string): Promise<{ type: string; actor_kind: string; reason: string | null }[]> {
  const r = await pool.query<{ type: string; actor_kind: string; reason: string | null }>(
    `select type, actor_kind, reason from crm_lead_activities where lead_id = $1 order by created_at`,
    [leadId],
  );
  return r.rows;
}

// ---------------------------------------------------------------------------
// A medição
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  fs.mkdirSync(EVIDENCE, { recursive: true });

  const sufixo = carimbar([
    // O APARATO ENTRA NA PRÓPRIA LISTA — ideia do @DevVivo, e ele está certo:
    // instrumento não commitado produz veredito irreprodutível do mesmo jeito que
    // produto não commitado. Declarar só as dependências do produto deixa o carimbo
    // dizer "todas limpas" enquanto a RÉGUA muda debaixo do resultado.
    "tests/capture-wave-4-cenarios.ts",
    "components/kanban/KanbanCard.tsx",
    "components/kanban/KanbanBoard.tsx",
    "components/kanban/KanbanCardActions.tsx",
    "lib/kanban/card-state.ts",
    "hooks/kanban/useBoard.ts",
    "lib/leads/active-lead.ts",
    "lib/leads/activity-vocabulary.ts",
    "components/contacts/TimelineView.tsx",
  ]);
  const png = (nome: string) => `wave-4-${nome}${sufixo}.png`;

  // --- cenário 0: o banco REAL, antes de eu construir qualquer coisa ---------
  const vao = await pool.query<{ com_acao: string; com_lead: string; no_board: string }>(
    `select
       (select count(*) from lead_state where organization_id = $1 and next_action is not null) com_acao,
       (select count(*) from crm_leads l join lead_state ls
          on ls.contact_id = l.contact_id and ls.organization_id = l.organization_id
        where l.organization_id = $1 and l.status = 'open' and ls.next_action is not null) com_lead,
       (select count(*) from crm_leads where organization_id = $1 and pipeline_id = $2
          and status = 'open' and contact_id is not null) no_board`,
    [ORG, PIPELINE],
  );
  const v = vao.rows[0]!;
  record(
    "0",
    "DADO REAL: existe caso de demonstração para a próxima ação?",
    Number(v.com_lead) > 0,
    `${v.com_acao} contatos com next_action · ${v.com_lead} deles com negócio aberto · ` +
      `${v.no_board} cards do board têm contato. Interseção ${Number(v.com_lead) > 0 ? "existe" : "VAZIA"}.`,
    Number(v.com_lead) > 0 ? "PASS" : "BLOQUEADO",
  );

  const antesDaLimpeza = await limpar();
  if (antesDaLimpeza.leads > 0 || antesDaLimpeza.contatos > 0) {
    console.info(
      `[limpeza inicial] removi sobra de rodada anterior: ${antesDaLimpeza.leads} lead(s), ${antesDaLimpeza.contatos} contato(s)`,
    );
  }

  const casos = await montarCasos();
  const browser = await chromium.launch();

  try {
    const page = await (
      await browser.newContext({ viewport: { width: 1440, height: 900 } })
    ).newPage();
    page.setDefaultTimeout(60_000);
    page.setDefaultNavigationTimeout(60_000);

    const respostas: { metodo: string; url: string; status: number }[] = [];
    page.on("response", (r) => {
      const req = r.request();
      if (req.method() !== "GET") respostas.push({ metodo: req.method(), url: r.url(), status: r.status() });
    });

    await login(page, "manager");
    await gotoBoard(page);

    // ===== 13.a — o card com próxima ação mostra a linha e os DOIS botões =====
    const { card: cardA } = await cardLocator(page, casos.A!.titulos[0]!);
    const faixaA = await faixaDoAgente(cardA);
    const botoesA = await botoesDoCard(cardA);
    const mostraAcao = faixaA.texto.includes(casos.A!.acao!);
    const temAprovar = botoesA.some((b) => APROVAR.test(b));
    const temIgnorar = botoesA.some((b) => IGNORAR.test(b));

    record(
      "13.a.1",
      "a faixa do agente mostra a próxima ação proposta",
      mostraAcao,
      mostraAcao
        ? `faixa diz: "${faixaA.texto}"`
        : `faixa diz "${faixaA.texto}" — não contém a ação "${casos.A!.acao}"`,
    );
    record(
      "13.a.2",
      "os DOIS botões de decisão existem no card",
      temAprovar && temIgnorar,
      `botões no card: ${botoesA.length ? botoesA.map((b) => `"${b}"`).join(", ") : "(nenhum)"} ` +
        `→ aprovar=${temAprovar} ignorar=${temIgnorar}`,
    );
    await shotCard(page, casos.A!.titulos[0]!, png("13a-card-com-proposta"));

    /**
     * O GATE DOS VERDES VAZIOS.
     *
     * 13.d ("aparece em no máximo um card") e 14.c ("card sem proposta não tem
     * botões") são asserções de AUSÊNCIA: as duas passam sozinhas num board onde
     * a próxima ação não é renderizada em lugar nenhum. Sem este gate, o dia em
     * que a feature quebrar em silêncio é o dia em que elas ficam verdes.
     */
    const featureExiste = mostraAcao && temAprovar && temIgnorar;

    // ===== 13.b — APROVAR executa E gera atividade =============================
    if (temAprovar) {
      await abrirTimeline(page, casos.A!.contactId);
      const timelineAntes = await linhasDaTimeline(page);
      await gotoBoard(page);

      const { card } = await cardLocator(page, casos.A!.titulos[0]!);
      const marca = respostas.length;
      const clicado = await clicarBotao(card, APROVAR);
      if (!clicado) throw new Error("13.b: o botão de aprovar existia no 13.a e sumiu ao reabrir o board");
      await page.waitForTimeout(2500);

      await abrirTimeline(page, casos.A!.contactId);
      const timelineDepois = await linhasDaTimeline(page);
      const novas = linhasNovas(timelineAntes, timelineDepois);
      const textoNovo = novas.join(" | ");
      const atorHumano = await temAtorHumano(page);
      const rowsA = await atividadesDoLead(casos.A!.leadIds[0]!);
      const aprovacao = rowsA.find((r) => r.type === "next_action_approved");

      record(
        "13.b.1",
        "APROVAR faz nascer uma linha nova na timeline",
        novas.length > 0 && /aprovad/i.test(textoNovo),
        novas.length === 0
          ? "nenhuma linha nova — a timeline não mudou depois do clique"
          : `linhas novas: ${textoNovo.slice(0, 160)}`,
      );
      record(
        "13.b.2",
        "a linha é de HUMANO e tem motivo legível (sem uuid, sem rótulo cru)",
        atorHumano && !UUID.test(textoNovo) && !ROTULO_CRU.test(textoNovo) && textoNovo.length > 0,
        `ator humano=${atorHumano} · uuid=${UUID.test(textoNovo)} · rótulo cru=${ROTULO_CRU.test(textoNovo)}`,
      );
      record(
        "13.b.3",
        "no banco: atividade next_action_approved com actor_kind=user",
        aprovacao?.actor_kind === "user",
        aprovacao
          ? `type=${aprovacao.type} actor_kind=${aprovacao.actor_kind} reason="${aprovacao.reason ?? "(null)"}"`
          : `nenhuma atividade de aprovação — tipos gravados: ${rowsA.map((r) => r.type).join(", ") || "(nenhum)"}`,
      );
      console.info(
        `[mecanismo] respostas não-GET durante o clique: ${respostas
          .slice(marca)
          .map((r) => `${r.metodo} ${r.status}`)
          .join(", ") || "(nenhuma)"}`,
      );
      await shotPage(page, png("13b-timeline-aprovacao"), false);
    } else {
      record("13.b.1", "APROVAR faz nascer uma linha nova na timeline", false, "sem botão de aprovar", "BLOQUEADO");
      record("13.b.2", "a linha é de HUMANO e tem motivo legível", false, "sem botão de aprovar", "BLOQUEADO");
      record("13.b.3", "no banco: next_action_approved com actor_kind=user", false, "sem botão de aprovar", "BLOQUEADO");
    }

    // ===== 13.c — IGNORAR TAMBÉM gera atividade ===============================
    if (temIgnorar) {
      await abrirTimeline(page, casos.C!.contactId);
      const antes = await linhasDaTimeline(page);
      await gotoBoard(page);

      const { card } = await cardLocator(page, casos.C!.titulos[0]!);
      const clicado = await clicarBotao(card, IGNORAR);
      if (!clicado) throw new Error("13.c: o botão de ignorar existia no 13.a e sumiu ao reabrir o board");
      await page.waitForTimeout(2500);

      await abrirTimeline(page, casos.C!.contactId);
      const novas = linhasNovas(antes, await linhasDaTimeline(page));
      const textoNovo = novas.join(" | ");
      const rowsC = await atividadesDoLead(casos.C!.leadIds[0]!);
      const recusa = rowsC.find((r) => r.type === "next_action_dismissed");

      record(
        "13.c.1",
        "IGNORAR também deixa registro na timeline — a recusa é sinal",
        novas.length > 0 && /descartad|ignorad|recusad/i.test(textoNovo),
        novas.length === 0
          ? "nada nasceu: o 'não' do humano sumiu, e o agente vai repropor o que já foi negado"
          : `linhas novas: ${textoNovo.slice(0, 160)}`,
      );
      record(
        "13.c.2",
        "no banco: next_action_dismissed com actor_kind=user",
        recusa?.actor_kind === "user",
        recusa
          ? `type=${recusa.type} actor_kind=${recusa.actor_kind} reason="${recusa.reason ?? "(null)"}"`
          : `nenhuma atividade de recusa — tipos gravados: ${rowsC.map((r) => r.type).join(", ") || "(nenhum)"}`,
      );
      await shotPage(page, png("13c-timeline-recusa"), false);
    } else {
      record("13.c.1", "IGNORAR também deixa registro na timeline", false, "sem botão de ignorar", "BLOQUEADO");
      record("13.c.2", "no banco: next_action_dismissed com actor_kind=user", false, "sem botão de ignorar", "BLOQUEADO");
    }

    // ===== 13.d — UMA ação, UM card ==========================================
    await gotoBoard(page);
    const ondeAparece: string[] = [];
    for (const [i, titulo] of casos.D!.titulos.entries()) {
      const { card } = await cardLocator(page, titulo);
      const faixa = await faixaDoAgente(card);
      if (faixa.texto.includes(casos.D!.acao!)) ondeAparece.push(`${casos.D!.leadIds[i]!.slice(0, 8)} (${titulo.slice(-20)})`);
    }
    record(
      "13.d.1",
      "a próxima ação do CONTATO aparece em no máximo UM negócio",
      featureExiste && ondeAparece.length <= 1,
      featureExiste
        ? `contato com 2 negócios abertos → a ação aparece em ${ondeAparece.length} card(s)` +
          (ondeAparece.length ? `: ${ondeAparece.join(", ")}` : "") +
          (ondeAparece.length > 1 ? " — o join por contact_id vazou para os dois" : "")
        : "o board não mostra proposta em card nenhum (13.a reprovou) — 'no máximo um' " +
          "seria verdade por AUSÊNCIA, não por acerto",
      featureExiste ? undefined : "BLOQUEADO",
    );

    if (ondeAparece.length === 1) {
      const idx = casos.D!.titulos.findIndex((t) => ondeAparece[0]!.includes(t.slice(-20)));
      const { card } = await cardLocator(page, casos.D!.titulos[idx]!);
      await clicarBotao(card, APROVAR);
      await page.waitForTimeout(2500);
      const afetados: string[] = [];
      for (const leadId of casos.D!.leadIds) {
        const rows = await atividadesDoLead(leadId);
        if (rows.some((r) => r.type.startsWith("next_action_"))) afetados.push(leadId.slice(0, 8));
      }
      record(
        "13.d.2",
        "aprovar num negócio não executa pelo outro",
        afetados.length === 1,
        `negócios com atividade de próxima ação: ${afetados.length} (${afetados.join(", ") || "nenhum"})`,
      );
    } else {
      record(
        "13.d.2",
        "aprovar num negócio não executa pelo outro",
        false,
        `a ação apareceu em ${ondeAparece.length} card(s) — sem alvo único, o teste não decide`,
        "BLOQUEADO",
      );
    }
    await shotPage(page, png("13d-um-contato-dois-negocios"), false);

    // ===== 13.e — AUTORIZAÇÃO VENCIDA ========================================
    await gotoBoard(page);
    const acaoNova = `Mandar o contrato versão DOIS (${RUN}/E)`;
    const { card: cardE } = await cardLocator(page, casos.E!.titulos[0]!);
    const faixaEAntes = await faixaDoAgente(cardE);

    // A tela já renderizou a versão UM. A partir daqui, o que o usuário vê e o
    // que o banco diz DIVERGEM — é exatamente a janela em que o sistema agiria
    // em nome de quem autorizou outra coisa.
    await escreverProximaAcao(casos.E!.contactId, acaoNova);
    const marcaE = respostas.length;
    const cliquei = (await clicarBotao(cardE, APROVAR)) !== null;
    await page.waitForTimeout(3000);

    const rowsE = await atividadesDoLead(casos.E!.leadIds[0]!);
    const executouVelha = rowsE.some((r) => r.type === "next_action_approved");
    const estadoE = await pool.query<{ next_action: string | null }>(
      `select next_action from lead_state where organization_id = $1 and contact_id = $2`,
      [ORG, casos.E!.contactId],
    );
    const conflito = respostas.slice(marcaE).filter((r) => r.status === 409);
    const faixaEDepois = cliquei ? await faixaDoAgente(cardE) : faixaEAntes;

    record(
      "13.e.1",
      "clique com autorização vencida NÃO executa a ação antiga",
      cliquei && !executouVelha,
      cliquei
        ? `atividades gravadas: ${rowsE.map((r) => r.type).join(", ") || "(nenhuma)"} · ` +
          `lead_state.next_action = "${estadoE.rows[0]?.next_action ?? "(null)"}"`
        : "não cliquei: sem botão de aprovar",
      cliquei ? undefined : "BLOQUEADO",
    );
    record(
      "13.e.2",
      "o servidor RECUSA com 409",
      conflito.length > 0,
      conflito.length > 0
        ? `409 em ${conflito.map((r) => r.url.replace(BASE, "")).join(", ")}`
        : `nenhum 409 — respostas: ${respostas.slice(marcaE).map((r) => `${r.status}`).join(", ") || "(nenhuma)"}`,
    );
    record(
      "13.e.3",
      "a tela passa a mostrar a ação NOVA",
      faixaEDepois.texto.includes(acaoNova),
      `faixa antes: "${faixaEAntes.texto}" → depois: "${faixaEDepois.texto}"`,
    );
    await shotCard(page, casos.E!.titulos[0]!, png("13e-autorizacao-vencida"));

    // ===== 14 — lead SEM próxima ação mostra o estado NORMAL ==================
    await gotoBoard(page);
    const { card: cardN } = await cardLocator(page, casos.N!.titulos[0]!);
    const textoN = ((await cardN.innerText()) ?? "").replace(/\s+/g, " ");
    const faixaN = await faixaDoAgente(cardN);
    const botoesN = await botoesDoCard(cardN);

    // PERNA POSITIVA — sem ela, "não tem traço" é verdade num card em branco.
    const temTitulo = textoN.includes(`${PREFIXO} ${RUN} N`);
    const temValor = /R\$/.test(textoN);
    const temDono = /E2E Manager|Manager/i.test(textoN) || botoesN.length > 0;
    const renderizou = temTitulo && temValor && temDono;
    record(
      "14.pre",
      "PERNA POSITIVA: o card renderizou conteúdo (título, valor, dono)",
      renderizou,
      `título=${temTitulo} valor=${temValor} dono=${temDono} · card diz: "${textoN.slice(0, 90)}"`,
    );

    if (renderizou) {
      const temTraco = /(^|\s)[—–-](\s|$)/.test(faixaN.texto);
      record(
        "14.a",
        "a faixa NÃO mostra travessão nem placeholder vazio",
        !temTraco && !/null|undefined/i.test(faixaN.texto),
        `faixa: "${faixaN.texto || "(vazia)"}" (${Math.round(faixaN.altura)}px)`,
      );
      /**
       * 14.b — a distinção que resolve o critério, decidida pelo regente e
       * escrita aqui porque critério sem o porquê volta como dúvida na wave
       * seguinte:
       *
       *   um travessão AFIRMA "não há". Espaço reservado NÃO AFIRMA NADA.
       *
       * O primeiro é dado fingindo ser dado; o segundo é geometria — e é a
       * geometria que impede o board de pular quando o dado chega (Wave 2,
       * documentado no próprio KanbanCard). O critério proíbe o placeholder que
       * se passa por informação, não a altura constante.
       *
       * Então a checagem tem DUAS pernas, e nenhuma delas é "o texto é vazio":
       *   (1) a faixa não afirma ausência — nem travessão, nem "sem ação", nem N/A;
       *   (2) a altura reservada é a MESMA do card que tem proposta (senão a
       *       promessa de altura constante é retórica), e o card responde as
       *       outras perguntas: título, valor, dono, estágio.
       */
      const AFIRMA_AUSENCIA = /[—–]|\bN\/?A\b|sem (pr[óo]xima )?a[çc][ãa]o|nenhuma a[çc][ãa]o|vazi[oa]/i;
      const alturaIgual = Math.abs(faixaN.altura - faixaA.altura) < 2;
      const temEstagio = / em .+/.test(textoN);
      record(
        "14.b",
        "faixa reservada NÃO AFIRMA ausência — e o card no estado normal não está vazio",
        !AFIRMA_AUSENCIA.test(faixaN.texto) && alturaIgual && temEstagio,
        `faixa: "${faixaN.texto || "(sem texto)"}" · ${Math.round(faixaN.altura)}px vs ` +
          `${Math.round(faixaA.altura)}px no card com proposta (igual=${alturaIgual}) · ` +
          `rodapé com estágio=${temEstagio}`,
      );
      const semDecisao =
        !botoesN.some((b) => APROVAR.test(b)) &&
        !botoesN.some((b) => IGNORAR.test(b) && b !== "(sem nome)");
      record(
        "14.c",
        "card sem proposta NÃO tem botões de decisão",
        featureExiste && semDecisao,
        featureExiste
          ? `botões: ${botoesN.map((b) => `"${b}"`).join(", ") || "(nenhum)"}`
          : "nenhum card tem botão de decisão hoje — a ausência aqui não distingue nada",
        featureExiste ? undefined : "BLOQUEADO",
      );
    } else {
      for (const c of ["14.a", "14.b", "14.c"]) {
        record(c, "cenário 14", false, "perna positiva falhou — nada depois disto conta", "BLOQUEADO");
      }
    }
    await shotCard(page, casos.N!.titulos[0]!, png("14-card-sem-proposta"));
  } finally {
    await browser.close();
    const removidos = await limpar();
    console.info(`[limpeza] removi ${removidos.leads} lead(s) e ${removidos.contatos} contato(s) desta rodada`);
    await pool.end().catch(() => null);
  }

  const pass = resultados.filter((r) => r.estado === "PASS").length;
  const falha = resultados.filter((r) => r.estado === "FALHA").length;
  const bloq = resultados.filter((r) => r.estado === "BLOQUEADO").length;
  console.info(`\n=== WAVE 4: ${pass} verdes · ${falha} vermelhos · ${bloq} bloqueados ===`);
  for (const r of resultados.filter((x) => x.estado !== "PASS")) {
    console.info(`  ${r.estado} [${r.n}] ${r.nome}: ${r.detalhe}`);
  }
  if (falha > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error("❌ Wave 4 falhou:", err);
  // A limpeza não pode depender do caminho feliz: um crash aqui deixaria cards
  // de teste no board que outra sessão está usando.
  await limpar().catch(() => null);
  await pool.end().catch(() => null);
  process.exit(1);
});
