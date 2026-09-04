/**
 * ai-response-worker — pipeline that consumes `message.received` events and
 * produces an AI-generated outbound message + `message.send_requested` event.
 *
 * Pipeline:
 *   1. buildContext   — load conversation, agent, contact, recent messages, RAG hits
 *   2. checkGuards    — IA-01..IA-08 (24h window, blocked, force_human, budget, handoff)
 *   3. invokeBot      — call `anthropic/claude-sonnet-4-6` via Vercel AI Gateway
 *   4. postProcess    — trim, basic guardrails (placeholder for sentiment/handoff hooks)
 *   5. persistAndDispatch — insert outbound message (status='sending') + emit event
 *
 * Service-role caveat (CLAUDE.md §multi-tenancy): admin client bypasses RLS,
 * so EVERY query in this file filters `organization_id` programmatically using
 * `row.organization_id` (from the trusted event_log row, not user input).
 */

import { generateText, type LanguageModel } from "ai";

import {
  DEFAULT_BOT_MODEL,
  gatewayConfig,
  gatewayHeaders,
  isAiGatewayConfigured,
} from "@/lib/ai/gateway";
import { embedText } from "@/lib/ai/embed";
import { MODELO_DE_EMBEDDING } from "@/lib/ai/embeddings/chave";
import { getBudgetStatus, type BudgetStatus } from "@/lib/ai/budget/check";
import {
  AVISO_CORPO,
  AVISO_TITULO,
  BLOQUEIO_TITULO,
  corpoDoBloqueio,
  decidirOrcamento,
  HANDOFF_REASON_ORCAMENTO,
} from "@/lib/agent-engine/edge/llm/orcamento";
import { computeCost } from "@/lib/ai/cost";
import { silencioVigente } from "@/lib/inbox/comando-da-conversa";
import { logInvocation } from "@/lib/ai/log-invocation";
import { elegivelParaWorkerLegado } from "@/lib/ai/agents/no-ar";
import { renderSystemPrompt } from "@/lib/ai/render-system-prompt";
import { triggerHandoff } from "@/lib/ai/handoff/orchestrator";
import { decidirElegibilidadeDaConversaViaSupabase } from "@/lib/ai/elegibilidade/consulta-supabase";
import { ttlDaAutorizacaoMs } from "@/lib/ai/elegibilidade/gate";
import { checkG1, checkG3, checkG4Legal, checkG4Stage } from "@/lib/ai/handoff/triggers";
import type {
  BotContext,
  BotResponse,
  Citation,
  GuardDecision,
  RagHit,
  RecentMessage,
  SkipDecision,
} from "@/lib/ai/types";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { resolverModeloDoPonto } from "@/lib/ai/gateway-binding";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

const RECENT_MESSAGES_LIMIT = 20;
const RAG_TOP_K = 5;
// 0.40 e nao 0.72: o valor foi CALIBRADO com medicao na migration 0097 (pergunta literal 0.849, parafrase 0.49-0.65, irrelevante 0.27).
// Com 0.72 toda parafrase — que e como o cliente escreve — era descartada, e o RAG parecia quebrado funcionando.
// O banco moveu o default; estes tres sitios de codigo ficaram para tras e venciam o banco, porque quem corta pelo limiar e o TypeScript.
const RAG_THRESHOLD = 0.4;
const WINDOW_24H_MS = 24 * 60 * 60 * 1000;
const HANDOFF_RECENT_GUARD_MS = 5_000;

export interface ProcessResult {
  status: "sent_to_dispatch" | "skipped" | "error";
  reason?: string;
  detail?: string;
  outbound_message_id?: string;
}

