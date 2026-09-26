import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/leads/[id]/win
 *
 * Closes a lead as won by moving it to the pipeline's `is_won=true` stage.
 * The DB trigger `fn_crm_lead_close_on_stage` sets status='won' + closed_at (P-02).
 * Idempotent: already-won leads return 200 with the current row.
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
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  const supabase = await createClient();
  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;

  // O MOTIVO DE GANHO (issue #1536): corpo opcional. Body vazio/ausente é o
  // contrato antigo — ganhar sem motivo continua valendo, salvo quando o funil
  // liga `settings.won_reason_required` (aí a recusa vem de `encerraDemanda`).
  const corpo = await req.json().catch(() => ({}));
  const wonReason =
    typeof (corpo as { won_reason?: unknown }).won_reason === "string"
      ? ((corpo as { won_reason: string }).won_reason as string)
      : null;

  try {
    const { lead } = await encerraDemanda(
      supabase,
      {
        organization_id: authz.org.orgId,
        actor: { type: "user", id: authz.user.id },
        requestId,
        idioma: authz.user.idioma,
      },
      { leadId, desfecho: "won", motivo: wonReason },
    );
    return ok(lead, { requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }
}
