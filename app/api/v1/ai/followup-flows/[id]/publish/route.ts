/**
 * POST /api/v1/ai/followup-flows/:id/publish — valida o draft_graph
 * (validateFlowForPublish, Task 2.2) e, se válido, cria uma nova
 * followup_flow_versions com o graph e aponta o pointer pra ela
 * (active_version_id + status='active').
 *
 * 422 validation_failed com details.errors (mesmo shape de PublishValidationError)
 * se draft_graph ausente ou reprovado na validação estrutural/semântica.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { validateFlowForPublish } from "@/lib/followup/validate-publish";
import type { FlowGraph } from "@/lib/followup/graph-schema";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteCtx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await requireRole("manager", { requestId, resource: "followup_flows" });
  if (!authz.ok) return authz.response;
  const { user, org: activeOrg } = authz;

  const supabase = await createClient();
  const { data: pointer, error: fetchErr } = await supabase
    .from("followup_flow_pointers")
    .select("id, draft_graph")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!pointer) return fail("not_found", "Fluxo não encontrado.", 404, { requestId });

  if (!pointer.draft_graph) {
    return fail("validation_failed", "Fluxo não tem rascunho pronto para publicar.", 422, {
      requestId,
      details: {
        errors: [
          {
            node_id: null,
            code: "no_trigger",
            message: "draft_graph ausente — monte o fluxo antes de publicar.",
          },
        ],
      },
    });
  }

  const graph = pointer.draft_graph as unknown as FlowGraph;
  const validation = validateFlowForPublish(graph);
  if (!validation.ok) {
    return fail("validation_failed", "Fluxo reprovado na validação de publish.", 422, {
      requestId,
      details: { errors: validation.errors },
    });
  }

  const { data: version, error: versionErr } = await supabase
    .from("followup_flow_versions")
    .insert({ organization_id: activeOrg.orgId, graph, created_by: user.id })
    .select("id, created_at")
    .single();
  if (versionErr || !version) {
    return fail("internal_error", versionErr?.message ?? "followup_flow_version_insert_failed", 500, {
      requestId,
    });
  }

  const { data: updatedPointer, error: updErr } = await supabase
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
  if (updErr || !updatedPointer) {
    return fail("internal_error", updErr?.message ?? "followup_flow_pointer_update_failed", 500, {
      requestId,
    });
  }

  void audit({
    action: "followup_flow.published",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "followup_flow_pointer",
    resourceId: id,
    requestId,
    metadata: { version_id: version.id },
  });

  return ok(updatedPointer, { requestId });
}
