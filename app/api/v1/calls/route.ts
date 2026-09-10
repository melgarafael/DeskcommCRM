/**
 * POST /api/v1/calls
 *
 * Cria a linha em crm_calls como 'ringing' e origina via ARI. O worker
 * voice-agent (StasisStart, args[0] === "outbound") acha essa linha pelo
 * asterisk_channel_id e segue o fluxo dele.
 *
 * "mode: human" fica pra quando o atendente quer discar direto (a IA não
 * entra na ponte de áudio) — mesmo endpoint, o worker decide com base nesse
 * campo. A ponte WebRTC pro navegador do atendente não está implementada
 * neste esqueleto.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createCallSchema, listCallsQuerySchema } from "@/lib/schemas/calls";
import { validateRequest } from "@/lib/schemas/_validate";
import { createClient } from "@/lib/supabase/server";
import { originateCall } from "@/lib/voip/ariClient";

export const dynamic = "force-dynamic";

const LIST_COLS =
  "id, direction, status, from_number, to_number, handled_by, started_at, answered_at, ended_at, duration_seconds, transcript";

/**
 * GET /api/v1/calls — lista chamadas da org ativa, mais recente primeiro.
 * Inclui `transcript` direto na listagem (sem rota de detalhe separada —
 * volume de chamadas não justifica ainda, e o transcript não é grande).
 */
export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "crm_calls" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  const parsed = listCallsQuerySchema.safeParse(params);
  if (!parsed.success) {
    return fail("validation_failed", "Query inválida.", 422, { requestId, details: parsed.error.flatten() });
  }
  const q = parsed.data;

  const supabase = await createClient();
  let query = supabase
    .from("crm_calls")
    .select(LIST_COLS)
    .eq("organization_id", activeOrg.orgId)
    .order("started_at", { ascending: false })
    .limit(q.limit);

  if (q.direction) query = query.eq("direction", q.direction);
  if (q.status) query = query.eq("status", q.status);

  const { data, error } = await query;
  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "crm_calls" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  let input;
  try {
    input = await validateRequest(createCallSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const supabase = await createClient();

  // Gerado ANTES do insert e passado como `channelId` pro ARI (originateCall):
  // fecha a race entre o worker recebendo StasisStart (via WebSocket, processo
  // separado) e este handler gravando asterisk_channel_id DEPOIS que o ARI
  // responde — se o Stasis chegar primeiro, a linha já existe com o id certo,
  // nunca precisa de um update() separado torcendo pra chegar a tempo.
  const channelId = randomUUID();

  const { data: callRow, error: insertError } = await supabase
    .from("crm_calls")
    .insert({
      organization_id: activeOrg.orgId,
      direction: "outbound",
      status: "ringing",
      from_number: process.env.VOIP_DEFAULT_CALLER_ID ?? "",
      to_number: input.toNumber,
      lead_id: input.leadId ?? null,
      contact_id: input.contactId ?? null,
      assigned_to_user_id: input.mode === "human" ? authUser.id : null,
      handled_by: input.mode === "human" ? "human" : "ai",
      started_at: new Date().toISOString(),
      asterisk_channel_id: channelId,
    })
    .select()
    .single();

  if (insertError || !callRow) {
    return fail("internal_error", insertError?.message ?? "failed_to_create_call", 500, { requestId });
  }

  try {
    const channel = await originateCall({
      toNumber: input.toNumber,
      fromNumber: process.env.VOIP_DEFAULT_CALLER_ID,
      trunkEndpoint: process.env.VOIP_TRUNK_ENDPOINT!,
      callerLabel: input.mode,
      channelId,
    });

    await audit({
      action: "call.created",
      actorUserId: authUser.id,
      organizationId: activeOrg.orgId,
      resourceType: "crm_calls",
      resourceId: callRow.id,
      requestId,
      metadata: { direction: "outbound", mode: input.mode, to_number: input.toNumber },
    });

    return ok({ callId: callRow.id, channelId: channel.id }, { status: 201, requestId });
  } catch (err) {
    await supabase.from("crm_calls").update({ status: "failed" }).eq("id", callRow.id);
    return fail("originate_failed", err instanceof Error ? err.message : "originate_failed", 502, { requestId });
  }
}
