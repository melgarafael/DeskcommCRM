/**
 * POST /api/v1/ai/followup-flows/:id/rollback  body: { version_id }
 * Aponta o pointer pra uma version já existente (manager+), sem criar uma
 * version nova.
 *
 * KNOWN GAP: followup_flow_versions não tem pointer_id (migration 0054) —
 * versions só se ligam ao pointer via active_version_id, não há tabela de
 * linhagem por pointer. Por isso o check aqui é "version pertence à MESMA
 * org", não "version já foi ativa deste pointer". Levantar em revisão final:
 * se aceitável, considerar registrar pointer_id em followup_flow_versions.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { rollbackFollowupFlowSchema } from "@/lib/followup/api-schemas";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteCtx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await requireRole("manager", { requestId, resource: "followup_flows" });
  if (!authz.ok) return authz.response;
  const { user, org: activeOrg } = authz;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }

  const parsed = rollbackFollowupFlowSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const supabase = await createClient();
  const { data: pointer, error: fetchErr } = await supabase
    .from("followup_flow_pointers")
    .select("id")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!pointer) return fail("not_found", "Fluxo não encontrado.", 404, { requestId });

  const { data: version, error: versionErr } = await supabase
    .from("followup_flow_versions")
    .select("id")
    .eq("id", parsed.data.version_id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (versionErr) return fail("internal_error", versionErr.message, 500, { requestId });
  if (!version) return fail("not_found", "Version não encontrada.", 404, { requestId });

  const { data: updated, error: updErr } = await supabase
    .from("followup_flow_pointers")
    .update({
      active_version_id: version.id,
      status: "active",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .select("id, status, active_version_id, updated_at")
    .single();
  if (updErr || !updated) {
    return fail("internal_error", updErr?.message ?? "followup_flow_rollback_failed", 500, {
      requestId,
    });
  }

  void audit({
    action: "followup_flow.rolled_back",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "followup_flow_pointer",
    resourceId: id,
    requestId,
    metadata: { version_id: version.id },
  });

  return ok(updated, { requestId });
}
