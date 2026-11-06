/**
 * O percentual de comissão que vale AGORA para um item que vai entrar numa comanda.
 *
 * Toda porta que grava `sale_items` resolve por aqui. `fn_finalizar_comanda` não
 * consulta `commission_rules` (o percentual é congelado na inclusão), então uma
 * porta que esquece este passo grava 0% e ninguém vê.
 *
 * Só regra em vigor (`is_active`): a inativa fica na tabela para explicar comanda
 * antiga e não pode participar da conta de hoje.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { percentualDaComissao } from "./comanda";

export async function percentualDoItem(
  supabase: SupabaseClient,
  organizationId: string,
  alvo: { attendantUserId: string | null; eventTypeId: string | null },
): Promise<number> {
  if (!alvo.attendantUserId && !alvo.eventTypeId) return 0;

  const { data } = await supabase
    .from("commission_rules")
    .select("attendant_user_id, event_type_id, percent")
    .eq("organization_id", organizationId)
    .eq("is_active", true);

  return percentualDaComissao(data ?? [], alvo);
}
