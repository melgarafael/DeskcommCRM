import type { SupabaseClient } from "@supabase/supabase-js";

export interface LinhaDeClique {
  id: string;
  firstMessageId: string;
  capturedAt: string;
  status: string;
  reason: string | null;
  eventId: string;
  attemptedAt: string | null;
}

/** Leitura server-only, explicitamente limitada ao tenant e aos 20 cliques recentes. */
export async function lerHistoricoDeCliques(
  admin: SupabaseClient,
  organizationId: string,
): Promise<LinhaDeClique[]> {
  const { data, error } = await admin
    .from("meta_ctwa_click_dispatches")
    .select("id,first_message_id,captured_at,status,reason,event_id,attempted_at")
    .eq("organization_id", organizationId)
    .order("captured_at", { ascending: false })
    .limit(20);
  if (error) throw new Error("Não foi possível ler o histórico de cliques.");
  return (data ?? []).map((row) => ({
    id: row.id,
    firstMessageId: row.first_message_id,
    capturedAt: row.captured_at,
    status: row.status,
    reason: row.reason,
    eventId: row.event_id,
    attemptedAt: row.attempted_at,
  }));
}
