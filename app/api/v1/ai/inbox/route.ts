/**
 * GET /api/v1/ai/inbox — central de avisos do runtime do agente (Operação
 * Visível F1). Lista agent_inbox_items da org ativa (RLS + filtro explícito),
 * com contagem de abertos p/ o sino do header. Read-only, qualquer membro.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
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

  const statusParam = req.nextUrl.searchParams.get("status");
  const status = statusParam === "resolved" ? "resolved" : "open";

  let query = supabase
    .from("agent_inbox_items")
    .select("id, kind, severity, title, body, ref_kind, ref_id, status, created_at")
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false })
    .limit(100);
  // aba "abertos" inclui ack (visto mas não resolvido); "resolvidos" é terminal.
  query = status === "open" ? query.in("status", ["open", "ack"]) : query.eq("status", "resolved");

  const [{ data: items, error }, { count: openCount, error: countErr }] = await Promise.all([
    query,
    supabase
      .from("agent_inbox_items")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", activeOrg.orgId)
      .in("status", ["open", "ack"]),
  ]);
  if (error || countErr) {
    return fail("internal_error", "Failed to load inbox items.", 500, { requestId });
  }

  return ok({ items: items ?? [], open_count: openCount ?? 0 }, { requestId });
}
