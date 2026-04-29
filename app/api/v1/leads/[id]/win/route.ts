/**
 * POST /api/v1/leads/[id]/win
 *
 * Closes a lead as won by moving it to the pipeline's `is_won=true` stage.
 * The DB trigger `fn_crm_lead_close_on_stage` sets status='won' + closed_at (P-02).
 * Idempotent: already-won leads return 200 with the current row.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
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

  const { data: lead, error: selErr } = await supabase
    .from("crm_leads")
    .select("*")
    .eq("id", leadId)
    .maybeSingle();

  if (selErr) return fail("internal_error", selErr.message, 500, { requestId });
  if (!lead) return fail("not_found", "Lead não encontrado.", 404, { requestId });

  if (lead.status === "won") {
    return ok(lead, { requestId });
  }

  // Find the won stage of the pipeline.
  const { data: wonStage, error: stErr } = await supabase
    .from("crm_stages")
    .select("id")
    .eq("pipeline_id", lead.pipeline_id)
    .eq("is_won", true)
    .limit(1)
    .maybeSingle();

  if (stErr) return fail("internal_error", stErr.message, 500, { requestId });
  if (!wonStage) {
    return fail(
      "pipeline_no_won_stage",
      "Pipeline não tem stage de fechamento como ganho.",
      422,
      { requestId },
    );
  }

  // Intentional close: don't enforce OCC. Trigger handles status + closed_at.
  const { error: updErr } = await supabase
    .from("crm_leads")
    .update({
      stage_id: wonStage.id,
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
      p_event_type: "lead.won",
      p_entity_kind: "crm_lead",
      p_entity_id: leadId,
      p_payload: {
        from_stage_id: lead.stage_id,
        to_stage_id: wonStage.id,
        value_cents: finalLead.value_cents,
        currency: finalLead.currency,
      },
      p_metadata: { request_id: requestId, actor_user_id: user.id },
      p_organization_id: lead.organization_id,
    })
    .then(({ error }) => {
      if (error) console.error("[lead.win] emit_event failed", error.message);
    });

  await audit({
    action: "lead.won",
    actorUserId: user.id,
    organizationId: lead.organization_id,
    resourceType: "crm_lead",
    resourceId: leadId,
    requestId,
    metadata: { from_stage_id: lead.stage_id, to_stage_id: wonStage.id },
  });

  return ok(finalLead, { requestId });
}
