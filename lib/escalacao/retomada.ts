/**
 * Devolver o atendimento ao agente — a regra, num lugar só.
 *
 * ## O defeito que este arquivo existe para consertar
 *
 * `POST /conversations/[id]/reactivate-bot` limpava `bot_silenced_until` e
 * declarava `{ reactivated: true }`. Só que a passagem para humano tem TRÊS
 * travas, não uma, e ela soltava a mais fraca:
 *
 *   1. `contacts.force_human = true`   → `workers/ai-response-worker.ts` pula com
 *      `skip("force_human")`, `isLeadInHandoff` (harness) devolve true antes de
 *      qualquer chamada de modelo, e `before-send.ts` veta TODO envio com
 *      `(is_blocked or force_human) as stopped`;
 *   2. `conversations.assignee_kind = 'user'` → `skip("assigned_to_human")`;
 *   3. `conversations.bot_silenced_until` → a única que era limpa.
 *
 * Ninguém, em lugar nenhum do repo, escrevia `force_human = false`. Ou seja: o
 * botão de devolver o atendimento não devolvia nada, e o modo de falha era o pior
 * possível — a rota respondia sucesso e o agente ficava mudo para sempre.
 *
 * ## Por que a função e não a rota
 *
 * A tool do agente e a rota da tela precisam operar pela MESMA regra. Se a IA
 * devolvesse o atendimento por um caminho e a pessoa por outro, o sistema mentiria
 * para um dos dois — e este arquivo é justamente a prova de que isso acontece
 * quando a regra mora dentro do `route.ts`.
 *
 * `force_human` continua **irrevogável pelo agente** (a regra dura do harness):
 * quem chama isto decide devolver, e a tool que expõe esta função ao modelo é
 * marcada como capacidade de risco crítico — não entra ligada por pacote.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { resolveActiveLeadForContact, type LeadCandidate } from "@/lib/leads/active-lead";
import { logger } from "@/lib/logger";
import { autorizarContatoParaIA } from "@/lib/ai/elegibilidade/autorizacao";

import { lerContinuidadeHumana, type ContinuidadeHumana } from "./continuidade";

export interface RetomadaDeps {
  /** Admin client (service role) OU client do request — os dois filtram org aqui. */
  supabase: SupabaseClient;
  organizationId: string;
  actor: Actor;
  requestId: string;
  apiTokenId?: string | null;
}

export type RetomadaFalha =
  | "conversation_not_found"
  /** Alguém assumiu a conversa entre a leitura e a escrita. */
  | "assignment_conflict"
  /** O sinal de retomada do follow-up não foi emitido — ver comentário abaixo. */
  | "resume_signal_failed";

export type RetomadaResultado =
  | {
      ok: true;
      conversationId: string;
      /** true = já estava com o agente; a operação é idempotente. */
      jaEstavaComOAgente: boolean;
      continuidade: ContinuidadeHumana;
    }
  | { ok: false; erro: RetomadaFalha; detalhe?: string };

/** Status em que faz sentido devolver o comando ao agente (encerrada, não). */
const STATUS_REATIVAVEIS = new Set(["open", "pending", "claimed", "ai_handling"]);

interface ConversaRow {
  id: string;
  contact_id: string | null;
  status: string | null;
  assigned_to_user_id: string | null;
  assignee_kind: string | null;
  bot_silenced_until: string | null;
}

