/**
 * ENCERRAR A DEMANDA — o outro lado do invariante 4 da doutrina.
 *
 * "Nenhuma demanda aberta sem próximo passo definido e visível" tem duas saídas:
 * ou existe um próximo passo (o retorno agendado), ou existe um DESFECHO
 * registrado. Sem a segunda, o anti-morte fica pela metade — negócios que já
 * acabaram continuam contando como demanda viva, sujam o radar de risco e
 * empurram o operador a resgatar o que ninguém precisa resgatar.
 *
 * ⚠️ ESTE MÓDULO NASCEU DE UMA EXTRAÇÃO, não de código novo. A regra vivia
 * duplicada dentro de `app/api/v1/leads/[id]/win/route.ts` e `.../lose/route.ts`,
 * e a capacidade da IA precisava da MESMA regra. Reimplementá-la faria a IA e o
 * humano encerrarem por critérios diferentes — o sistema mentiria para um dos
 * dois sobre o que "fechado" significa.
 *
 * O que a extração corrigiu de caminho: encerrar NÃO gerava linha na timeline.
 * Ganhar ou perder um negócio é o acontecimento mais importante da vida dele, e
 * só existia em `event_log` e `api_audit_log` — nenhum dos dois aparece na tela.
 * O dossiê de um negócio fechado terminava sem dizer que fechou.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor, HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { traduzir } from "@/lib/i18n/dicionario";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import {
  recusaDeCamposObrigatorios,
  recusaDeMotivoDoGanho,
  settingsDoFunil,
  validaCamposExigidos,
} from "@/lib/leads/campos-exigidos";
import { recusaDeMotivoDaPerdaPeloBanco } from "@/lib/leads/motivo-da-perda";

/** Como a demanda terminou. Não há terceira: encerrar é ganhar ou perder. */
export type DesfechoDaDemanda = "won" | "lost";

export interface EncerraDemandaInput {
  leadId: string;
  desfecho: DesfechoDaDemanda;
  /**
   * OBRIGATÓRIO em `lost` (P-03): perder sem motivo não ensina nada a ninguém.
   * Em `won` é o MOTIVO DE GANHO (issue #1536): vai para `crm_leads.won_reason`
   * na mesma escrita, é texto livre quando o funil não tem lista e passa a ser
   * exigido quando `settings.won_reason_required` está ligado.
   */
  motivo?: string | null;
  /**
   * A razão da linha na timeline, quando o desfecho padrão ("Ganho" /
   * "Perdido — <motivo>") diria algo FALSO a quem lê. Hoje só a troca de funil a
   * usa: a origem fecha como perda porque é o único desfecho que o schema oferece
   * para "saiu daqui", e "Perdido — other" num negócio que foi levado para outro
   * funil é uma perda que não aconteceu. O motivo continua gravado na coluna e
   * no audit; só a frase da tela muda.
   */
  razaoNaTimeline?: string;
  /** Acrescentado ao `payload` da linha (ex.: para onde o negócio foi). */
  payloadNaTimeline?: Record<string, unknown>;
}

export interface DemandaEncerrada {
  lead: Record<string, unknown>;
  /** `true` = já estava no desfecho pedido; nada foi alterado (idempotente). */
  jaEstava: boolean;
}

function actorAuditPayload(actor: Actor): {
  actorUserId: string | null;
  metadataActor: Record<string, unknown>;
} {
  if (actor.type === "user") {
    return { actorUserId: actor.id, metadataActor: { actor_type: "user" } };
  }
  return {
    actorUserId: null,
    metadataActor: { actor_type: actor.type, actor_id: actor.id },
  };
}

/**
 * Fecha o negócio movendo-o para o estágio terminal do funil.
 *
 * ⚠️ SEM TRAVA OTIMISTA, de propósito (o comportamento que já existia): encerrar
 * é intenção explícita, e recusar porque o card se mexeu entre o clique e o
 * commit obrigaria a pessoa a repetir uma decisão que ela já tomou. O `status` e
 * o `closed_at` são do trigger `fn_crm_lead_close_on_stage` — não se escreve
 * status à mão aqui, senão passa a haver duas fontes para a mesma verdade.
 *
 * ⚠️ FILTRA `organization_id` EXPLICITAMENTE. As rotas originais confiavam só na
 * RLS do client do usuário; a capacidade da IA usa client service-role, que
 * bypassa RLS. Uma função compartilhada que dependesse da RLS do chamador seria
 * segura numa porta e aberta na outra.
 */
