import type { SupabaseClient } from "@supabase/supabase-js";

import type { HandlerCtx } from "@/lib/api/handlers/types";
import { createLeadHandler } from "@/app/api/v1/leads/_handler";
import {
  escolheEtapaDeDestino,
  type EtapaDoFunil,
  type OrigemParaClonar,
} from "@/lib/leads/clonar-para-funil";

/**
 * Abre um SEGUNDO negócio do mesmo cliente em outro funil, sem tocar no de
 * origem — o contrário de `transfereParaOFunil`, que clona e ENCERRA a origem.
 *
 * É o caso de dois produtos distintos (consórcio e investimentos): o cliente
 * que já tem negócio num produto e passa a falar do outro não troca de funil,
 * ele ganha um card a mais.
 *
 * Só leva a IDENTIDADE do negócio de origem (título, contato e quem o trouxe).
 * Etiquetas, campos personalizados, valor e dono ficam para trás de propósito:
 * descrevem o OUTRO produto (`conta-nova` num card de consórcio seria mentira) e
 * o dono de um funil não é, por herança, o do outro.
 *
 * Devolve o erro em vez de lançar, como `transfereParaOFunil`; a exceção é a
 * régua de campos obrigatórios da etapa de destino (422 `required_fields_missing`
 * de `createLeadHandler`), que sobe intacta para o chamador tratar igual.
 */
export async function abreCardAdicionalNoFunil(
  admin: SupabaseClient,
  organizationId: string,
  handlerCtx: HandlerCtx,
  origem: OrigemParaClonar,
  pipelineId: string,
  stageId: string | null,
): Promise<{ ok: true; card: Record<string, unknown> } | { ok: false; error: string }> {
  const { data: etapas, error: etapasErr } = await admin
    .from("crm_stages")
    .select("id, pipeline_id, position, is_won, is_lost, is_archived")
    .eq("organization_id", organizationId)
    .eq("pipeline_id", pipelineId)
    .eq("is_archived", false)
    .order("position", { ascending: true });
  if (etapasErr) return { ok: false, error: etapasErr.message };

  const destino = escolheEtapaDeDestino((etapas ?? []) as EtapaDoFunil[], stageId);
  if (!destino.ok) return { ok: false, error: destino.code };

  const card = await createLeadHandler(admin, handlerCtx, {
    pipeline_id: destino.etapa.pipeline_id,
    stage_id: destino.etapa.id,
    title: origem.title,
    contact_id: origem.contact_id ?? null,
    source: origem.source ?? "manual",
    // Vazio de propósito: as etiquetas da origem descrevem o OUTRO produto.
    tags: [],
    source_metadata: {
      aberto_ao_lado_de: { lead_id: origem.id, pipeline_id: origem.pipeline_id },
    },
  });

  return { ok: true, card: card as unknown as Record<string, unknown> };
}
