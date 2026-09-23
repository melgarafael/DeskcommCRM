import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/leads/[id]/clone — levar o negócio para OUTRO funil.
 *
 * É o caminho que a P-01 manda usar quando o alvo é outro funil: `/move` recusa
 * (422 `pipeline_immutable_use_clone`) e aponta para cá. Antes desta rota o
 * apontamento não existia em lugar nenhum do produto.
 *
 * A troca são DUAS escritas, nesta ordem de propósito:
 *  1. cria o clone no funil destino (via `createLeadHandler` — a MESMA porta da
 *     criação normal: valida etapa↔funil, calcula posição, aplica a regra de dono,
 *     emite `lead.created` e grava audit);
 *  2. encerra a origem via `encerraDemanda` com motivo canônico (P-03).
 *
 * A ordem é "clone primeiro" porque o banco não tem transação entre as duas: se a
 * segunda falhar, existe um negócio a mais no funil destino (visível, corrigível)
 * e a origem continua aberta. Na ordem inversa, uma falha na criação deixaria a
 * origem PERDIDA e sem sucessor — o operador perderia o negócio sem ver para onde
 * ele foi. A rota devolve 500 nesse caso, sem esconder a meia-execução.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { createLeadHandler } from "@/app/api/v1/leads/_handler";