export async function processMessageReceived(row: EventRow): Promise<ProcessResult> {
  // Cheap pre-check before doing any DB work.
  if (!isAiGatewayConfigured()) {
    return { status: "skipped", reason: "ai_gateway_key_missing" };
  }

  const messageId = (row.payload?.["message_id"] as string | undefined) ?? row.entity_id ?? null;
  const conversationId = (row.payload?.["conversation_id"] as string | undefined) ?? null;
  if (!messageId || !conversationId) {
    return {
      status: "skipped",
      reason: "conversation_not_found",
      detail: "missing message_id/conversation_id in event payload",
    };
  }

  const decision = await buildContext({
    organizationId: row.organization_id,
    conversationId,
    messageId,
  });

  if (decision.kind === "skip") {
    logger.info("[ai-response-worker] skip", {
      reason: decision.reason,
      detail: decision.detail,
      conversation_id: conversationId,
      message_id: messageId,
    });
    return { status: "skipped", reason: decision.reason, detail: decision.detail };
  }

  const ctx = decision.context;

  // ── Synchronous triage (G1, G4) — bypass LLM entirely if a hard handoff
  //    signal is present in the inbound body or the lead's stage. -----------
  const leadId = await resolveLeadId(ctx.organization_id, ctx.contact_id);

  if (checkG1(ctx.inbound_body)) {
    await triggerHandoff({
      conversationId: ctx.conversation_id,
      organizationId: ctx.organization_id,
      reason: "requested_human",
      leadId,
      metadata: { message_id: ctx.message_id, source: "g1_regex" },
    });
    return { status: "skipped", reason: "handoff_g1_requested_human" };
  }

  if (checkG4Legal(ctx.inbound_body)) {
    await triggerHandoff({
      conversationId: ctx.conversation_id,
      organizationId: ctx.organization_id,
      reason: "legal_mention",
      leadId,
      metadata: { message_id: ctx.message_id, source: "g4_legal_regex" },
    });
    return { status: "skipped", reason: "handoff_g4_legal" };
  }

  const stageRequiresHuman = await checkG4Stage(leadId, ctx.organization_id);
  if (stageRequiresHuman) {
    await triggerHandoff({
      conversationId: ctx.conversation_id,
      organizationId: ctx.organization_id,
      reason: "critical_stage",
      leadId,
      metadata: { message_id: ctx.message_id, source: "g4_stage_requires_human" },
    });
    return { status: "skipped", reason: "handoff_g4_stage" };
  }

  // ── Teto de gasto (IA-02) — mesma decisão e mesma régua que o engine aplica.
  //
  // ⚠️ A POSIÇÃO É LOAD-BEARING, e ela mudou. O veto morava dentro de
  // `buildContext`, e `processMessageReceived` faz `return` no primeiro skip —
  // então ele barrava G1 ("quero falar com um atendente"), G4 legal (menção a
  // Procon/advogado) e G4 stage ANTES de qualquer um deles rodar. Enquanto as
  // flags `is_throttled`/`is_disabled` não tinham escritor vivo isso era letra
  // morta; a partir do momento em que o teto vincula de verdade, um lead que
  // PEDE um humano receberia silêncio. Pedido explícito de humano e menção legal
  // são determinísticos e custam ZERO token — não há razão para um teto de GASTO
  // barrá-los. Mesma razão pela qual o guard de modelo-sem-provedor, logo abaixo,
  // também fica depois de G1/G4.
  const veto = await vetoPorTetoDeGasto({
    orgId: ctx.organization_id,
    conversationId: ctx.conversation_id,
    leadId,
  });
  if (veto !== null) {
    logger.info("[ai-response-worker] skip", {
      reason: veto.reason,
      detail: veto.detail,
      conversation_id: conversationId,
      message_id: messageId,
    });
    return { status: "skipped", reason: veto.reason, detail: veto.detail };
  }

  // Mesma armadilha que quebrava o ai-sentiment-worker, e aqui ela é mais cara:
  // este é o worker que RESPONDE O CLIENTE. `ctx.agent.model` é uma string vinda
  // do banco (ai_agents.model), e no AI SDK string com barra é roteada pelo
  // gateway da Vercel — que sem AI_GATEWAY_API_KEY aborta ANTES de emitir
  // qualquer requisição ("Unauthenticated request to AI Gateway"). Numa
  // instalação self-host padrão, que só tem ANTHROPIC_API_KEY, isso significava
  // o bot mudo, uma vez por mensagem recebida.
  //
  // O guard fica DEPOIS de G1/G4 de propósito: pedido de humano e menção legal
  // precisam gerar handoff mesmo numa instalação sem LLM atendível.
  //
  // Skip, não erro: modelo que nenhuma chave desta instalação atende é config,
  // não falha transitória — retentar só repetiria o loop que este PR mata.
  // O painel de provedores manda aqui também — ver lib/ai/gateway-binding.ts.
  const resolvido = await resolverModeloDoPonto(
    "bot_respond",
    ctx.organization_id,
    ctx.agent.model,
  );
  const model = resolvido?.model ?? null;
  if (!model || !resolvido) {
    logger.warn("[ai-response-worker] modelo do agente sem provider configurado", {
      organization_id: ctx.organization_id,
      agent_id: ctx.agent.id,
      model: ctx.agent.model,
    });
    return {
      status: "skipped",
      reason: "ai_gateway_key_missing",
      detail: `nenhuma chave configurada atende o modelo "${ctx.agent.model}"`,
    };
  }

  // Daqui para baixo, o modelo RESOLVIDO pelo painel é o que vai para o provedor
  // E para a telemetria. Os `logInvocation`/`computeCost` abaixo usavam
  // `ctx.agent.model`: a chamada saía para o provedor do binding e a linha em
  // `llm_calls` dizia o modelo do agente. Quem escolhesse, por exemplo, um llama
  // pela OpenRouter em "Responder o cliente" veria a tela de Execuções atribuir
  // o gasto à Anthropic — no ponto de IA mais frequente do produto. O mesmo
  // defeito já tinha sido corrigido no ai-sentiment-worker; aqui era a cópia do
  // padrão que ficou para trás.
  try {
    const response = await invokeBot(ctx, model);
    const post = postProcess(response.text);

    // ── G3 — bot's own response signals low confidence / uncertainty.
    //    Persist the message (may serve as a draft for the human) but DO NOT
    //    dispatch via WAHA, and trigger handoff. ----------------------------
    const confidence = response.citations[0]?.similarity ?? 0;
    const confidenceThreshold =
      typeof ctx.agent.config?.["confidence_threshold"] === "number"
        ? (ctx.agent.config["confidence_threshold"] as number)
        : 0.5;
    if (
      checkG3({
        confidence,
        outputText: response.text,
        threshold: confidenceThreshold,
      })
    ) {
      const persisted = await persistAndDispatch(ctx, response, post.text, {
        skipDispatch: true,
        handoffReason: "low_confidence",
      });
      await triggerHandoff({
        conversationId: ctx.conversation_id,
        organizationId: ctx.organization_id,
        reason: "low_confidence",
        leadId,
        metadata: {
          message_id: ctx.message_id,
          outbound_message_id: persisted.outbound_message_id,
          confidence,
          confidence_threshold: confidenceThreshold,
          source: "g3_low_confidence",
        },
      });
      logInvocation({
        organization_id: ctx.organization_id,
        agent_id: ctx.agent.id,
        conversation_id: ctx.conversation_id,
        message_id: persisted.outbound_message_id,
        invocation_kind: "bot_respond",
        model: resolvido.modelId,
        prompt_tokens: response.prompt_tokens,
        completion_tokens: response.completion_tokens,
        latency_ms: response.latency_ms,
        cost_cents: await computeCost({
          model: resolvido.modelId,
          promptTokens: response.prompt_tokens,
          completionTokens: response.completion_tokens,
        }),
        finish_reason: response.finish_reason,
        citations: response.citations as unknown as Array<Record<string, unknown>>,
      });
      return {
        status: "skipped",
        reason: "handoff_g3_low_confidence",
        outbound_message_id: persisted.outbound_message_id,
      };
    }

    const persisted = await persistAndDispatch(ctx, response, post.text);
    logInvocation({
      organization_id: ctx.organization_id,
      agent_id: ctx.agent.id,
      conversation_id: ctx.conversation_id,
      message_id: persisted.outbound_message_id,
      invocation_kind: "bot_respond",
      model: resolvido.modelId,
      prompt_tokens: response.prompt_tokens,
      completion_tokens: response.completion_tokens,
      latency_ms: response.latency_ms,
      cost_cents: await computeCost({
        model: resolvido.modelId,
        promptTokens: response.prompt_tokens,
        completionTokens: response.completion_tokens,
      }),
      finish_reason: response.finish_reason,
      citations: response.citations as unknown as Array<Record<string, unknown>>,
    });
    return { status: "sent_to_dispatch", outbound_message_id: persisted.outbound_message_id };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[ai-response-worker] invocation failed", {
      conversation_id: ctx.conversation_id,
      message_id: ctx.message_id,
      error: detail,
    });
    logInvocation({
      organization_id: ctx.organization_id,
      agent_id: ctx.agent.id,
      conversation_id: ctx.conversation_id,
      message_id: ctx.message_id,
      invocation_kind: "bot_respond",
      model: resolvido.modelId,
      prompt_tokens: 0,
      completion_tokens: 0,
      latency_ms: 0,
      cost_cents: 0,
      finish_reason: "error",
      error_payload: { message: detail },
    });
    return { status: "error", detail };
  }
}

