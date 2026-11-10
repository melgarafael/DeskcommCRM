import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { traduzir } from "@/lib/i18n/dicionario";

/**
 * O convite amplia leitura e resposta, não a autoridade sobre o atendimento.
 * Reusa a régua anterior ao convite, que também protege fn_conversation_assign.
 * Assim a concessão nova não atravessa uma escrita feita com service role, e
 * quem já podia controlar a conversa mantém o comportamento distribuído.
 */
export async function exigirControleDaConversa(
  supabase: SupabaseClient,
  ctx: HandlerCtx,
  conversa: { assigned_to_user_id: string | null },
): Promise<void> {
  if (ctx.actor.type !== "user" || conversa.assigned_to_user_id === ctx.actor.id) return;
  const { data, error } = await supabase.rpc("fn_can_view_conversation", {
    p_org: ctx.organization_id,
    p_assigned_to_user_id: conversa.assigned_to_user_id,
  });
  if (error) throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
  if (data !== true) throw new ApiError(403, "forbidden", undefined, ctx.requestId,
    traduzir("O convite permite responder, sem mudar o responsável ou encerrar o atendimento.", ctx.idioma ?? "pt-BR"));
}
