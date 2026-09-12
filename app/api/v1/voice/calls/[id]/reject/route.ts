/**
 * POST /api/v1/voice/calls/[id]/reject — recusa uma chamada recebida (§5.2).
 */
import { randomUUID } from "node:crypto";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { getWacallsClient, wacallsFriendlyError } from "@/lib/wacalls/client";
import { resolveVoiceCall } from "@/lib/wacalls/calls";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Acompanhamento administrativo somente-leitura não liga, não atende, não
  // desliga e não pareia: o efeito é do tenant, não de quem observa.
  const suporteNegado = await requireSupportWrite();
  if (suporteNegado) return suporteNegado;

  const requestId = randomUUID();
  const { id } = await params;

  const authz = await requireRole("agent", { requestId, resource: "voice_calls" });
  if (!authz.ok) return authz.response;
  const { user, org: activeOrg } = authz;

  const wacalls = getWacallsClient();
  if (!wacalls) return fail("wacalls_not_configured", "Chamada de voz não configurada.", 503, { requestId });

  const supabase = await createClient();
  const call = await resolveVoiceCall(supabase, activeOrg.orgId, id);
  if (!call) return fail("not_found", "Chamada não encontrada.", 404, { requestId });

  try {
    await wacalls.rejectCall(call.wacallsSessionId, call.wacallsCallId);
    void audit({
      action: "voice.call_rejected",
      actorUserId: user.id,
      organizationId: activeOrg.orgId,
      resourceType: "voice_call",
      resourceId: id,
      requestId,
      metadata: { contact_id: call.contactId },
    });
    return ok({ id, status: "ended" }, { requestId });
  } catch (err) {
    return fail("wacalls_error", wacallsFriendlyError(err), 502, { requestId });
  }
}
