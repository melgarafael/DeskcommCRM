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
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { bulkLeadActionSchema, validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const MAX_BULK = 50;

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();

  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

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

  // Resolve organization_id from the first lead the caller can see (RLS-scoped).
  // Used for the aggregate event emission.
  const { data: scoped } = await supabase
    .from("crm_leads")
    .select("id, organization_id, tags")
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
  const organizationId = first.organization_id as string;

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

  await audit({
    action: "lead.bulk_action",
    actorUserId: user.id,
    organizationId,
    resourceType: "crm_lead",
    resourceId: null,
    requestId,
    metadata: {
      action: input.action,
      lead_ids: visibleIds,
      updated_count: updatedCount,
      params: "params" in input ? input.params : {},
    },
  });

  return ok({ updated_count: updatedCount, lead_ids: visibleIds }, { requestId });
}
