import { StaleServiceBoundaryError, type ServiceBoundary } from "@/lib/atendimento/fronteira";
import { assertServiceBoundarySupabase, observeServiceOrigin } from "@/lib/atendimento/origem";
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { emitLeadActivity, stageChangeReason } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import {
  recusaDeCamposObrigatorios,
  settingsDoFunil,
  validaCamposExigidos,
} from "@/lib/leads/campos-exigidos";

/**
 * Move o card do lead para a etapa do funil que o tenant marcou como destino
 * de handoff, sempre que o orquestrador (`lib/ai/handoff/orchestrator.ts`)
 * decide que um atendimento precisa de humano.
 *
 * ⚠️ OPT-IN POR PIPELINE, via `slug`, não `requires_human`. `requires_human`
 * já é usado por `checkG4Stage` no sentido INVERSO (lead JÁ está numa etapa
 * assim → dispara handoff) e mais de uma etapa pode carregar essa flag no
 * mesmo pipeline (ex.: "Repassado para o Fulano", que é atribuição a uma
 * PESSOA, não "precisa de humano agora"). `slug` é estável, único por
 * pipeline (`uniq_crm_stages_pipeline_slug`) e é exatamente o campo que este
 * schema já tem para apontar sem ambiguidade — different de `name`, que o
 * tenant pode renomear a qualquer momento.
 *
 * Pipeline SEM essa etapa (todo clone novo, por padrão) não muda de
 * comportamento nenhum: `sem_etapa_de_handoff` é resposta legítima, igual ao
 * `sem_mapeamento` de `agent-stage-sync.ts` — não inventamos etapa que o
 * tenant não criou.
 */
export const SLUG_ETAPA_HANDOFF = "chamar-humano";

export interface ResultadoDoMovimentoDeHandoff {
  moveu: boolean;
  motivo:
    | "movido"
    | "sem_etapa_de_handoff"
    | "ja_esta_la"
    | "lead_nao_encontrado"
    | "lead_fechado"
    | "conflito_humano"
    /**
     * A etapa de handoff exige CAMPOS que o negócio não tem (issue #1536).
     *
     * A MESMA régua do arrasto e do agente (`validaCamposExigidos`), e o mesmo
     * desenho da recusa: o card não anda, nada quebrou, e `detalhe` traz a
     * frase com o que falta — é o que o chamador registra no log (aqui não há
     * quadro aberto nem inbox: o handoff é best-effort e o rastro é o warn).
     */
    | "campos_obrigatorios"
    | "falha_de_escrita"
    | "indisponivel";
  /** Só quando `motivo` é `campos_obrigatorios` — o que falta, em frase. */
  detalhe?: string;
}

