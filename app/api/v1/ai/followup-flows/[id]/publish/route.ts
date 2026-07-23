/**
 * POST /api/v1/ai/followup-flows/:id/publish — valida o draft_graph
 * (validateFlowForPublish, Task 2.2) e, se válido, publica atomicamente via
 * fn_publish_followup_flow_version (migration 0056): insert da version +
 * ativação do pointer (active_version_id + status='active') numa função só,
 * sem janela onde a version fica órfã. EXECUTE da função é só service_role
 * (revogado de authenticated) — por isso o client aqui é o admin, com
 * organization_id sempre filtrado explicitamente (nunca do body).
 *
 * 422 validation_failed com details.errors (mesmo shape de PublishValidationError)
 * se draft_graph ausente ou reprovado na validação estrutural/semântica.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateFlowForPublish } from "@/lib/followup/validate-publish";
import { publishFollowupFlowVersion } from "@/lib/followup/publish";
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

  const admin = createAdminClient();
  const { data: pointer, error: fetchErr } = await admin
    .from("followup_flow_pointers")
    .select("id, draft_graph, trigger_config")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!pointer) return fail("not_found", "Fluxo não encontrado.", 404, { requestId });

  // Só `manual` e `silence` têm motor de enrollment (POST manual / silence-sweep).
  // `stage_change`/`conversation_end` são kinds válidos no schema (roadmap) mas
  // publicar um fluxo com eles produziria um `status='active'` que nunca enrola
  // ninguém — um fluxo morto e silencioso. Bloqueia no publish, não no schema.
  const triggerKind = (pointer.trigger_config as { kind?: string } | null)?.kind ?? "manual";
  if (triggerKind === "stage_change" || triggerKind === "conversation_end") {
    return fail(
      "trigger_kind_not_implemented",
      `O gatilho '${triggerKind}' ainda não está disponível — use Silêncio ou Manual.`,
      422,
      { requestId },
    );
  }

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

  const result = await publishFollowupFlowVersion(admin, {
    orgId: activeOrg.orgId,
    pointerId: id,
    graph,
    createdBy: user.id,
  });
  if (!result.ok) {
    if (result.code === "pointer_not_found") {
      return fail("not_found", "Fluxo não encontrado.", 404, { requestId });
    }
    return fail("internal_error", result.message, 500, { requestId });
  }

  const { data: updatedPointer, error: reloadErr } = await admin
    .from("followup_flow_pointers")
    .select("id, status, active_version_id, updated_at")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .single();
  if (reloadErr || !updatedPointer) {
    return fail("internal_error", reloadErr?.message ?? "followup_flow_reload_failed", 500, {
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
    metadata: { version_id: result.version_id },
  });

  return ok(updatedPointer, { requestId });
}
