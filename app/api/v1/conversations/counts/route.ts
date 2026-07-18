/**
 * GET /api/v1/conversations/counts — contagens por visão do inbox (G4-02).
 *
 * Usa o client user-scoped (cookie session) → toda contagem HERDA a RLS de
 * SELECT de `conversations` (fn_can_view_conversation, migration 0035). Um agent
 * em modo own* recebe a contagem do SEU escopo, NUNCA o total da org — a mesma
 * garantia do listing. Head count (count:'exact', head:true) não devolve linhas.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();

  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const authUser = await loadAuthUser();
  const activeOrg = authUser ? await resolveActiveOrg(authUser) : null;
  if (!activeOrg) {
    return fail("no_active_org", "No active organization.", 403, { requestId });
  }

  const org = activeOrg.orgId;
  const countExact = () =>
    supabase
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", org);

  // Espelha tabToFilter (InboxLayout): unassigned = fila aberta sem dono;
  // mine = atribuídas a mim; all = tudo que o usuário VÊ (RLS-scoped).
  const [unassigned, mine, all] = await Promise.all([
    countExact().is("assigned_to_user_id", null).eq("status", "open"),
    countExact().eq("assigned_to_user_id", user.id),
    countExact(),
  ]);

  const firstErr = unassigned.error ?? mine.error ?? all.error;
  if (firstErr) {
    return fail("internal_error", firstErr.message, 500, { requestId });
  }

  return ok(
    {
      unassigned: unassigned.count ?? 0,
      mine: mine.count ?? 0,
      all: all.count ?? 0,
    },
    { requestId },
  );
}
