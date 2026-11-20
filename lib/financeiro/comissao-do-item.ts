/**
 * Resolve the current commission rate before freezing it on a sale item.
 *
 * Every writer of `sale_items` uses this lookup. `fn_finalizar_comanda` does
 * not read the rules again, so a failed lookup must remain a failure rather
 * than being frozen as a legitimate zero-percent commission.
 *
 * Inactive rules explain historical sales and do not affect new items.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { percentualDaComissao } from "./comanda";

type ResultadoDaComissao = { ok: true; percent: number } | { ok: false; error: string };

export async function percentualDoItem(
  supabase: SupabaseClient,
  organizationId: string,
  alvo: { attendantUserId: string | null; eventTypeId: string | null },
): Promise<ResultadoDaComissao> {
  if (!alvo.attendantUserId && !alvo.eventTypeId) return { ok: true, percent: 0 };

  const { data, error } = await supabase
    .from("commission_rules")
    .select("attendant_user_id, event_type_id, percent")
    .eq("organization_id", organizationId)
    .eq("is_active", true);

  if (error) return { ok: false, error: error.message };
  return { ok: true, percent: percentualDaComissao(data ?? [], alvo) };
}
