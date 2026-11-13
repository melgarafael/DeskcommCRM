/**
 * O DESTINO DO INTERESSE, CONFERIDO NO BANCO (Spec 25, R5b).
 *
 * Duas perguntas que a regra pura (`destino-do-interesse.ts`) não responde:
 *  - na hora de GRAVAR a instância: o funil e a etapa existem, são desta
 *    organização, estão ativos e a etapa é do funil?
 *  - na hora de CONSULTAR: como se chamam, e continuam válidos? (o dono pode ter
 *    arquivado o funil depois de configurar.)
 *
 * A organização vem SEMPRE de quem chama (sessão ou contexto do turno), nunca do
 * corpo. O cliente de serviço ignora a RLS, então o filtro é explícito aqui.
 *
 * "Ativo" quer dizer: funil não arquivado e etapa não arquivada, nem de ganho nem
 * de perda — o interesse nasce em andamento; uma etapa de encerramento fecharia o
 * negócio no instante em que ele abre.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { DestinoDoInteresse, NomesDoDestino } from "./destino-do-interesse";

/** Lê os nomes quando o destino é válido nesta organização; `null` quando não é. */
export async function nomesDoDestinoValido(
  admin: SupabaseClient,
  organizationId: string,
  destino: DestinoDoInteresse,
): Promise<NomesDoDestino | null> {
  const { data: funil } = await admin
    .from("crm_pipelines")
    .select("id, name")
    .eq("organization_id", organizationId)
    .eq("id", destino.pipeline_id)
    .eq("is_archived", false)
    .maybeSingle();
  if (!funil) return null;

  const { data: etapa } = await admin
    .from("crm_stages")
    .select("id, name")
    .eq("organization_id", organizationId)
    .eq("id", destino.stage_id)
    .eq("pipeline_id", destino.pipeline_id)
    .eq("is_archived", false)
    .eq("is_won", false)
    .eq("is_lost", false)
    .maybeSingle();
  if (!etapa) return null;

  return { funil: (funil as { name: string }).name, etapa: (etapa as { name: string }).name };
}

/**
 * Confere os destinos de TODAS as instâncias que vão ser gravadas. Devolve o
 * índice da primeira inválida (para a tela apontar qual), ou `null` quando todas
 * servem.
 */
export async function primeiroDestinoInvalido(
  admin: SupabaseClient,
  organizationId: string,
  instancias: readonly { destino_do_interesse?: DestinoDoInteresse | null }[],
): Promise<number | null> {
  for (let i = 0; i < instancias.length; i += 1) {
    const destino = instancias[i]!.destino_do_interesse;
    if (!destino) continue;
    if (!(await nomesDoDestinoValido(admin, organizationId, destino))) return i;
  }
  return null;
}
