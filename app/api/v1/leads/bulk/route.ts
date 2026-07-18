/**
 * POST /api/v1/leads/bulk
 *
 * Bulk operations on leads (move/assign/tag/delete). Discriminated by `action`.
 * AT-06: max 50 ids per call.
 *
 * Status transitions are NOT performed here — bulk move only changes
 * stage_id/position; the trigger will close-as-won/lost if the target is a
 * close stage. RLS scopes everything to the caller's tenant.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { bulkLeadActionSchema, validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const MAX_BULK = 50;

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();

  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const user = authz.user;

  let input;
  try {
    input = await validateRequest(bulkLeadActionSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  if (input.lead_ids.length > MAX_BULK) {
    return fail("bulk_too_large", `Máximo ${MAX_BULK} leads por bulk.`, 422, { requestId });
  }

  // G3-04: assign é reatribuição de dono em lote → piso ≥manager (spec 04 §6.5,
  // INB-03). Gate por-action: move/tag/delete continuam agent+ (piso acima);
  // só o assign exige manager. Reusa o helper (nada de ROLE_RANK na mão).
  if (input.action === "assign") {
    const mgr = await requireRole("manager", { requestId, resource: "crm_leads" });
    if (!mgr.ok) return mgr.response;

    // Novo dono tem que ser membro ativo agent+ da MESMA org (org de fonte
    // confiável = authz, nunca body). owner_user_id null = desatribuir (válido).
    // A RLS de user_organizations só mostra o próprio membership a um manager,
    // por isso o admin client filtrado pela org resolvida.
    const ownerId = input.params.owner_user_id;
    if (ownerId !== null) {
      // INB-09 nota 1: fail-closed. A validação de membership só roda com service
      // role (a RLS de user_organizations não mostra membership alheio a um
      // manager). Sem service role NÃO se pode validar o dono → recusar em vez
      // de atribuir um owner não-verificado. Desatribuir (owner null) segue livre.
      if (!isServiceRoleConfigured()) {
        return fail(
          "owner_validation_unavailable",
          "Não foi possível validar o responsável agora. Tente novamente em instantes.",
          422,
          { requestId },
        );
      }
      const admin = createAdminClient();
      const { data: member, error: memberErr } = await admin
        .from("user_organizations")
        .select("role")
        .eq("organization_id", authz.org.orgId)
        .eq("user_id", ownerId)
        .is("revoked_at", null)
        .maybeSingle();
      if (memberErr) return fail("internal_error", memberErr.message, 500, { requestId });
      if (!member || member.role === "viewer") {
        return fail(
          "invalid_owner",
          "Responsável não é um atendente ativo desta organização.",
          422,
          { requestId },
        );
      }
    }
  }

  // INB-09 nota 2: org de fonte confiável = org ativa do cookie (authz), NUNCA
  // inferida do 1º lead. A RLS já escopa por org do membro, mas um ator em 2+
  // orgs veria leads de ambas — o filtro explícito garante que o bulk só toca a
  // org ativa (mesmo padrão do gate de owner acima).
  const organizationId = authz.org.orgId;
  const { data: scoped } = await supabase
    .from("crm_leads")
    .select("id, organization_id, tags, stage_id, pipeline_id")
    .eq("organization_id", organizationId)
    .in("id", input.lead_ids);

  const visible = scoped ?? [];
  const first = visible[0];
  if (!first) {
    return fail(
      "not_found",
      "Nenhum lead acessível na operação.",
      404,
      { requestId },
    );
  }
  const visibleIds = visible.map((r) => r.id);

  let updatedCount = 0;
  const nowIso = new Date().toISOString();

  switch (input.action) {
    case "move": {
      const { data, error } = await supabase
        .from("crm_leads")
        .update({
          stage_id: input.params.stage_id,
          position_in_stage: input.params.position_in_stage,
          updated_at: nowIso,
        })
        .in("id", visibleIds)
        .select("id");
      if (error) return fail("internal_error", error.message, 500, { requestId });
      updatedCount = data?.length ?? 0;

      // Per-lead lead.stage_changed so the automation engine (which only
      // consumes per-entity events) fires for bulk moves too — mirrors
      // moveLeadHandler's payload. Skip leads already at the target stage.
      const movedIds = new Set((data ?? []).map((r) => r.id as string));
      await Promise.all(
        visible
          .filter((row) => movedIds.has(row.id) && row.stage_id !== input.params.stage_id)
          .map((row) =>
            supabase
              .rpc("emit_event", {
                p_event_type: "lead.stage_changed",
                p_entity_kind: "crm_lead",
                p_entity_id: row.id,
                p_payload: {
                  pipeline_id: row.pipeline_id,
                  from_stage_id: row.stage_id,
                  to_stage_id: input.params.stage_id,
                },
                p_metadata: { request_id: requestId, actor_user_id: user.id },
                p_organization_id: organizationId,
              })
              .then(({ error: emitError }) => {
                if (emitError) console.error("[lead.bulk_moved] emit_event failed", emitError.message);
              }),
          ),
      );
      break;
    }
    case "assign": {
      const patch: Record<string, unknown> = {
        owner_user_id: input.params.owner_user_id,
        updated_at: nowIso,
      };
      if (input.params.owner_user_id !== null) {
        patch.assigned_at = nowIso;
      }
      const { data, error } = await supabase
        .from("crm_leads")
        .update(patch)
        .in("id", visibleIds)
        .select("id");
      if (error) return fail("internal_error", error.message, 500, { requestId });
      updatedCount = data?.length ?? 0;
      break;
    }
    case "tag": {
      const add = input.params.add ?? [];
      const remove = new Set(input.params.remove ?? []);
      // Compute next tags per row from already-fetched `scoped`.
      for (const row of visible) {
        const current = (row.tags ?? []) as string[];
        const next = Array.from(new Set([...current.filter((t) => !remove.has(t)), ...add]));
        const { error } = await supabase
          .from("crm_leads")
          .update({ tags: next, updated_at: nowIso })
          .eq("id", row.id);
        if (error) return fail("internal_error", error.message, 500, { requestId });
        updatedCount += 1;

        // Per-lead lead.tag_added (only-when-added), same contract as
        // updateLeadHandler, so the automation engine fires for bulk tags too.
        const addedTags = add.filter((t) => !current.includes(t));
        if (addedTags.length) {
          await supabase
            .rpc("emit_event", {
              p_event_type: "lead.tag_added",
              p_entity_kind: "crm_lead",
              p_entity_id: row.id,
              p_payload: { added_tags: addedTags, tags: next },
              p_metadata: { request_id: requestId, actor_user_id: user.id },
              p_organization_id: organizationId,
            })
            .then(({ error: emitError }) => {
              if (emitError) console.error("[lead.bulk_tagged] emit_event failed", emitError.message);
            });
        }
      }
      break;
    }
    case "delete": {
      // crm_leads has no `is_archived` column → real DELETE.
      const { data, error } = await supabase
        .from("crm_leads")
        .delete()
        .in("id", visibleIds)
        .select("id");
      if (error) return fail("internal_error", error.message, 500, { requestId });
      updatedCount = data?.length ?? 0;
      break;
    }
  }

  // Aggregate event + aggregate audit (one record per bulk call).
  const eventType =
    input.action === "move"
      ? "lead.bulk_moved"
      : input.action === "assign"
        ? "lead.bulk_assigned"
        : input.action === "tag"
          ? "lead.bulk_tagged"
          : "lead.bulk_deleted";

  await supabase
    .rpc("emit_event", {
      p_event_type: eventType,
      p_entity_kind: "crm_lead",
      p_entity_id: null,
      p_payload: {
        action: input.action,
        lead_ids: visibleIds,
        params: "params" in input ? input.params : {},
      },
      p_metadata: { request_id: requestId, actor_user_id: user.id },
      p_organization_id: organizationId,
    })
    .then(({ error }) => {
      if (error) console.error("[lead.bulk] emit_event failed", error.message);
    });

  // Assign audita com action agregada dedicada (spec 04 §6.5); as demais ações
  // mantêm o code genérico. Uma única entrada por chamada, com a contagem.
  await audit({
    action: input.action === "assign" ? "leads.bulk_assigned" : "lead.bulk_action",
    actorUserId: user.id,
    organizationId,
    resourceType: "crm_lead",
    resourceId: null,
    requestId,
    metadata: {
      action: input.action,
      lead_ids: visibleIds,
      count: updatedCount,
      updated_count: updatedCount,
      ...(input.action === "assign" ? { owner_user_id: input.params.owner_user_id } : {}),
      params: "params" in input ? input.params : {},
    },
  });

  return ok({ updated_count: updatedCount, lead_ids: visibleIds }, { requestId });
}