// ---------------------------------------------------------------------------
// O TETO DE GASTO NESTE CAMINHO — a mina desarmada
// ---------------------------------------------------------------------------

/**
 * Este guard lia `ai_budgets.is_throttled` / `is_disabled`. As duas flags
 * perderam o ÚNICO escritor quando `workers/ai-budget-checker.cron.ts` foi
 * apagado — e ele nunca teve agendador (`docker/scheduler/entrypoint.sh` não o
 * cita, não há rota em `app/api/v1/cron/`), então na prática o guard já era
 * decorativo: este caminho gastava sem teto nenhum enquanto a tela do cliente
 * dizia que havia um. Era também uma mina armada: um PR futuro que só
 * acrescentasse o agendamento ligaria negação de serviço à distância.
 *
 * ⚠️ MUDANÇA DE COMPORTAMENTO, DECLARADA: uma organização com `is_disabled`
 * posto À MÃO no banco deixa de ser barrada aqui. Nenhum escritor vivo jamais
 * ligou essa flag (hipótese: conjunto vazio, NÃO MEDIDO em instalação real). O
 * efeito equivalente hoje é `enforcement_mode = 'bloquear'` em Uso de IA ›
 * Orçamento.
 *
 * A decisão é a MESMA função pura que o engine executa (`decidirOrcamento`) e o
 * gasto vem da MESMA régua (`fn_gasto_de_ia_do_mes`, através de
 * `getBudgetStatus`). Reescrever as condições aqui criaria uma segunda decisão,
 * e a segunda decisão sempre diverge da que age.
 *
 * ⚠️ POR QUE ESTE CAMINHO TAMBÉM ABRE E FECHA OS ITENS DA CENTRAL: a condição 6
 * do gate — "ninguém é bloqueado sem ter sido avisado neste mês" — olha
 * `agent_inbox_items` kind `budget_warning`, e o único emissor era o statement
 * do engine, que NUNCA roda para uma organização deste caminho: o drain pula
 * quem não tem agente publicado nem roteador com membros
 * (`lib/agent-engine/edge/crm/drain.ts`). Sem emitir daqui, a condição 6 jamais
 * se satisfaria e o bloqueio nunca dispararia — um gate que não pode disparar é
 * pior que gate nenhum, porque a tela promete a proteção. E sem o RETRATO
 * (fechar os itens quando o gasto cai abaixo do limiar) o aviso atravessaria a
 * virada do mês aberto, e a dedupe de "já existe item aberto" impediria o aviso
 * do mês novo — travando o bloqueio para sempre.
 *
 * NUNCA LANÇA: erro de leitura de orçamento não pode calar a IA de quem paga.
 * É a mesma assimetria de `aplicarOrcamento` — errar frouxo custa dinheiro de
 * provedor e é visível na tela de Uso; errar duro mata o WhatsApp de um negócio
 * numa VPS onde não há para quem ligar.
 */