export async function encerraDemanda(
  supabase: SupabaseClient,
  ctx: HandlerCtx,
  input: EncerraDemandaInput,
): Promise<DemandaEncerrada> {
  if (input.desfecho === "lost" && !input.motivo?.trim()) {
    throw new ApiError(
      422,
      "validation_failed",
      undefined,
      ctx.requestId,
      traduzir("Informe o motivo da perda.", ctx.idioma ?? "pt-BR"),
    );
  }

  const { data: lead, error: selErr } = await supabase
    .from("crm_leads")
    .select("*")
    .eq("id", input.leadId)
    .eq("organization_id", ctx.organization_id)
    .maybeSingle();

  if (selErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, selErr.message);
  }
  if (!lead) {
    throw new ApiError(
      404,
      "not_found",
      undefined,
      ctx.requestId,
      traduzir("Lead não encontrado.", ctx.idioma ?? "pt-BR"),
    );
  }

  if ((lead as { status: string }).status === input.desfecho) {
    return { lead: lead as Record<string, unknown>, jaEstava: true };
  }

  const colunaTerminal = input.desfecho === "won" ? "is_won" : "is_lost";
  const { data: stage, error: stErr } = await supabase
    .from("crm_stages")
    .select("id, name")
    .eq("organization_id", ctx.organization_id)
    .eq("pipeline_id", (lead as { pipeline_id: string }).pipeline_id)
    .eq(colunaTerminal, true)
    .eq("is_archived", false)
    .order("position", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (stErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, stErr.message);
  }
  if (!stage) {
    throw new ApiError(
      422,
      input.desfecho === "won" ? "pipeline_no_won_stage" : "pipeline_no_lost_stage",
      undefined,
      ctx.requestId,
      traduzir(
        input.desfecho === "won"
          ? "Pipeline não tem stage de fechamento como ganho."
          : "Pipeline não tem stage de fechamento como perda.",
        ctx.idioma ?? "pt-BR",
      ),
    );
  }

  const terminalStageId = (stage as { id: string }).id;
  const { data: maxPosition, error: maxPositionErr } = await supabase
    .from("crm_leads")
    .select("position_in_stage")
    .eq("organization_id", ctx.organization_id)
    .eq("stage_id", terminalStageId)
    .order("position_in_stage", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (maxPositionErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, maxPositionErr.message);
  }

  // ── OS CAMPOS OBRIGATÓRIOS E O MOTIVO DE GANHO (issue #1536) ────────────────
  //
  // Esta função é o fecho compartilhado: botão "Marcar como ganho/perdido",
  // `/win`, `/lose`, a origem do clone, `crm_close_demand` (MCP) e a ação
  // `create_or_move_lead`. Validar AQUI é o que cobre cinco dos seis caminhos da
  // issue com uma decisão só — e ela precisa vir ANTES do update, porque depois
  // dele o que existe é a linha gravada.
  //
  // O motivo de ganho entra como `faltando` (chave `won_reason`) quando o funil
  // pede e não veio: o MESMO contrato de `{chave, rotulo}` que a tela já sabe
  // dialogar, em vez de um código paralelo que a tela teria de tratar à parte.
  const settings = await settingsDoFunil(
    supabase,
    (lead as { pipeline_id: string }).pipeline_id,
  );
  const vereditoDeCampos = validaCamposExigidos({
    lead: lead as Record<string, unknown>,
    settingsDoFunil: settings,
    destino: { stageId: stage.id, desfecho: input.desfecho },
    motivoDeGanho: input.desfecho === "won" ? input.motivo ?? null : null,
  });
  if (vereditoDeCampos.faltando.length > 0) {
    const recusa = recusaDeCamposObrigatorios(
      vereditoDeCampos.faltando,
      ctx.idioma,
    );
    throw new ApiError(
      422,
      recusa.codigo,
      { faltando: vereditoDeCampos.faltando },
      ctx.requestId,
      recusa.mensagem,
    );
  }
  // Sem lista cadastrada o motivo de ganho é texto livre; com lista, só o que
  // está nela passa — quem aplica é o servidor, porque para o GANHO não há
  // trigger no banco (a CHECK da perda é `crm_leads_lost_reason_required`).
  if (input.desfecho === "won") {
    const recusaGanho = recusaDeMotivoDoGanho({
      motivo: input.motivo,
      settingsDoFunil: settings,
      idioma: ctx.idioma,
    });
    if (recusaGanho) {
      throw new ApiError(
        422,
        recusaGanho.codigo,
        undefined,
        ctx.requestId,
        recusaGanho.mensagem,
      );
    }
  }

  const nextPosition =
    maxPosition?.position_in_stage === null || maxPosition?.position_in_stage === undefined
      ? 1000
      : Number(maxPosition.position_in_stage) + 1000;
  const patch: Record<string, unknown> = {
    stage_id: terminalStageId,
    position_in_stage: nextPosition,
    updated_at: new Date().toISOString(),
  };
  if (input.desfecho === "lost") patch.lost_reason = input.motivo;
  // O ganho espelha a perda na MESMA escrita: `won_reason` só entra quando há
  // motivo (a coluna é nullable e sem CHECK — a obrigatoriedade é do funil,
  // decidida acima, nunca do banco).
  if (input.desfecho === "won" && input.motivo?.trim()) {
    patch.won_reason = input.motivo.trim();
  }

  const { error: updErr } = await supabase
    .from("crm_leads")
    .update(patch)
    .eq("id", input.leadId)
    .eq("organization_id", ctx.organization_id);

  if (updErr) {
    // Rede de segurança (#917) — mesma dos outros três caminhos (arrasto, lote,
    // agente): a recusa do banco por motivo da perda (fora do vocabulário do
    // funil) vira recusa de negócio (422 lost_reason_invalid), nunca 500. Sem
    // isto, TODO chamador desta função devolvia o erro cru do Postgres — e são
    // cinco: `/lose` e `/win` (as rotas humanas), `/leads/[id]/clone` (encerra a
    // origem), a automação (`create-or-move-lead.ts`) e a capacidade de
    // encerramento da IA (`lib/mcp/tools/retencao.ts`).
    const recusa = recusaDeMotivoDaPerdaPeloBanco(updErr, ctx.idioma);
    if (recusa) {
      throw new ApiError(422, recusa.codigo, undefined, ctx.requestId, recusa.mensagem);
    }
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, updErr.message);
  }

  const { data: fresh } = await supabase
    .from("crm_leads")
    .select("*")
    .eq("id", input.leadId)
    .eq("organization_id", ctx.organization_id)
    .maybeSingle();
  const finalLead = (fresh ?? lead) as Record<string, unknown>;

  // `fn_crm_lead_close_on_stage` atualiza o status e o trigger de eventos grava
  // lead.won/lead.lost no event_log. Não emitir novamente via emit_event aqui:
  // event_log não possui chave idempotente e isso duplicaria notificações.
  const a = actorAuditPayload(ctx.actor);
  const eventType = input.desfecho === "won" ? "lead.won" : "lead.lost";

  // A LINHA NA TIMELINE — o que faltava. `reason` nomeia o desfecho e, na perda,
  // carrega o motivo, que é justamente o que muda a decisão de quem lê depois
  // ("perdemos por preço" e "perdemos por prazo" pedem coisas diferentes).
  const atividade = await emitLeadActivity(supabase, {
    organizationId: ctx.organization_id,
    leadId: input.leadId,
    contactId: (finalLead as { contact_id?: string | null }).contact_id ?? null,
    type: "demand_closed",
    sourceModule: "crm",
    sourceId: input.leadId,
    actor: ctx.actor,
    // O rótulo do tipo já diz "Demanda encerrada" na tela; o reason acrescenta o
    // DESFECHO e, na perda, o motivo — repetir o rótulo aqui deixaria a linha
    // com a mesma frase duas vezes (ver `motivoLegivel` em retorno-crm.ts).
    // Canônico em português: quem traduz é a LEITURA (`t(item.reason)`). Ver o
    // bloco "vocabulario de dominio persistido" em `lib/i18n/dicionario.ts`.
    reason:
      input.razaoNaTimeline ??
      (input.desfecho === "won" ? "Ganho" : `Perdido — ${input.motivo}`),
    payload: {
      ...(input.payloadNaTimeline ?? {}),
      desfecho: input.desfecho,
      from_stage_id: (lead as { stage_id: string }).stage_id,
      to_stage_id: (stage as { id: string }).id,
    },
  });
  if (!atividade.ok) {
    // Falha BAIXO: o negócio já fechou e prender o desfecho à timeline deixaria a
    // operação refém do registro. Mas a perda é CONTADA — nunca engolida.
    await registraFalhaDeAtividade(supabase, {
      organizationId: ctx.organization_id,
      leadId: input.leadId,
      tipo: "demand_closed",
      origem: "lib/leads/encerramento.encerraDemanda",
      erro: atividade.error,
      requestId: ctx.requestId,
    });
  }

  await audit({
    action: eventType,
    actorUserId: a.actorUserId,
    organizationId: ctx.organization_id,
    resourceType: "crm_lead",
    resourceId: input.leadId,
    requestId: ctx.requestId,
    metadata: {
      ...a.metadataActor,
      from_stage_id: (lead as { stage_id: string }).stage_id,
      to_stage_id: (stage as { id: string }).id,
      ...(input.desfecho === "lost" ? { lost_reason: input.motivo } : {}),
      ...(input.desfecho === "won" && input.motivo?.trim()
        ? { won_reason: input.motivo.trim() }
        : {}),
    },
  });

  return { lead: finalLead, jaEstava: false };
}