export async function devolverAtendimentoAoAgente(
  deps: RetomadaDeps,
  input: { conversationId: string },
): Promise<RetomadaResultado> {
  const { supabase, organizationId } = deps;

  const { data: convData, error: convErr } = await supabase
    .from("conversations")
    .select("id, contact_id, status, assigned_to_user_id, assignee_kind, bot_silenced_until")
    .eq("id", input.conversationId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (convErr) return { ok: false, erro: "conversation_not_found", detalhe: convErr.message };
  if (!convData) return { ok: false, erro: "conversation_not_found" };
  const conv = convData as unknown as ConversaRow;

  const jaEstavaComOAgente =
    conv.assigned_to_user_id === null &&
    conv.bot_silenced_until === null &&
    conv.assignee_kind !== "user";

  // A continuidade é lida ANTES de mexer em qualquer coisa: depois da devolução o
  // chamado pode ser fechado por outro caminho e o rastro do que a pessoa fez
  // ficaria mais pobre justamente no momento em que ele importa.
  const continuidade = await lerContinuidadeHumana(
    supabase,
    organizationId,
    input.conversationId,
  );

  // (1) Solta o dono humano pela regra que já existe (UPDATE + evento de
  // atribuição na MESMA transação). `p_enforce_expected: false` porque soltar é
  // idempotente por natureza: se outro release ganhou a corrida, o estado final
  // é o mesmo que queríamos.
  if (conv.assigned_to_user_id !== null) {
    const { error: releaseErr } = await supabase.rpc("fn_conversation_assign", {
      p_organization_id: organizationId,
      p_conversation_id: input.conversationId,
      p_to_user_id: null,
      p_reason: "release",
      p_expected_assignee: null,
      p_enforce_expected: false,
    });
    if (releaseErr) {
      return { ok: false, erro: "assignment_conflict", detalhe: releaseErr.message };
    }
  }

  // (2) Devolve o comando. `assignee_kind='ai'` exige `assigned_to_user_id is
  // null` (CHECK conversations_assignee_kind_coherence) — o filtro `.is(...)` é o
  // guarda otimista: se alguém assumiu entre o release e aqui, 0 linhas e a gente
  // reporta o conflito em vez de estourar a constraint.
  const proximoStatus = STATUS_REATIVAVEIS.has(conv.status ?? "")
    ? "ai_handling"
    : (conv.status ?? "open");
  const { data: atualizada, error: updErr } = await supabase
    .from("conversations")
    .update({
      bot_silenced_until: null,
      last_handoff_at: null,
      last_handoff_reason: null,
      assignee_kind: "ai",
      status: proximoStatus,
      status_changed_at: new Date().toISOString(),
    })
    .eq("id", input.conversationId)
    .eq("organization_id", organizationId)
    .is("assigned_to_user_id", null)
    .select("id")
    .maybeSingle();
  if (updErr) return { ok: false, erro: "assignment_conflict", detalhe: updErr.message };
  if (!atualizada) return { ok: false, erro: "assignment_conflict" };

  // (3) A trava que ninguém soltava. Sem esta linha as outras duas não servem de
  // nada: os três guards (worker nativo, harness, before-send) leem daqui.
  if (conv.contact_id !== null) {
    const { error: contatoErr } = await supabase
      .from("contacts")
      .update({ force_human: false })
      .eq("id", conv.contact_id)
      .eq("organization_id", organizationId);
    if (contatoErr) {
      logger.error("[escalacao.retomada] force_human não foi limpo", {
        conversation_id: input.conversationId,
        error: contatoErr.message,
      });
      return { ok: false, erro: "assignment_conflict", detalhe: contatoErr.message };
    }
  }

  // (3b) ELEGIBILIDADE: devolver o atendimento à IA é uma decisão humana
  // explícita — no gate `allowlist`, é ela que RE-AUTORIZA o contato. Sem isto,
  // o botão "devolver ao automático" apagaria as três travas de handoff e a IA
  // continuaria muda, porque `contacts.ai_authorized_at` seguiria nulo/expirado.
  if (conv.contact_id !== null) {
    await autorizarContatoParaIA(supabase, {
      organizationId,
      contactId: conv.contact_id,
      reason: "retomada_manual",
    });
  }

  // (4) Sinal durável de fim do episódio. AWAITED, não fire-and-forget, pela
  // mesma razão que a rota original documentava: é o ÚNICO produtor do sinal que
  // retoma um follow-up pausado por passagem a humano (lib/followup/reactivity.ts).
  // Perder aqui órfã o enrollment para sempre.
  const { error: emitErr } = await supabase.rpc("emit_event", {
    p_event_type: "ai.handoff_resolved",
    p_entity_kind: "conversation",
    p_entity_id: input.conversationId,
    p_payload: {
      conversation_id: input.conversationId,
      contact_id: conv.contact_id,
      organization_id: organizationId,
    },
    p_metadata: { source: "escalacao.retomada", request_id: deps.requestId },
    p_organization_id: organizationId,
  });
  if (emitErr) {
    return { ok: false, erro: "resume_signal_failed", detalhe: emitErr.message };
  }

  // (5) O input estruturado que a IA lê para retomar (invariante 2 da doutrina).
  if (conv.contact_id !== null && continuidade.houveAtendimentoHumano) {
    await gravarCheckpointDeRetomada(supabase, organizationId, conv.contact_id, continuidade);
  }

  // (6) Passagem de atendimento é evento de vida do negócio — a ida já emitia
  // `handoff_triggered` e a volta não emitia nada, então a linha do tempo mostrava
  // o cliente saindo para uma pessoa e nunca voltando.
  if (conv.contact_id !== null) {
    await emitirAtividadeDeRetomada(deps, conv.contact_id, input.conversationId, continuidade);
  }

  await audit({
    action: "ai.reactivated_by_agent",
    actorUserId: deps.actor.type === "user" ? deps.actor.id : null,
    actorApiTokenId: deps.apiTokenId ?? null,
    organizationId,
    resourceType: "conversation",
    resourceId: input.conversationId,
    requestId: deps.requestId,
    metadata: {
      actor_type: deps.actor.type,
      houve_atendimento_humano: continuidade.houveAtendimentoHumano,
      decisoes: continuidade.decisoes.length,
      notas: continuidade.notas.length,
    },
  });

  return { ok: true, conversationId: input.conversationId, jaEstavaComOAgente, continuidade };
}

/**
 * O texto do que a pessoa fez entra na memória durável do lead.
 *
 * Escolhido em vez de uma tabela nova porque `lead_checkpoints` já É o lugar onde
 * o agente busca contexto na abertura de TODO turno (`latestCheckpoint` →
 * `ritualBlocks` → bloco "Resumo acumulado da conversa"). Criar uma superfície
 * paralela exigiria um leitor novo no motor, e uma peça que só o autor sabe
 * consultar é ilha — a doutrina do sistema vivo é exatamente contra isso.
 *
 * O resumo é ACRESCENTADO ao anterior, nunca substituído: sobrescrever apagaria o
 * histórico da conversa justamente para contar um pedaço dela.
 */
async function gravarCheckpointDeRetomada(
  supabase: SupabaseClient,
  organizationId: string,
  contactId: string,
  continuidade: ContinuidadeHumana,
): Promise<void> {
  const { data: anteriorData } = await supabase
    .from("lead_checkpoints")
    .select("commitments, objections, next_action, rolling_summary")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .order("seq", { ascending: false })
    .limit(1)
    .maybeSingle();
  const anterior = (anteriorData ?? null) as {
    commitments: unknown;
    objections: unknown;
    next_action: string | null;
    rolling_summary: string | null;
  } | null;

  const acumulado = (anterior?.rolling_summary ?? "").trim();
  const { error } = await supabase.from("lead_checkpoints").insert({
    organization_id: organizationId,
    contact_id: contactId,
    // Não nasceu de um run do agente — a pessoa é que devolveu o atendimento.
    job_id: null,
    commitments: anterior?.commitments ?? [],
    objections: anterior?.objections ?? [],
    next_action: continuidade.pendenciaComOCliente ?? anterior?.next_action ?? null,
    rolling_summary:
      acumulado === "" ? continuidade.resumo : `${acumulado}\n\n${continuidade.resumo}`,
  });
  if (error) {
    // Sem o checkpoint o agente volta CEGO — isso é degradação de verdade, e
    // silenciar aqui reproduziria o defeito que este arquivo conserta.
    logger.error("[escalacao.retomada] checkpoint de retomada não foi gravado", {
      contact_id: contactId,
      error: error.message,
    });
  }
}

/** A volta na linha do tempo do negócio. Fire-and-forget: timeline não derruba operação. */
async function emitirAtividadeDeRetomada(
  deps: RetomadaDeps,
  contactId: string,
  conversationId: string,
  continuidade: ContinuidadeHumana,
): Promise<void> {
  const { data: leadsData } = await deps.supabase
    .from("crm_leads")
    .select("id, organization_id, pipeline_id, status, last_activity_at, created_at")
    .eq("organization_id", deps.organizationId)
    .eq("contact_id", contactId);
  const { data: defaultPipeline } = await deps.supabase
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", deps.organizationId)
    .eq("is_default", true)
    .eq("is_archived", false)
    .limit(1)
    .maybeSingle();

  const alvo = resolveActiveLeadForContact((leadsData ?? []) as LeadCandidate[], {
    defaultPipelineId: (defaultPipeline as { id: string } | null)?.id ?? null,
  });
  if (!alvo.routed) return;

  const resultado = await emitLeadActivity(deps.supabase, {
    organizationId: deps.organizationId,
    leadId: alvo.leadId,
    contactId,
    type: "handoff_resolved",
    sourceModule: "escalacao.retomada",
    sourceId: conversationId,
    actor: deps.actor,
    reason: continuidade.houveAtendimentoHumano
      ? "Atendimento devolvido ao agente com o registro do que a equipe decidiu"
      : "Atendimento devolvido ao agente",
    payload: {
      conversation_id: conversationId,
      decisoes: continuidade.decisoes.length,
      notas: continuidade.notas.length,
    },
  });
  if (!resultado.ok) {
    logger.warn("[escalacao.retomada] atividade da volta não foi gravada", {
      conversation_id: conversationId,
      error: resultado.error,
    });
  }
}
