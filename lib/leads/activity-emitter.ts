import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor } from "@/lib/api/handlers/types";
import type { ActivityType } from "@/lib/leads/activity-vocabulary";
import { CHAVE_DO_TOKEN_DA_ATIVIDADE, tokenDoAtor } from "@/lib/leads/integracao-da-atividade";

/** Os cinco atores que `crm_lead_activities.actor_kind` aceita (migration 0071). */
export type ActivityActorKind = "user" | "ai" | "system" | "rule" | "contact";

/**
 * O lastro. **Cada chave aponta para UMA tabela** — a 0072 existe porque essa
 * correspondência estava quebrada: o turno guardava id de `llm_calls` dentro de
 * `run_ids`, e quem seguisse a trilha faria join contra `ai_agent_runs` e
 * receberia vazio, sem erro.
 */
export interface ActivityEvidence {
  /** → `ai_agent_runs` */
  run_ids?: string[];
  /** → o trace do turno */
  trace_ids?: string[];
  /** → `llm_calls` (0072) */
  llm_call_ids?: string[];
}

export interface EmitLeadActivityInput {
  organizationId: string;
  leadId: string;
  contactId?: string | null;
  /**
   * Tipo da atividade — do vocabulário fechado (activity-vocabulary.ts). É
   * `ActivityType` e não `string` de propósito: foi escrevendo tipo livre que a
   * tela e o banco divergiram sem ninguém perceber.
   */
  type: ActivityType;
  /** O QUE ORIGINOU (um ponteiro) — não confundir com evidence. */
  sourceModule: string;
  sourceId?: string | null;
  actor: Actor;
  /** O PORQUÊ, legível por humano. Sem PII: aparece na tela e no export LGPD. */
  reason: string;
  /** O QUE SUSTENTA (N referências). Obrigatório de fato para ator 'ai'. */
  evidence?: ActivityEvidence | null;
  payload?: Record<string, unknown>;
}

/**
 * Grava UMA linha no barramento da vida do lead.
 *
 * Existe como função compartilhada pelo mesmo motivo do `resolveOwnerPatch`: há
 * três escritores de estágio hoje (rota de move, bulk, MCP) e vai haver um
 * quarto. Guarda em cada chamador protege os de hoje; guarda aqui protege
 * também o que ainda não foi escrito — e aqui o esquecimento não é erro
 * barulhento, é atividade que simplesmente nunca nasce.
 *
 * **Fire-and-forget de propósito**: a timeline não pode derrubar a operação que
 * ela descreve. Falha vira log, nunca exceção para o usuário.
 */
/** A linha exatamente como vai para `crm_lead_activities`. */
export interface LeadActivityRow {
  organization_id: string;
  lead_id: string;
  contact_id: string | null;
  type: ActivityType;
  source_module: string;
  source_id: string | null;
  actor_kind: ActivityActorKind;
  actor_agent_id: string | null;
  performed_by_user_id: string | null;
  reason: string;
  evidence: ActivityEvidence | null;
  payload: Record<string, unknown>;
  /**
   * Só na linha de um TOKEN de API: qual token agiu (#5160). Os outros atores
   * não levam a chave — a linha deles não muda, e os escritores por `pg` que
   * listam as colunas seguem iguais.
   */
  metadata?: { [CHAVE_DO_TOKEN_DA_ATIVIDADE]: string };
}

/**
 * A REGRA, separada da escrita.
 *
 * Existe porque os emissores não compartilham cliente: a API usa o client do
 * Supabase e o motor do agente usa `pg.Pool` direto (before-send roda fora do
 * request). Se cada um montasse a própria linha, a regra de lastro viveria em
 * dois lugares — e um deles ficaria para trás, que é como todo o resto desta
 * entrega já quebrou uma vez.
 */
export function buildLeadActivityRow(input: EmitLeadActivityInput): LeadActivityRow {
  const { kind, agentId, userId } = actorParaAtividade(input.actor);
  const temLastro =
    (input.evidence?.run_ids?.length ?? 0) > 0 ||
    (input.evidence?.trace_ids?.length ?? 0) > 0 ||
    (input.evidence?.llm_call_ids?.length ?? 0) > 0;

  // Ator 'ai' SEM lastro seria recusado pela constraint (0071). Em vez de
  // perder o registro ou inventar um run_id, grava como 'system' mantendo
  // actor_agent_id: não afirma a autoria da IA sem prova, mas não apaga que o
  // agente estava envolvido. Mesma regra do backfill da 0071.
  const actorKind: ActivityActorKind = kind === "ai" && !temLastro ? "system" : kind;
  const tokenDaLinha = tokenDoAtor(input.actor);

  return {
    organization_id: input.organizationId,
    lead_id: input.leadId,
    contact_id: input.contactId ?? null,
    type: input.type,
    source_module: input.sourceModule,
    source_id: input.sourceId ?? null,
    actor_kind: actorKind,
    actor_agent_id: agentId,
    performed_by_user_id: userId,
    reason: input.reason,
    evidence: temLastro ? (input.evidence ?? null) : null,
    payload: input.payload ?? {},
    // Sem isto a linha do token é indistinguível da plataforma agindo sozinha,
    // e o painel "Atividade" diz "Sistema" (#5160).
    ...(tokenDaLinha ? { metadata: { [CHAVE_DO_TOKEN_DA_ATIVIDADE]: tokenDaLinha } } : {}),
  };
}

export async function emitLeadActivity(
  supabase: SupabaseClient,
  input: EmitLeadActivityInput,
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase
    .from("crm_lead_activities")
    .insert(buildLeadActivityRow(input));

  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Traduz o Actor da API para o vocabulário da timeline. */
export function actorParaAtividade(actor: Actor): {
  kind: ActivityActorKind;
  userId: string | null;
  agentId: string | null;
} {
  if (actor.type === "user") {
    return { kind: "user", userId: actor.id, agentId: null };
  }
  if (actor.type === "ai_agent") {
    // ⚠️ `agent_id`, NUNCA `id`. `id` carrega o run (ou o token, ou a string
    // 'agent-engine') dependendo de quem chamou, e `actor_agent_id` tem FK para
    // `ai_agents`: mandar `id` para lá derrubava o INSERT e a atividade sumia em
    // silêncio. Sem `agent_id` a linha entra como sistema — perde-se a AUTORIA,
    // que é ruim, em vez da LINHA INTEIRA, que é pior. Ver `Actor` em
    // lib/api/handlers/types.ts.
    return { kind: "ai", userId: null, agentId: actor.agent_id ?? null };
  }
  // webhook_source e afins: o produto agiu, não uma pessoa nem um agente.
  return { kind: "system", userId: null, agentId: null };
}

/** "Movido de Avaliação para Proposta enviada" — o porquê legível do 2.2. */
export function stageChangeReason(fromStageName: string | null, toStageName: string | null): string {
  if (fromStageName && toStageName) return `Movido de ${fromStageName} para ${toStageName}`;
  if (toStageName) return `Movido para ${toStageName}`;
  return "Mudou de estágio";
}
