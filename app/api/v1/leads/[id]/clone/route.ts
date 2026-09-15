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
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  escolheEtapaDeDestino,
  montaPayloadDoClone,
  motivoDaPerdaDaOrigem,
  recusaTrocaDeFunil,
  registroDoDestino,
  type EtapaDoFunil,
  type OrigemParaClonar,
} from "@/lib/leads/clonar-para-funil";
import { encerraDemanda } from "@/lib/leads/encerramento";
import { cloneLeadSchema, validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

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

    // ⚠️ Filtro por organização explícito: pelo MCP o client é service-role e a
    // RLS não vale — sem ele a troca atravessaria tenants.
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
      .select("id")
      .eq("id", input.pipeline_id)
      .eq("organization_id", handlerCtx.organization_id)
      .maybeSingle();

    if (pipeErr) {
      return fail("internal_error", pipeErr.message, 500, { requestId });
    }
    if (!pipelineDestino) {
      return fail("pipeline_not_found", t("Funil de destino não encontrado."), 404, { requestId });
    }

    const recusa = recusaTrocaDeFunil(origem as OrigemParaClonar, input.pipeline_id);
    if (recusa) {
      return fail(recusa.code, t(recusa.texto), recusa.status, { requestId });
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

    const clone = await createLeadHandler(
      supabase,
      handlerCtx,
      montaPayloadDoClone(origem as OrigemParaClonar, destino.etapa),
    );

    const motivo = motivoDaPerdaDaOrigem(input.lost_reason);
    const { lead: origemEncerrada } = await encerraDemanda(supabase, handlerCtx, {
      leadId,
      desfecho: "lost",
      motivo,
    });

    // Onde a origem foi parar. Fica na ORIGEM porque o clone já carrega
    // `clonado_de`; juntos os dois lados contam a mesma história na timeline.
    const destination = registroDoDestino(clone);
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

    return ok(
      {
        lead: clone,
        origem: origemFinal ?? origemEncerrada,
      },
      { requestId },
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
