/**
 * POST /api/v1/leads/[id]/lose
 *
 * Closes a lead as lost (P-02). P-03 requires `lost_reason` (validated by Zod).
 * Moves the lead to the pipeline's `is_lost=true` stage; trigger
 * `fn_crm_lead_close_on_stage` sets status='lost' + closed_at.
 *
 * A regra vive em `lib/leads/encerramento.ts`, compartilhada com a capacidade de
 * encerramento da IA (IA 360 · wave 2). Duas implementações fariam a IA e o
 * humano fecharem negócio por critérios diferentes.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { encerraDemanda } from "@/lib/leads/encerramento";
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
  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;

  try {
    const input = await validateRequest(loseLeadSchema, req);
    const { lead } = await encerraDemanda(
      supabase,
      {
        organization_id: authz.org.orgId,
        actor: { type: "user", id: authz.user.id },
        requestId,
      },
      { leadId, desfecho: "lost", motivo: input.lost_reason },
    );
    return ok(lead, { requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      const fieldErrors = (err.details as { fieldErrors?: Record<string, unknown> } | undefined)?.fieldErrors;
      if (err.code === "validation_error" && fieldErrors && "lost_reason" in fieldErrors) {
        return fail("lost_reason_required", "Informe o motivo da perda.", 422, { requestId });
      }
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }
}
