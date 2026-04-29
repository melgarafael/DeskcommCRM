/**
 * POST /api/v1/leads/[id]/lose
 *
 * Closes a lead as lost (P-02). P-03 requires `lost_reason` (validated by Zod).
 * Moves the lead to the pipeline's `is_lost=true` stage; trigger
 * `fn_crm_lead_close_on_stage` sets status='lost' + closed_at.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { loseLeadSchema, validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

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
    input = await validateRequest(loseLeadSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const { data: lead, error: selErr } = await supabase
    .from("crm_leads")
    .select("*")
    .eq("id", leadId)
    .maybeSingle();

  if (selErr) return fail("internal_error", selErr.message, 500, { requestId });
  if (!lead) return fail("not_found", "Lead não encontrado.", 404, { requestId });

  if (lead.status === "lost") {
    return ok(lead, { requestId });
  }

  const { data: lostStage, error: stErr } = await supabase
    .from("crm_stages")
    .select("id")
    .eq("pipeline_id", lead.pipeline_id)
    .eq("is_lost", true)
    .limit(1)
    .maybeSingle();

  if (stErr) return fail("internal_error", stErr.message, 500, { requestId });
  if (!lostStage) {
    return fail(
      "pipeline_no_lost_stage",
      "Pipeline não tem stage de fechamento como perda.",
      422,
      { requestId },
    );
  }

  const { error: updErr } = await supabase
    .from("crm_leads")
    .update({
      stage_id: lostStage.id,
      lost_reason: input.lost_reason,
      updated_at: new Date().toISOString(),
    })
    .eq("id", leadId);

  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  const { data: fresh } = await supabase
    .from("crm_leads")
    .select("*")
    .eq("id", leadId)
    .maybeSingle();

  const finalLead = fresh ?? lead;

  await supabase
    .rpc("emit_event", {
      p_event_type: "lead.lost",
      p_entity_kind: "crm_lead",
      p_entity_id: leadId,
      p_payload: {
        from_stage_id: lead.stage_id,
        to_stage_id: lostStage.id,
        lost_reason: input.lost_reason,
      },
      p_metadata: { request_id: requestId, actor_user_id: user.id },
      p_organization_id: lead.organization_id,
    })
    .then(({ error }) => {
      if (error) console.error("[lead.lose] emit_event failed", error.message);
    });

  await audit({
    action: "lead.lost",
    actorUserId: user.id,
    organizationId: lead.organization_id,
    resourceType: "crm_lead",
    resourceId: leadId,
    requestId,
    metadata: {
      from_stage_id: lead.stage_id,
      to_stage_id: lostStage.id,
      lost_reason: input.lost_reason,
    },
  });

  return ok(finalLead, { requestId });
}
