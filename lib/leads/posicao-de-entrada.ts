import type { SupabaseClient } from "@supabase/supabase-js";

import { posicaoDeEntradaNaEtapa } from "@/lib/kanban/entrada-na-etapa";
import { logger } from "@/lib/logger";

/**
 * A posição de quem CHEGA à etapa pelos movimentos automáticos (espelho de
 * etapa do agente, agendamento, transferência para humano) — o TOPO, a mesma
 * régua da criação, do move sem posição e do encerramento (#3461).
 *
 * Esses caminhos trocavam só `stage_id` e o card levava a posição que tinha na
 * etapa de ORIGEM: caía num ponto qualquer da coluna de destino.
 *
 * Sem a leitura (erro do banco), devolve `null` e quem chama move do mesmo
 * jeito, sem posição: a ordem na coluna é cosmética, e desfazer um movimento
 * por causa dela seria pior.
 */
export async function lerPosicaoDeEntrada(
  admin: SupabaseClient,
  organizationId: string,
  stageId: string,
): Promise<number | null> {
  const { data, error } = await admin
    .from("crm_leads")
    .select("position_in_stage")
    .eq("organization_id", organizationId)
    .eq("stage_id", stageId)
    .order("position_in_stage", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    logger.warn("[posicao-de-entrada] leitura do topo da etapa falhou; move sem posição", {
      organization_id: organizationId,
      stage_id: stageId,
      erro: error.message,
    });
    return null;
  }
  const primeira = (data as { position_in_stage?: number | string | null } | null)?.position_in_stage;
  return posicaoDeEntradaNaEtapa(primeira == null ? null : Number(primeira));
}