import { listPipelinesHandler } from "@/app/api/v1/pipelines/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  FUNIL_DE_DESTINO_NAO_ENCONTRADO,
  ORIGEM_SEM_ETAPA_DE_PERDA,
  escolheEtapaDeDestino,
  montaPayloadDoClone,
  recusaTrocaDeFunil,
  registroDoDestino,
  type EtapaDoFunil,
  type OrigemParaClonar,
} from "@/lib/leads/clonar-para-funil";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import { encerraDemanda } from "@/lib/leads/encerramento";
import {
  motivoDaPerdaDaOrigem,
  recusaDeMotivoForaDoVocabulario,
} from "@/lib/leads/motivo-da-perda";
import { cloneLeadSchema, validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/leads/[id]/clone — para ONDE este negócio pode ir.
 *
 * Exceção deliberada e MÍNIMA à matriz spec 13 §4 (pipelines read = manager+,
 * `GET /api/v1/pipelines`): quem vai clicar em "Levar para outro funil" precisa
 * escolher o destino, e `pipeline.move_card` (a MESMA permissão que já autoriza
 * o POST abaixo) já é `agent`+ — negar a leitura aqui só empurraria o mesmo dado
 * por um caminho sem gate nenhum. Payload mínimo: `id` e `name`, nunca
 * `settings`/`description` (isso é configuração, fica atrás de `manager` na rota
 * de gestão). O funil ATUAL do lead sai da lista — não é destino válido de troca
 * (a mesma regra de `recusaTrocaDeFunil`, medida aqui em vez de deixar a tela
 * descobrir só ao tentar).
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  const supabase = await createClient();
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const { data: origem, error: selErr } = await supabase
    .from("crm_leads")
    .select("id, pipeline_id")
    .eq("id", leadId)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (selErr) return fail("internal_error", selErr.message, 500, { requestId });
  if (!origem) return fail("not_found", t("Lead não encontrado."), 404, { requestId });

  const { pipelines } = await listPipelinesHandler(supabase, {
    organization_id: authz.org.orgId,
    actor: { type: "user", id: authz.user.id },
    requestId,
  });

  const destinos = pipelines
    .filter((p) => p.id !== (origem as { pipeline_id: string }).pipeline_id)
    .map((p) => ({ id: p.id, name: p.name }));

  return ok({ pipelines: destinos }, { requestId });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  const supabase = await createClient();
  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const handlerCtx: HandlerCtx = {
    organization_id: authz.org.orgId,
    actor: { type: "user", id: authz.user.id },
    requestId,
    idioma: authz.user.idioma,
  };

  try {
    const input = await validateRequest(cloneLeadSchema, req);

    // Filtro por organização explícito como defesa em profundidade: a RLS já
    // recorta o client do usuário, e o filtro continua valendo se esta rota um
    // dia passar a receber um client service-role (é o que o `_handler` faz).
    const { data: origem, error: selErr } = await supabase
      .from("crm_leads")
      .select("*")
      .eq("id", leadId)
      .eq("organization_id", handlerCtx.organization_id)
      .maybeSingle();

    if (selErr) {
      return fail("internal_error", selErr.message, 500, { requestId });
    }
    if (!origem) {
      return fail("not_found", t("Lead não encontrado."), 404, { requestId });
    }

    const { data: pipelineDestino, error: pipeErr } = await supabase
      .from("crm_pipelines")
      .select("id, name")
      .eq("id", input.pipeline_id)
      .eq("organization_id", handlerCtx.organization_id)
      .maybeSingle();

    if (pipeErr) {
      return fail("internal_error", pipeErr.message, 500, { requestId });
    }
    if (!pipelineDestino) {
      return fail("pipeline_not_found", t(FUNIL_DE_DESTINO_NAO_ENCONTRADO), 404, { requestId });
    }

    const recusa = recusaTrocaDeFunil(origem as OrigemParaClonar, input.pipeline_id);
    if (recusa) {
      return fail(recusa.code, t(recusa.texto), recusa.status, { requestId });
    }

    // ── O MOTIVO DO CHAMADOR SE CONFERE ANTES DA PRIMEIRA ESCRITA ─────────────
    //
    // `lost_reason` chega do chamador como string livre (cloneLeadSchema só exige
    // não-vazia), e quem o recusa é `fn_validate_lost_reason_required` — no
    // encerramento da ORIGEM, que acontece DEPOIS de `createLeadHandler`. Nessa
    // ordem, `{"lost_reason": "mudou de funil"}` produzia 500 com o clone já
    // criado no destino e a origem ainda aberta: o negócio duplicado, e a
    // resposta dizendo que algo quebrou em vez de dizer o que fazer.
    //
    // O vocabulário é o do funil de ORIGEM porque é a linha da origem que fecha,
    // e o trigger lê `new.pipeline_id` (supabase/baseline.sql).
    const { data: pipelineOrigem, error: origemPipeErr } = await supabase
      .from("crm_pipelines")
      .select("settings, name")
      .eq("id", (origem as OrigemParaClonar).pipeline_id)
      .eq("organization_id", handlerCtx.organization_id)
      .maybeSingle();

    if (origemPipeErr) {
      return fail("internal_error", origemPipeErr.message, 500, { requestId });
    }
    const motivoRecusado = recusaDeMotivoForaDoVocabulario({
      motivo: input.lost_reason,
      settingsDoFunil: (pipelineOrigem as { settings?: unknown } | null)?.settings ?? null,
      idioma: authz.user.idioma,
    });
    if (motivoRecusado) {
      return fail(motivoRecusado.codigo, motivoRecusado.mensagem, 422, { requestId });
    }

    const { data: etapas, error: stagesErr } = await supabase
      .from("crm_stages")
      .select("id, pipeline_id, position, is_won, is_lost, is_archived")
      .eq("organization_id", handlerCtx.organization_id)
      .eq("pipeline_id", input.pipeline_id)
      .eq("is_archived", false)
      .order("position", { ascending: true });

    if (stagesErr) {
      return fail("internal_error", stagesErr.message, 500, { requestId });
    }

    const destino = escolheEtapaDeDestino(
      (etapas ?? []) as EtapaDoFunil[],
      input.stage_id ?? null,
    );
    if (!destino.ok) {
      return fail(destino.code, t(destino.texto), destino.status, { requestId });
    }

    // ── A ORIGEM PRECISA TER ONDE FECHAR, E ISSO SE PERGUNTA ANTES ─────────────
    //
    // `encerraDemanda` recusa com 422 `pipeline_no_lost_stage` quando o funil de
    // ORIGEM não tem etapa de perda não arquivada — e ele roda DEPOIS da criação
    // do clone. Nessa ordem o operador lia uma recusa de pedido ("nada mudou")
    // com o negócio JÁ duplicado no funil de destino: o pior dos dois mundos,
    // porque a meia-execução fica invisível.
    //
    // O estado é alcançável e o próprio repo o reconhece (lib/pipelines/
    // pipeline-editing.ts cita o espelho deste caso no `/win`). A pergunta é
    // barata e não tem corrida que importe: se alguém arquivar a etapa entre esta
    // consulta e o encerramento, o 422 volta a acontecer — mas aí ele é honesto,
    // e a ordem "clone primeiro" continua sendo a certa pelo motivo do cabeçalho.
    const { data: etapaDePerdaDaOrigem, error: perdaErr } = await supabase
      .from("crm_stages")
      .select("id")
      .eq("organization_id", handlerCtx.organization_id)
      .eq("pipeline_id", (origem as OrigemParaClonar).pipeline_id)
      .eq("is_lost", true)
      .eq("is_archived", false)
      .limit(1)
      .maybeSingle();

    if (perdaErr) {
      return fail("internal_error", perdaErr.message, 500, { requestId });
    }
    if (!etapaDePerdaDaOrigem) {
      return fail(
        "pipeline_no_lost_stage",
        t(ORIGEM_SEM_ETAPA_DE_PERDA),
        422,
        { requestId },
      );
    }

    const clone = await createLeadHandler(
      supabase,
      handlerCtx,
      montaPayloadDoClone(origem as OrigemParaClonar, destino.etapa),
    );

    const destination = registroDoDestino(clone);
    const nomeDoFunilDeOrigem = (pipelineOrigem as { name?: string | null } | null)?.name ?? null;
    const nomeDoFunilDeDestino = (pipelineDestino as { name?: string | null }).name ?? null;

    // ── A TROCA NA LINHA DO TEMPO, DOS DOIS LADOS ──────────────────────────────
    //
    // `source_metadata` guarda os ponteiros, mas nenhuma tela o lê — a linha do
    // tempo do dossiê vem de `crm_lead_activities` (hooks/leads/useLeadTimeline.ts).
    // Sem estas linhas o negócio novo aparecia no destino sem história nenhuma, e
    // a origem dizia "Perdido — other" para um negócio que não se perdeu.
    // Os nomes dos funis entram na frase como entram os das etapas em
    // `stageChangeReason`: é o que quem lê reconhece.
    const atividadeDoClone = await emitLeadActivity(supabase, {
      organizationId: handlerCtx.organization_id,
      leadId: String(destination.lead_id),
      contactId: (origem as OrigemParaClonar).contact_id ?? null,
      type: "moved_from_pipeline",
      sourceModule: "crm",
      sourceId: leadId,
      actor: handlerCtx.actor,
      reason: nomeDoFunilDeOrigem ? `Veio do funil ${nomeDoFunilDeOrigem}` : "Veio de outro funil",
      payload: {
        from_pipeline_id: (origem as OrigemParaClonar).pipeline_id,
        from_lead_id: leadId,
      },
    });
    if (!atividadeDoClone.ok) {
      // Falha BAIXO, como em `encerraDemanda`: o clone já existe, e prender a
      // troca à timeline deixaria a operação refém do registro. Contada, nunca
      // engolida.
      await registraFalhaDeAtividade(supabase, {
        organizationId: handlerCtx.organization_id,
        leadId: String(destination.lead_id),
        tipo: "moved_from_pipeline",
        origem: "app/api/v1/leads/[id]/clone",
        erro: atividadeDoClone.error,
        requestId,
      });
    }

    const motivo = motivoDaPerdaDaOrigem(input.lost_reason);
    const { lead: origemEncerrada } = await encerraDemanda(supabase, handlerCtx, {
      leadId,
      desfecho: "lost",
      motivo,
      razaoNaTimeline: nomeDoFunilDeDestino
        ? `Levado para o funil ${nomeDoFunilDeDestino}`
        : "Levado para outro funil",
      payloadNaTimeline: {
        to_pipeline_id: input.pipeline_id,
        to_lead_id: destination.lead_id,
      },
    });

    // Onde a origem foi parar. Fica na ORIGEM porque o clone já carrega
    // `clonado_de`: cada lado guarda o ponteiro para o outro. É o dado para quem
    // integra pela API; para o operador na tela, a história são as duas linhas
    // de timeline gravadas acima.
    const sourceMetadata = {
      ...(((origem as OrigemParaClonar).source_metadata ?? {}) as Record<string, unknown>),
      movido_para: destination,
    };

    const { data: origemFinal, error: updErr } = await supabase
      .from("crm_leads")
      .update({ source_metadata: sourceMetadata, updated_at: new Date().toISOString() })
      .eq("id", leadId)
      .eq("organization_id", handlerCtx.organization_id)
      .select("*")
      .maybeSingle();

    if (updErr) {
      return fail("internal_error", updErr.message, 500, { requestId });
    }

    await audit({
      action: "lead.moved_to_pipeline",
      actorUserId: authz.user.id,
      organizationId: handlerCtx.organization_id,
      resourceType: "crm_lead",
      resourceId: leadId,
      requestId,
      metadata: {
        actor_type: "user",
        from_pipeline_id: (origem as OrigemParaClonar).pipeline_id,
        to_pipeline_id: input.pipeline_id,
        to_stage_id: destino.etapa.id,
        cloned_lead_id: destination.lead_id,
        lost_reason: motivo,
      },
    });

    // 201 e não 200: a rota CRIA um recurso, como `POST /api/v1/leads`
    // (app/api/v1/leads/route.ts). Duas criações irmãs com códigos diferentes
    // fazem quem integra tratar cada uma de um jeito sem que nada justifique.
    return ok(
      {
        lead: clone,
        origem: origemFinal ?? origemEncerrada,
      },
      { requestId, status: 201 },
    );
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }
}
