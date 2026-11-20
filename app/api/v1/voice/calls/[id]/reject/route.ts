/**
 * POST /api/v1/voice/calls/[id]/reject — recusa uma chamada recebida (§5.2).
 *
 * WaCalls: recusa no binário upstream. SIP: encerra a linha como `declined`, e
 * o worker de voz derruba o canal quando o AudioSocket conectar
 * (`lib/voip/recusar-chamada-sip.ts`). A escolha é pelo `provider` da linha
 * ANTES de exigir o WaCalls: instalação só com telefonia SIP não tem WaCalls, e
 * a rota respondia 503/404 a toda recusa.
 */
import { randomUUID } from "node:crypto";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { getWacallsClient, wacallsFriendlyError } from "@/lib/wacalls/client";
import { resolveVoiceCall } from "@/lib/wacalls/calls";
import { recusarChamadaSip } from "@/lib/voip/recusar-chamada-sip";

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

  const supabase = await createClient();

  const { data: linha } = await supabase
    .from("voice_calls")
    .select("provider, contact_id")
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!linha) return fail("not_found", "Chamada não encontrada.", 404, { requestId });

  if ((linha as { provider: string }).provider === "sip") {
    let resultado;
    try {
      resultado = await recusarChamadaSip(supabase, activeOrg.orgId, id, new Date());
    } catch (err) {
      return fail("internal_error", err instanceof Error ? err.message : "recusa_falhou", 500, { requestId });
    }
    if (resultado === "nao_encontrada") return fail("not_found", "Chamada não encontrada.", 404, { requestId });
    if (resultado === "ja_atendida") {
      return fail("state_conflict", "A chamada já foi atendida e não pode mais ser recusada.", 409, { requestId });
    }
    // `ja_encerrada` é sucesso: quem clicou queria a ligação fora da tela, e ela está.
    if (resultado === "recusada") {
      void audit({
        action: "voice.call_rejected",
        actorUserId: user.id,
        organizationId: activeOrg.orgId,
        resourceType: "voice_call",
        resourceId: id,
        requestId,
        metadata: { contact_id: (linha as { contact_id: string | null }).contact_id, provider: "sip" },
      });
    }
    return ok({ id, status: "ended" }, { requestId });
  }

  const wacalls = getWacallsClient();
  if (!wacalls) return fail("wacalls_not_configured", "Chamada de voz não configurada.", 503, { requestId });

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