async function vetoPorTetoDeGasto(alvo: {
  orgId: string;
  conversationId: string;
  leadId: string | null;
}): Promise<SkipDecision | null> {
  const orgId = alvo.orgId;
  let status: BudgetStatus;
  try {
    // `getBudgetStatus` degrada em vez de lançar, mas o `createAdminClient()` de
    // dentro dele lança quando falta `SUPABASE_SERVICE_ROLE_KEY` — e ficar sem
    // agente por env faltando de uma FEATURE seria o erro caro.
    status = await getBudgetStatus(orgId);
  } catch (err) {
    logger.warn("[ai-response] orçamento não pôde ser lido — a resposta SEGUE sem teto", {
      organization_id: orgId,
      causa: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // Retorno mais cedo de todos: no dia 1 toda organização está em 'off', e nem
  // a consulta do aviso chega a sair.
  if (status.enforcement_mode === "off") return null;

  const admin = createAdminClient();
  // "Neste mês", e não "aberto": fechar o aviso à mão não pode virar bypass
  // permanente do bloqueio — é a mesma régua da CTE `avisado_antes`.
  //
  // ⚠️ O relógio é o do NODE (UTC), e o da CTE é o do Postgres
  // (`date_trunc('month', now())`). Só divergem se o banco não estiver em UTC, e
  // só nas primeiras horas da virada do mês; o efeito de errar é avisar de novo,
  // nunca bloquear sem aviso — o lado certo da assimetria.
  const inicioDoMes = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
  ).toISOString();
  const { count, error: erroDoAviso } = await admin
    .from("agent_inbox_items")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("kind", "budget_warning")
    .gte("created_at", inicioDoMes);
  if (erroDoAviso) {
    // Sem saber se houve aviso, a condição 6 resolve para "não avisou" — o lado
    // que no máximo avisa de novo, nunca o que bloqueia sem aviso.
    logger.warn("[ai-response] não deu para saber se já houve aviso de orçamento neste mês", {
      organization_id: orgId,
      causa: erroDoAviso.message,
    });
  }

  const veredito = decidirOrcamento({
    modo: status.enforcement_mode,
    tetoCents: status.monthly_limit_cents,
    gastoCents: status.current_month_consumed_cents,
    efetivoEm:
      status.enforcement_effective_at === null ? null : new Date(status.enforcement_effective_at),
    agora: new Date(),
    // Turno de resposta ao lead. Nunca está em `PURPOSES_ISENTOS` (que cobre
    // diagnóstico e guardrail) — nomeado para que a isenção seja uma decisão
    // visível e não um `''` que casa por acidente no dia em que a lista mudar.
    purpose: "agent_turn",
    chave: status.enforcement_env,
    limiarPct: status.alarm_threshold_pct,
    avisadoNesteMes: (count ?? 0) > 0,
  });

  // LAÇO DE RETORNO: gasto abaixo do limiar (virou o mês, ou o admin subiu o
  // teto) retrata os dois itens. É o espelho da CTE `retrata` de SQL_ORCAMENTO.
  if (veredito.acao === "seguir") {
    if (veredito.porque === "abaixo_do_limiar") await retratarItensDeOrcamento(admin, orgId);
    return null;
  }

  if (veredito.acao === "avisar_e_seguir") {
    await abrirItemDeOrcamento(admin, orgId, {
      kind: "budget_warning",
      severity: "warn",
      title: AVISO_TITULO,
      body: AVISO_CORPO,
    });
    logger.warn("[ai-response] gasto de IA passou do aviso — a resposta SEGUE", {
      organization_id: orgId,
      porque: veredito.porque,
      gasto_cents: status.current_month_consumed_cents,
      teto_cents: status.monthly_limit_cents,
    });
    return null;
  }

  await abrirItemDeOrcamento(admin, orgId, {
    kind: "budget_exceeded",
    severity: "critical",
    title: BLOQUEIO_TITULO,
    body: corpoDoBloqueio(status.current_month_consumed_cents, status.monthly_limit_cents),
  });

  // ── A CONVERSA VAI PARA A FILA HUMANA, IGUAL AO ENGINE ────────────────────
  //
  // Sem isto, os dois caminhos do produto dariam respostas OPOSTAS ao mesmo
  // veredito: o engine devolve a conversa a um humano (`performHumanHandoff`) e
  // este descartaria a mensagem com `{status:'skipped'}` — o lead no vácuo. Pior,
  // o `budget_exceeded` que acabou de ser aberto aqui carrega o texto de
  // `corpoDoBloqueio`, que PROMETE fila humana; sem o handoff o próprio alerta
  // mentiria.
  //
  // `triggerHandoff` é o irmão local de `performHumanHandoff` (este worker não
  // pode importar o engine sem arrastar `pg` e o SDK para o bundle do Next) e faz
  // o mesmo: `status='pending'`, `bot_silenced_until='infinity'`, atividade na
  // timeline, broadcast em `org:<org>:queue` e auditoria. A razão é a MESMA
  // constante que o engine grava.
  //
  // Nunca lança (contrato do orquestrador), então uma falha aqui não impede a
  // recusa — mas ela é logada lá dentro.
  await triggerHandoff({
    conversationId: alvo.conversationId,
    organizationId: orgId,
    reason: HANDOFF_REASON_ORCAMENTO,
    leadId: alvo.leadId,
    metadata: {
      source: "teto_de_gasto",
      gasto_cents: status.current_month_consumed_cents,
      teto_cents: status.monthly_limit_cents,
    },
  });

  logger.warn("[ai-response] resposta recusada pelo teto de gasto — conversa na fila humana", {
    organization_id: orgId,
    conversation_id: alvo.conversationId,
    gasto_cents: status.current_month_consumed_cents,
    teto_cents: status.monthly_limit_cents,
  });
  return skip("budget_exceeded");
}

/**
 * Abre o item na Central, deduplicado por episódio ABERTO — mesmo predicado das
 * CTEs de `SQL_ORCAMENTO`. Não é atômico (o `select` e o `insert` são duas
 * idas), e o statement do engine também não trava nada: dois drains
 * simultâneos podem abrir dois itens iguais lá e aqui. Item repetido é ruído;
 * item ausente seria a IA parando sem nada na tela explicando.
 *
 * `ref_kind`/`ref_id` existem para que alguém possa FECHAR o item depois — o
 * PATCH de `/api/v1/ai/budget` e o retrato abaixo dependem deles.
 */
async function abrirItemDeOrcamento(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  item: { kind: string; severity: string; title: string; body: string },
): Promise<void> {
  const { count, error: erroDaBusca } = await admin
    .from("agent_inbox_items")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("kind", item.kind)
    .eq("status", "open");
  if (erroDaBusca) {
    logger.warn("[ai-response] dedupe do item de orçamento falhou — item não aberto", {
      organization_id: orgId,
      kind: item.kind,
      causa: erroDaBusca.message,
    });
    return;
  }
  if ((count ?? 0) > 0) return;

  const { error } = await admin.from("agent_inbox_items").insert({
    organization_id: orgId,
    kind: item.kind,
    severity: item.severity,
    title: item.title,
    body: item.body,
    ref_kind: "ai_budget",
    ref_id: orgId,
  });
  if (error) {
    logger.warn("[ai-response] item de orçamento não pôde ser aberto na Central", {
      organization_id: orgId,
      kind: item.kind,
      causa: error.message,
    });
  }
}

/** Fecha os dois itens de orçamento abertos. Espelho da CTE `retrata`. */
async function retratarItensDeOrcamento(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
): Promise<void> {
  const { error } = await admin
    .from("agent_inbox_items")
    .update({ status: "resolved" })
    .eq("organization_id", orgId)
    .eq("status", "open")
    .in("kind", ["budget_exceeded", "budget_warning"]);
  if (error) {
    logger.warn("[ai-response] retrato dos itens de orçamento falhou", {
      organization_id: orgId,
      causa: error.message,
    });
  }
}

// ---------------------------------------------------------------------------
// 1. buildContext + 2. checkGuards (combined — guards inspect data we already
//    have to fetch for context, so they share the same query set).
// ---------------------------------------------------------------------------

interface BuildContextInput {
  organizationId: string;
  conversationId: string;
  messageId: string;
}

async function buildContext(input: BuildContextInput): Promise<GuardDecision> {
  const admin = createAdminClient();

  // Conversation + contact + agent in 2 round trips. Service-role bypasses RLS,
  // so org filter is mandatory on every where-clause.
  const { data: conv, error: convErr } = await admin
    .from("conversations")
    .select(
      "id, organization_id, contact_id, channel_session_id, last_inbound_at, bot_silenced_until, last_handoff_at, assignee_kind, contacts:contact_id(id, display_name, locale, is_blocked, force_human)",
    )
    .eq("id", input.conversationId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();

  if (convErr) return skip("conversation_not_found", convErr.message);
  if (!conv) return skip("conversation_not_found");

  type ConvRow = {
    id: string;
    organization_id: string;
    contact_id: string;
    channel_session_id: string;
    last_inbound_at: string | null;
    bot_silenced_until: string | null;
    last_handoff_at: string | null;
    assignee_kind: string | null;
    contacts: {
      id: string;
      display_name: string | null;
      locale: string | null;
      is_blocked: boolean;
      force_human: boolean;
    } | null;
  };
  const c = conv as unknown as ConvRow;
  if (!c.contacts) return skip("conversation_not_found", "contact join missing");
  if (c.contacts.is_blocked) return skip("contact_blocked");
  if (c.contacts.force_human) return skip("force_human");
  // G3-02 — assignee de 1ª classe: humano atendendo (kind='user') veta o bot
  // deterministicamente, mesma família de guard de force_human/bot_silenced_until.
  if (c.assignee_kind === "user") return skip("assigned_to_human");

  // GATE DE ELEGIBILIDADE (opt-in por canal — `metadata.ai_gate = 'allowlist'`).
  // Este worker é o caminho PRÉ-ENGINE: responde as orgs sem versão de agente
  // publicada. Ele TAMBÉM tem de respeitar o gate — senão liga-se
  // `ai_gate='allowlist'` num canal, o log não reclama, e a IA segue
  // respondendo todo mundo por aqui (a "falha-em-verde" que a doutrina condena).
  // Mesma regra pura que o drain e o turno do agent-engine. Canal 'open' (o
  // default) → `permite:true`, nada muda. Fail-closed: erro de leitura → skip.
  try {
    const elegib = await decidirElegibilidadeDaConversaViaSupabase(admin, {
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      agora: new Date(),
      ttlMs: ttlDaAutorizacaoMs(process.env),
    });
    if (elegib !== null && !elegib.permite) {
      return skip("nao_elegivel_para_ia", elegib.motivo);
    }
  } catch (err) {
    return skip(
      "nao_elegivel_para_ia",
      `elegibilidade indeterminada: ${err instanceof Error ? err.message.slice(0, 120) : "erro"}`,
    );
  }

  // 24h window (IA-01). Use last_inbound_at — webhook updates it on receive.
  if (c.last_inbound_at) {
    const age = Date.now() - new Date(c.last_inbound_at).getTime();
    if (age > WINDOW_24H_MS) return skip("window_24h_expired");
  }
  // Post-handoff silence (IA-06).
  //
  // A regra vem de `lib/inbox/comando-da-conversa.ts` — a MESMA que move a tela —
  // e não de uma comparação local, porque a cópia local que estava aqui discordava
  // dela em produção. Ela era:
  //
  //     new Date(c.bot_silenced_until).getTime() > Date.now()
  //
  // e o valor que o produto grava para escalação permanente é `'infinity'`, cujo
  // `new Date(...).getTime()` é `NaN`. Toda comparação com `NaN` é falsa, então a
  // guarda nunca disparava: a tela mostrava "automático parado" e este worker
  // seguia respondendo por cima de uma conversa que a IA havia entregado a um
  // humano (medido na VPS em 2026-08-30, handoff por `low_sentiment`).
  //
  // `silencioVigente` também falha FECHADO em data ilegível, que é a direção certa:
  // dizer "o automático está ativo" sobre um dado que não se sabe ler é a frase
  // tranquilizadora que a doutrina proíbe.
  if (silencioVigente(c.bot_silenced_until, new Date()).vigente) {
    return skip("silenced_post_handoff");
  }
  // Recent handoff (idempotency for S-06.03)
  if (c.last_handoff_at) {
    const since = Date.now() - new Date(c.last_handoff_at).getTime();
    if (since < HANDOFF_RECENT_GUARD_MS) return skip("handoff_recent");
  }

  // Inbound message body (the trigger payload doesn't carry it).
  const { data: msg, error: msgErr } = await admin
    .from("messages")
    .select("id, body, direction, organization_id")
    .eq("id", input.messageId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (msgErr) return skip("conversation_not_found", msgErr.message);
  if (!msg) return skip("conversation_not_found", "message not found");
  if (msg.direction !== "inbound") return skip("duplicate_outbound");
  const inbound_body = (msg.body ?? "").trim();
  if (!inbound_body) return skip("empty_inbound_body");

  // O agente legado desta organização.
  //
  // `is_active` sozinho NÃO é "quem atende", e tratá-lo como se fosse era o
  // buraco: pausar um `mcp_agent` limpa `published_version_id` e deixa
  // `is_active` de pé, então este SELECT continuava trazendo o agente que o dono
  // acabara de pausar — e a trava `engine_owns_reply` logo abaixo, que é
  // ORG-WIDE, deixa de valer exatamente quando o último publicado é pausado.
  // Resultado medido em produção: pausar o agente o fazia VOLTAR a responder,
  // com o `system_prompt` do cadastro no lugar do da versão publicada.
  //
  // A régua agora é a mesma que a tela usa (`lib/ai/agents/no-ar.ts`).
  //
  // ⚠️ Quem PROTEGE é a régua, não o `.is("archived_at", null)` abaixo — medido
  // por sabotagem: apagar o filtro deixa os 4 casos de
  // `tests/unit/agente-pausado-nao-atende.test.ts` verdes, porque
  // `estadoDoAgente` já devolve "arquivado". O filtro fica por ser mais barato
  // não trazer do banco o que vai ser descartado; não confie nele como guarda.
  // Sem `.limit(1)`: o primeiro da ordem pode ser justamente o que a régua
  // recusa, e cortar antes de filtrar faria um `mcp_agent` pausado — que é
  // `is_default` na instalação que o onboarding cria — esconder o `rag_bot`
  // legítimo logo abaixo dele. A ordem (`is_default`, depois `created_at`) é a
  // de sempre; o que muda é que ela agora escolhe entre os ELEGÍVEIS.
  const { data: candidatos } = await admin
    .from("ai_agents")
    .select(
      "id, organization_id, model, system_prompt, config, guardrails, active_kb_version_id, is_active, is_default, kind, published_version_id, archived_at",
    )
    .eq("organization_id", input.organizationId)
    .eq("is_active", true)
    .is("archived_at", null)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: true });

  const agent = (candidatos ?? []).find(elegivelParaWorkerLegado) ?? null;

  if (!agent) return skip("agent_inactive_or_missing");

  // O ENGINE É O DONO DA RESPOSTA QUANDO HÁ VERSÃO PUBLICADA (issue #129).
  //
  // `lib/waha/ingest.ts` emite, para cada inbound, `ai_agent.dispatch_requested`
  // (drenado pelo agent-engine) E `message.received` (drenado por este worker),
  // incondicionalmente — e até aqui não havia trava nenhuma entre os dois. Numa
  // instalação padrão os dois agiam na MESMA mensagem: o engine respondia de
  // verdade, e este worker chamava o LLM (custo real, cobrado duas vezes) e
  // inseria uma outbound `sending` que nunca saía, porque
  // `message.send_requested` nunca teve consumidor.
  //
  // O critério é o MESMO que o engine usa para se considerar dono
  // (`lib/agent-engine/agent/agent-config.ts`: join em `published_version_id`,
  // não arquivado). Usar o mesmo predicado é o que garante que não existe buraco
  // entre os dois: ou o engine responde, ou este worker responde — nunca
  // nenhum, nunca os dois.
  //
  // Quem NÃO publicou versão nenhuma continua caindo aqui, como antes: sem
  // `published_version_id` o engine não seleciona agente e não age. Por isso a
  // trava não pode ser "existe engine rodando" — essa pergunta não é
  // respondível daqui, e errá-la significaria silenciar a IA de quem depende
  // deste caminho.
  const { data: publicado } = await admin
    .from("ai_agents")
    .select("id")
    .eq("organization_id", input.organizationId)
    .not("published_version_id", "is", null)
    .is("archived_at", null)
    .limit(1)
    .maybeSingle();
  if (publicado) return skip("engine_owns_reply");

  // Base de conhecimento ausente NÃO cala mais o bot.
  //
  // Este `skip` derrubava a resposta inteira — a organização sem material
  // configurado simplesmente não recebia atendimento automático, e o motivo
  // (`kb_version_missing`) só existia no log do worker. Responder sem material é
  // pior que responder com; não responder é pior que os dois.

  // O teto de gasto NÃO mora aqui. Ele é aplicado em `processMessageReceived`,
  // DEPOIS da triagem determinística (G1/G4) — ver o comentário no call site.
  // Aqui ele barrava um pedido explícito de humano.

  // Recent messages (chronological, last RECENT_MESSAGES_LIMIT)
  const { data: recents } = await admin
    .from("messages")
    .select("id, body, direction, created_at")
    .eq("organization_id", input.organizationId)
    .eq("conversation_id", input.conversationId)
    .order("created_at", { ascending: false })
    .limit(RECENT_MESSAGES_LIMIT);
  const recent_messages: RecentMessage[] = ((recents ?? []) as RecentMessage[])
    .slice()
    .reverse();

  // RAG best-effort: lista vazia quando não há material ou não há chave.
  const retrieved_chunks = await retrieveContext({
    organizationId: input.organizationId,
    kbVersionId: agent.active_kb_version_id ?? null,
    query: inbound_body,
  });

  return {
    kind: "proceed",
    context: {
      organization_id: input.organizationId,
      conversation_id: input.conversationId,
      contact_id: c.contact_id,
      channel_session_id: c.channel_session_id,
      message_id: input.messageId,
      inbound_body,
      recent_messages,
      agent: {
        id: agent.id,
        model: agent.model || DEFAULT_BOT_MODEL,
        system_prompt: agent.system_prompt,
        config: (agent.config as Record<string, unknown>) ?? {},
        guardrails: (agent.guardrails as Record<string, unknown>) ?? {},
        active_kb_version_id: agent.active_kb_version_id,
      },
      contact: {
        id: c.contacts.id,
        display_name: c.contacts.display_name,
        locale: c.contacts.locale,
      },
      retrieved_chunks,
    },
  };
}

function skip(reason: SkipDecision["reason"], detail?: string): SkipDecision {
  return { kind: "skip", reason, detail };
}

/**
 * Best-effort lookup of the most recent lead linked to a contact, used by
 * the handoff orchestrator for stage gating (G4) + timeline activity. Returns
 * null on missing/error — handoff itself never depends on a lead.
 */
async function resolveLeadId(
  organizationId: string,
  contactId: string,
): Promise<string | null> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("crm_leads")
      .select("id, organization_id, contact_id, created_at")
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return null;
    return (data as { id: string }).id;
  } catch (err) {
    logger.warn("[ai-response-worker] resolveLeadId failed", {
      organization_id: organizationId,
      contact_id: contactId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

interface RetrieveInput {
  organizationId: string;
  /** LEGADO: só é usado quando a organização não tem material cadastrado. */
  kbVersionId: string | null;
  query: string;
}

/**
 * Este caminho só roda em organização SEM agente publicado (o engine é dono da
 * resposta quando há um). Como não há versão publicada, não há
 * `knowledge_source_ids` para ler: aqui o escopo é a organização inteira, que é
 * o comportamento que este worker sempre teve — antes por acidente (a KB do
 * agente default), agora por escrito.
 */
async function retrieveContext(input: RetrieveInput): Promise<RagHit[]> {
  const admin = createAdminClient();

  const { data: fontesRows } = await admin
    .from("ai_knowledge_sources")
    .select("id")
    .eq("organization_id", input.organizationId)
    .eq("is_active", true)
    .eq("status", "ready")
    .not("active_kb_version_id", "is", null);
  const fontes = ((fontesRows ?? []) as Array<{ id: string }>).map((f) => f.id);

  if (fontes.length === 0 && !input.kbVersionId) return [];

  let embedding: number[];
  try {
    const { embedding: e } = await embedText(input.query, {
      organizationId: input.organizationId,
      ponto: "embedding_consultar",
    });
    embedding = e;
  } catch (err) {
    logger.warn("[ai-response-worker] embed falhou; segue sem RAG", {
      error: err instanceof Error ? err.message : String(err),
      organization_id: input.organizationId,
    });
    return [];
  }

  const { data, error } =
    fontes.length > 0
      ? await admin.rpc("fn_buscar_trechos_das_fontes" as never, {
          p_organization_id: input.organizationId,
          p_source_ids: fontes as unknown as string,
          p_embedding: embedding as unknown as string,
          p_k: RAG_TOP_K,
          p_threshold: RAG_THRESHOLD,
          p_embedding_model: MODELO_DE_EMBEDDING,
        } as never)
      : await admin.rpc("retrieve_top_k_chunks" as never, {
          p_organization_id: input.organizationId,
          p_kb_version_id: input.kbVersionId,
          p_embedding: embedding as unknown as string,
          p_k: RAG_TOP_K,
          p_threshold: RAG_THRESHOLD,
        } as never);

  if (error) {
    logger.warn("[ai-response-worker] busca de trechos falhou", {
      error: error.message,
      organization_id: input.organizationId,
    });
    return [];
  }
  type RpcRow = {
    chunk_id: string;
    knowledge_source_id: string;
    content: string;
    similarity: number;
    metadata: Record<string, unknown> | null;
  };
  return ((data ?? []) as RpcRow[]).map((r) => ({
    chunk_id: r.chunk_id,
    knowledge_source_id: r.knowledge_source_id,
    content: r.content,
    similarity: r.similarity,
    metadata: r.metadata ?? {},
  }));
}

// ---------------------------------------------------------------------------
// 3. invokeBot
// ---------------------------------------------------------------------------

// `model` chega resolvido de fora (ver o guard em processMessageReceived):
// `ctx.agent.model` continua sendo a STRING canônica, porque é ela que vai para
// o custo e para a auditoria em ai_invocations; o que executa é o provider.
async function invokeBot(ctx: BotContext, model: LanguageModel): Promise<BotResponse> {
  const renderedSystem = renderSystemPrompt(ctx.agent.system_prompt, ctx);
  const cfg = gatewayConfig();
  const headers = cfg ? gatewayHeaders({ organizationId: ctx.organization_id }) : undefined;

  // Build a chronological multi-turn message history. The most recent inbound
  // is the implicit final user turn; we also include it explicitly to be safe.
  const messages = ctx.recent_messages
    .filter((m) => (m.body ?? "").trim().length)
    .map((m) => ({
      role: m.direction === "inbound" ? ("user" as const) : ("assistant" as const),
      content: (m.body ?? "").trim(),
    }));
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || last.content !== ctx.inbound_body) {
    messages.push({ role: "user", content: ctx.inbound_body });
  }

  const start = Date.now();
  const result = await generateText({
    model,
    system: renderedSystem,
    messages,
    headers,
  });
  const latency = Date.now() - start;

  const usage = result.usage as
    | {
        inputTokens?: number;
        outputTokens?: number;
        promptTokens?: number;
        completionTokens?: number;
      }
    | undefined;
  const promptTokens = usage?.inputTokens ?? usage?.promptTokens ?? 0;
  const completionTokens = usage?.outputTokens ?? usage?.completionTokens ?? 0;

  const citations: Citation[] = ctx.retrieved_chunks.map((c) => ({
    chunk_id: c.chunk_id,
    knowledge_source_id: c.knowledge_source_id,
    similarity: c.similarity,
    preview: c.content.slice(0, 200),
  }));

  return {
    text: result.text,
    finish_reason: String(result.finishReason ?? "unknown"),
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    latency_ms: latency,
    citations,
  };
}

// ---------------------------------------------------------------------------
// 4. postProcess — minimal at wave 1; sentiment/handoff stubs land in S-06.02/03
// ---------------------------------------------------------------------------

function postProcess(text: string): { text: string; flags: string[] } {
  const trimmed = text.trim();
  // Hard cap to avoid sending wall-of-text. WhatsApp soft-limit is ~4096; keep headroom.
  const capped = trimmed.length > 3500 ? `${trimmed.slice(0, 3500).trimEnd()}…` : trimmed;
  return { text: capped, flags: [] };
}

// ---------------------------------------------------------------------------
// 5. persistAndDispatch
// ---------------------------------------------------------------------------

interface PersistOptions {
  /** When true, do NOT emit `message.send_requested` (G3 handoff path). */
  skipDispatch?: boolean;
  /** When set, marks the message as blocked by this handoff reason. */
  handoffReason?: string;
}

async function persistAndDispatch(
  ctx: BotContext,
  response: BotResponse,
  finalText: string,
  options: PersistOptions = {},
): Promise<{ outbound_message_id: string }> {
  const admin = createAdminClient();

  const insertRow = {
    organization_id: ctx.organization_id,
    conversation_id: ctx.conversation_id,
    channel_session_id: ctx.channel_session_id,
    contact_id: ctx.contact_id,
    type: "text",
    direction: "outbound" as const,
    status: "sending",
    body: finalText,
    sent_via: "ai" as const,
    sent_at: new Date().toISOString(),
    metadata: {
      ai_generated: true,
      agent_id: ctx.agent.id,
      kb_version_id: ctx.agent.active_kb_version_id,
      finish_reason: response.finish_reason,
      citations: response.citations,
      ...(options.skipDispatch ? { handoff_blocked: true } : {}),
      ...(options.handoffReason ? { handoff_reason: options.handoffReason } : {}),
    },
  };

  const { data: inserted, error } = await admin
    .from("messages")
    .insert(insertRow)
    .select("id")
    .single();

  if (error || !inserted) {
    throw new Error(`outbound_insert_failed: ${error?.message ?? "no row returned"}`);
  }

  // Note: the trigger `trg_messages_emit_event` already emits a `message.sending`
  // event on insert. The plan requires `message.send_requested` as a distinct
  // signal for the WAHA dispatch worker — emit it explicitly so that worker
  // (S-06.x in EPIC-03 land) doesn't have to disambiguate trigger events.
  // EXCEPTION (S-06.03 wave 3): when handoff was triggered (G3 low confidence),
  // we persist the bot's draft for the human to reuse but MUST NOT dispatch.
  if (!options.skipDispatch) {
    const { error: emitErr } = await admin.rpc("emit_event" as never, {
      p_event_type: "message.send_requested",
      p_entity_kind: "message",
      p_entity_id: inserted.id,
      p_payload: {
        message_id: inserted.id,
        conversation_id: ctx.conversation_id,
        ai_generated: true,
      },
      p_metadata: { source: "ai-response-worker" },
      p_organization_id: ctx.organization_id,
    } as never);
    if (emitErr) {
      logger.warn("[ai-response-worker] message.send_requested emit failed", {
        error: emitErr.message,
        message_id: inserted.id,
      });
    }
  }

  // Domain event for downstream consumers (UI realtime, audit).
  void admin
    .rpc("emit_event" as never, {
      p_event_type: "ai.responded",
      p_entity_kind: "message",
      p_entity_id: inserted.id,
      p_payload: {
        message_id: inserted.id,
        conversation_id: ctx.conversation_id,
        agent_id: ctx.agent.id,
        confidence: response.citations[0] ? response.citations[0].similarity : null,
        citations: response.citations,
      },
      p_metadata: { source: "ai-response-worker" },
      p_organization_id: ctx.organization_id,
    } as never)
    .then(({ error: e }: { error: { message: string } | null }) => {
      if (e) {
        logger.warn("[ai-response-worker] ai.responded emit failed", {
          error: e.message,
          message_id: inserted.id,
        });
      }
    });

  return { outbound_message_id: inserted.id };
}