export async function moverLeadParaEtapaDeHandoff(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    leadId: string;
    /** `HandoffReason` de `lib/ai/handoff/orchestrator.ts` — string aqui para não acoplar os dois módulos. */
    reason: string;
    serviceBoundary?: ServiceBoundary;
  },
): Promise<ResultadoDoMovimentoDeHandoff> {
  const { data: lead, error: erroLead } = await admin
    .from("crm_leads")
    // `custom_fields` e `won_reason` são lidos POR CAUSA da régua de campos
    // obrigatórios (#1536): sem eles, `validaCamposExigidos` só veria ausência.
    .select("id, pipeline_id, stage_id, contact_id, status, custom_fields, won_reason")
    .eq("id", input.leadId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (erroLead) {
    logger.warn("[handoff-stage-move] leitura do lead falhou", {
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
    custom_fields: Record<string, unknown> | null;
    won_reason: string | null;
  };

  // Negócio já fechado (ganho/perdido) não volta a se mexer por causa de um
  // handoff — moveria um card que a organização já considera encerrado.
  if (leadRow.status !== "open") {
    return { moveu: false, motivo: "lead_fechado" };
  }

  const { data: etapaData, error: erroEtapa } = await admin
    .from("crm_stages")
    .select("id, name, is_won, is_lost")
    .eq("pipeline_id", leadRow.pipeline_id)
    .eq("slug", SLUG_ETAPA_HANDOFF)
    .eq("is_archived", false)
    .maybeSingle();
  if (erroEtapa) {
    logger.warn("[handoff-stage-move] leitura da etapa de handoff falhou", {
      lead_id: leadRow.id,
      organization_id: input.organizationId,
      error: erroEtapa.message,
    });
    return { moveu: false, motivo: "indisponivel" };
  }
  let etapa = etapaData;
  if (!etapa && SLUG_ETAPA_HANDOFF.includes("-")) {
    const { data: etapaLegada, error: erroLegada } = await admin
      .from("crm_stages")
      .select("id, name, is_won, is_lost")
      .eq("pipeline_id", leadRow.pipeline_id)
      .eq("slug", SLUG_ETAPA_HANDOFF.replace(/-/g, "_"))
      .eq("is_archived", false)
      .maybeSingle();
    if (erroLegada) {
      logger.warn("[handoff-stage-move] leitura da etapa de handoff (slug legado) falhou", {
        lead_id: leadRow.id,
        organization_id: input.organizationId,
        error: erroLegada.message,
      });
      return { moveu: false, motivo: "indisponivel" };
    }
    if (etapaLegada) {
      etapa = etapaLegada;
    }
  }
  if (!etapa) {
    return { moveu: false, motivo: "sem_etapa_de_handoff" };
  }
  const etapaRow = etapa as {
    id: string;
    name: string;
    is_won?: boolean | null;
    is_lost?: boolean | null;
  };

  if (leadRow.stage_id === etapaRow.id) {
    return { moveu: false, motivo: "ja_esta_la" };
  }

  // ── A RÉGUA DE CAMPOS OBRIGATÓRIOS (issue #1536) ────────────────────────────
  //
  // O handoff também grava `stage_id`, então também passa pela régua — sem ela,
  // este seria um dos caminhos que movem sem exigir nada e "uma rota exige,
  // outra não" voltaria a ser o defeito da #917. A recusa segue o desenho do
  // resto do arquivo: o card não anda, `motivo` diz a verdade e `detalhe` leva
  // a frase com o que falta. O rastro é o warn DESTE módulo: o orquestrador
  // não lê o retorno.
  // Fail-open de `settingsDoFunil` vale aqui como em todos os caminhos.
  const settings = await settingsDoFunil(admin, leadRow.pipeline_id);
  const vereditoDeCampos = validaCamposExigidos({
    lead: leadRow as unknown as Record<string, unknown>,
    settingsDoFunil: settings,
    destino: {
      stageId: etapaRow.id,
      desfecho: etapaRow.is_won ? "won" : etapaRow.is_lost ? "lost" : null,
    },
  });
  if (vereditoDeCampos.faltando.length > 0) {
    const detalhe = recusaDeCamposObrigatorios(vereditoDeCampos.faltando, null).mensagem;
    // Nenhum chamador lê o retorno (só tratam exceção): este warn é o único rastro.
    logger.warn("[handoff-stage-move] etapa exige campos; card não movido", {
      lead_id: leadRow.id,
      organization_id: input.organizationId,
      detalhe,
    });
    return { moveu: false, motivo: "campos_obrigatorios", detalhe };
  }

  // Nome da origem só enfeita o texto da timeline — erro descartado de
  // propósito, mesmo raciocínio de `agent-stage-sync.ts`.
  const { data: origem } = await admin
    .from("crm_stages")
    .select("name")
    .eq("id", leadRow.stage_id)
    .maybeSingle();

  if (input.serviceBoundary) {
    if (input.serviceBoundary.organization_id !== input.organizationId || input.serviceBoundary.contact_id !== leadRow.contact_id) throw new StaleServiceBoundaryError();
    await assertServiceBoundarySupabase(admin, input.serviceBoundary);
  }
  const serviceOrigin = input.serviceBoundary
    ? { kind: "continuation" as const, boundary: input.serviceBoundary }
    : await observeServiceOrigin(admin, input.organizationId, leadRow.contact_id);
  const { data: atualizadas, error: erroUpdate } = await admin
    .from("crm_leads")
    .update({ stage_id: etapaRow.id })
    .eq("id", leadRow.id)
    // Trava otimista pelo estágio de ORIGEM: se um humano moveu o card entre a
    // leitura e a escrita, a decisão dele vence.
    .eq("stage_id", leadRow.stage_id)
    .select("id");
  if (erroUpdate) {
    logger.warn("[handoff-stage-move] update de stage_id falhou", {
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
    sourceModule: "ai",
    sourceId: leadRow.id,
    actor: { type: "webhook_source", id: "handoff-orchestrator" },
    reason: stageChangeReason((origem as { name: string } | null)?.name ?? null, etapaRow.name),
    payload: { motivo_do_handoff: input.reason, de: leadRow.stage_id, para: etapaRow.id },
  });
  if (!atividade.ok) {
    await registraFalhaDeAtividade(admin, {
      organizationId: input.organizationId,
      leadId: leadRow.id,
      tipo: "stage_changed",
      origem: "lib/leads/handoff-stage-move",
      erro: atividade.error,
    });
  }

  // Mesmo evento que `agent-stage-sync.ts` emite ao mover pelo agente — para
  // que regras de automação e follow-up que escutam `lead.stage_changed`
  // reajam igual, tenha o card se movido pela mão, pelo agente ou por handoff.
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
    p_metadata: { actor_kind: "system", source: "handoff-stage-move", motivo_do_handoff: input.reason },
    p_organization_id: input.organizationId,
  } as never);
  if (erroEvento) {
    logger.error("[handoff-stage-move] emit_event lead.stage_changed falhou", {
      lead_id: leadRow.id,
      organization_id: input.organizationId,
      error: (erroEvento as { message?: string }).message ?? String(erroEvento),
    });
  }

  return { moveu: true, motivo: "movido" };
}
