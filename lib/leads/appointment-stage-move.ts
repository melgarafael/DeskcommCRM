import { observeServiceOrigin } from "@/lib/atendimento/origem";
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { emitLeadActivity, stageChangeReason } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import type { Transicao } from "@/lib/agenda/laco";

/**
 * Espelha a transição de um agendamento (`calendar_appointments.status`) no
 * funil do CRM — MESMO padrão opt-in de `handoff-stage-move.ts`: a ponte é o
 * `slug` da etapa, e pipeline sem a etapa correspondente não muda de
 * comportamento nenhum (`sem_etapa_mapeada`, igual a `sem_etapa_de_handoff`).
 *
 * ⚠️ SÓ `pending` E `confirmed` AVANÇAM O CARD, de propósito. As demais
 * transições (`rescheduled`, `cancelled`, `completed`, `no_show`) não têm
 * entrada no mapa: cancelar ou faltar a UM compromisso não é o negócio
 * esfriando — o cliente pode remarcar, e quem decide que o negócio morreu
 * continua sendo o agente (`crm_stages.agent_stage_hint = 'lost'`) ou um
 * humano arrastando o card, nunca o agendamento sozinho.
 */
export const SLUG_ETAPA_POR_TRANSICAO: Partial<Record<Transicao, string>> = {
  pending: "agendamento-solicitado",
  confirmed: "agendado",
};

export interface ResultadoDoMovimentoDeAgendamento {
  moveu: boolean;
  motivo:
    | "movido"
    | "transicao_nao_mapeada"
    | "sem_etapa_mapeada"
    | "ja_esta_la"
    | "lead_nao_encontrado"
    | "lead_fechado"
    | "conflito_humano"
    | "falha_de_escrita"
    | "indisponivel";
}

export async function moverLeadParaEtapaDeAgendamento(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    leadId: string;
    transicao: Transicao;
  },
): Promise<ResultadoDoMovimentoDeAgendamento> {
  const slugAlvo = SLUG_ETAPA_POR_TRANSICAO[input.transicao];
  if (!slugAlvo) {
    return { moveu: false, motivo: "transicao_nao_mapeada" };
  }

  const { data: lead, error: erroLead } = await admin
    .from("crm_leads")
    .select("id, pipeline_id, stage_id, contact_id, status")
    .eq("id", input.leadId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (erroLead) {
    logger.warn("[appointment-stage-move] leitura do lead falhou", {
      lead_id: input.leadId,
      organization_id: input.organizationId,
      error: erroLead.message,
    });
    return { moveu: false, motivo: "indisponivel" };
  }
  if (!lead) {
    return { moveu: false, motivo: "lead_nao_encontrado" };
  }
  const leadRow = lead as {
    id: string;
    pipeline_id: string;
    stage_id: string;
    contact_id: string | null;
    status: string;
  };

  // Negócio já fechado (ganho/perdido) não volta a se mexer por causa de um
  // agendamento — moveria um card que a organização já considera encerrado.
  if (leadRow.status !== "open") {
    return { moveu: false, motivo: "lead_fechado" };
  }

  const { data: etapa, error: erroEtapa } = await admin
    .from("crm_stages")
    .select("id, name")
    .eq("pipeline_id", leadRow.pipeline_id)
    .eq("slug", slugAlvo)
    .eq("is_archived", false)
    .maybeSingle();
  if (erroEtapa) {
    logger.warn("[appointment-stage-move] leitura da etapa alvo falhou", {
      lead_id: leadRow.id,
      organization_id: input.organizationId,
      error: erroEtapa.message,
    });
    return { moveu: false, motivo: "indisponivel" };
  }
  if (!etapa) {
    return { moveu: false, motivo: "sem_etapa_mapeada" };
  }
  const etapaRow = etapa as { id: string; name: string };

  if (leadRow.stage_id === etapaRow.id) {
    return { moveu: false, motivo: "ja_esta_la" };
  }

  // Nome da origem só enfeita o texto da timeline — erro descartado de
  // propósito, mesmo raciocínio de `agent-stage-sync.ts` e `handoff-stage-move.ts`.
  const { data: origem } = await admin
    .from("crm_stages")
    .select("name")
    .eq("id", leadRow.stage_id)
    .maybeSingle();

  const serviceOrigin = await observeServiceOrigin(admin, input.organizationId, leadRow.contact_id);
  const { data: atualizadas, error: erroUpdate } = await admin
    .from("crm_leads")
    .update({ stage_id: etapaRow.id })
    .eq("id", leadRow.id)
    // Trava otimista pelo estágio de ORIGEM: se um humano moveu o card entre a
    // leitura e a escrita, a decisão dele vence.
    .eq("stage_id", leadRow.stage_id)
    .select("id");
  if (erroUpdate) {
    logger.warn("[appointment-stage-move] update de stage_id falhou", {
      lead_id: leadRow.id,
      organization_id: input.organizationId,
      error: erroUpdate.message,
    });
    return { moveu: false, motivo: "falha_de_escrita" };
  }
  if ((atualizadas ?? []).length === 0) {
    return { moveu: false, motivo: "conflito_humano" };
  }

  const atividade = await emitLeadActivity(admin, {
    organizationId: input.organizationId,
    leadId: leadRow.id,
    contactId: leadRow.contact_id,
    type: "stage_changed",
    sourceModule: "agenda",
    sourceId: leadRow.id,
    actor: { type: "webhook_source", id: "appointment-stage-move" },
    reason: stageChangeReason((origem as { name: string } | null)?.name ?? null, etapaRow.name),
    payload: { motivo_do_movimento: `agendamento:${input.transicao}`, de: leadRow.stage_id, para: etapaRow.id },
  });
  if (!atividade.ok) {
    await registraFalhaDeAtividade(admin, {
      organizationId: input.organizationId,
      leadId: leadRow.id,
      tipo: "stage_changed",
      origem: "lib/leads/appointment-stage-move",
      erro: atividade.error,
    });
  }

  // Mesmo evento que `agent-stage-sync.ts` e `handoff-stage-move.ts` emitem ao
  // mover o card — para que regras de automação e follow-up que escutam
  // `lead.stage_changed` reajam igual, seja qual for a mão que moveu o card.
  const { error: erroEvento } = await admin.rpc("emit_event" as never, {
    p_event_type: "lead.stage_changed",
    p_entity_kind: "crm_lead",
    p_entity_id: leadRow.id,
    p_payload: {
      service_origin: serviceOrigin,
      pipeline_id: leadRow.pipeline_id,
      from_stage_id: leadRow.stage_id,
      to_stage_id: etapaRow.id,
      status: leadRow.status,
    },
    p_metadata: { actor_kind: "system", source: "appointment-stage-move", transicao: input.transicao },
    p_organization_id: input.organizationId,
  } as never);
  if (erroEvento) {
    logger.error("[appointment-stage-move] emit_event lead.stage_changed falhou", {
      lead_id: leadRow.id,
      organization_id: input.organizationId,
      error: (erroEvento as { message?: string }).message ?? String(erroEvento),
    });
  }

  return { moveu: true, motivo: "movido" };
}
