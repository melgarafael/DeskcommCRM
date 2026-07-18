/**
 * GET /api/v1/attendants/availability — disponibilidade da equipe (org-wide).
 *
 * Visível a agent+ (matriz spec 13 §4 nota 5: a disponibilidade da equipe é
 * insumo operacional do roteamento — quem está online / com folga). A RLS
 * (`attendant_availability_select`, org-wide via fn_user_org_ids) é backstop; o
 * requireRole("agent") é o gate enforçado (viewer, observador puro, não precisa
 * do painel de roteamento).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const SELECT_COLS =
  "user_id, is_available, capacity, schedule, last_heartbeat_at, updated_at";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("agent", { requestId, resource: "attendant_availability" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("attendant_availability")
    .select(SELECT_COLS)
    .eq("organization_id", activeOrg.orgId)
    .order("updated_at", { ascending: false });

  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok(data ?? [], { requestId });
}
