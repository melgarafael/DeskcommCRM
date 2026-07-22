/**
 * GET   /api/v1/ai/followup-flows/:id — pointer completo (draft_graph,
 *   trigger_config, handoff_policy) — any org member.
 * PATCH /api/v1/ai/followup-flows/:id — atualiza campos parciais (manager+).
 *   draft_graph é validado só estruturalmente (flowGraphSchema) — a validação
 *   semântica de publish (reachability, coverage) roda em /publish.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { patchFollowupFlowSchema } from "@/lib/followup/api-schemas";

export const dynamic = "force-dynamic";

const DETAIL_COLUMNS =
  "id, name, status, active_version_id, draft_graph, handoff_policy, trigger_config, created_at, updated_at";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await requireRole("viewer", { requestId, resource: "followup_flows" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("followup_flow_pointers")
    .select(DETAIL_COLUMNS)
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("not_found", "Fluxo não encontrado.", 404, { requestId });

  return ok(data, { requestId });
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
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

  const parsed = patchFollowupFlowSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const supabase = await createClient();
  const { data: existing, error: fetchErr } = await supabase
    .from("followup_flow_pointers")
    .select("id")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!existing) return fail("not_found", "Fluxo não encontrado.", 404, { requestId });

  const patch = parsed.data;
  if (Object.keys(patch).length === 0) {
    const { data: unchanged, error: reloadErr } = await supabase
      .from("followup_flow_pointers")
      .select(DETAIL_COLUMNS)
      .eq("id", id)
      .single();
    if (reloadErr || !unchanged) {
      return fail("internal_error", reloadErr?.message ?? "reload_failed", 500, { requestId });
    }
    return ok(unchanged, { requestId });
  }

  const update: Record<string, unknown> = { ...patch, updated_at: new Date().toISOString() };

  const { data: updated, error: updErr } = await supabase
    .from("followup_flow_pointers")
    .update(update)
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .select(DETAIL_COLUMNS)
    .single();

  if (updErr || !updated) {
    if (updErr?.code === "23505") {
      return fail("conflict", "Já existe um fluxo com este nome.", 409, { requestId });
    }
    return fail("internal_error", updErr?.message ?? "followup_flow_update_failed", 500, {
      requestId,
    });
  }

  void audit({
    action: "followup_flow.updated",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "followup_flow_pointer",
    resourceId: id,
    requestId,
    metadata: { fields_changed: Object.keys(patch) },
  });

  return ok(updated, { requestId });
}
