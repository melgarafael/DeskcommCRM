/**
 * GET /api/v1/automation-rules/runs?limit=50 — histórico de execuções da ORG
 * inteira (cross-rule), desc. Usado pela aba Atividade (timeline global).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "automation_rules" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const rawLimit = Number(req.nextUrl.searchParams.get("limit"));
  const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT, MAX_LIMIT);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("automation_rule_runs")
    .select("*, automation_rules(name)")
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok(data ?? [], { requestId });
}
