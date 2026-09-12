/**
 * POST /api/v1/voice/calls/[id]/accept — atende uma chamada recebida (§5.2).
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

  // Já conectada COM ESTA PESSOA na linha: atender de novo é o mesmo desfecho,
  // e responder sucesso é honesto. Já conectada com OUTRA pessoa é o caso
  // abaixo — e não é sucesso nenhum.
  if (call.status === "connected" && call.ownerUserId === user.id) {
    return ok({ id, status: "connected" }, { requestId });
  }
  if (call.ownerUserId && call.ownerUserId !== user.id) {
    return fail("voice_call_taken", "Outra pessoa já atendeu esta chamada.", 409, { requestId });
  }

  try {
    await wacalls.acceptCall(call.wacallsSessionId, call.wacallsCallId, user.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 409 DEIXA DE VIRAR SUCESSO.
    //
    // O upstream responde 409 quando outro operador ganhou a corrida pela mesma
    // chamada. Traduzir isso em `ok({status:"connected"})` fazia quem PERDEU
    // ver "conectado" na tela enquanto o áudio ia para o colega: a pessoa
    // falava sozinha, com o painel de chamada em andamento aberto na frente
    // dela. Perder a corrida é um desfecho legítimo e tem de ser dito.
    if (msg.includes("409") || msg.includes("already")) {
      return fail("voice_call_taken", "Outra pessoa já atendeu esta chamada.", 409, { requestId });
    }
    return fail("wacalls_error", wacallsFriendlyError(err), 502, { requestId });
  }

  // Quem atendeu assina — antes de responder, e sem esperar o SSE: é este
  // `owner_user_id` que decide de quem é o painel e quem pode desligar.
  await supabase
    .from("voice_calls")
    .update({ owner_user_id: user.id })
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id)
    .is("owner_user_id", null);

  void audit({
    action: "voice.call_accepted",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "voice_call",
    resourceId: id,
    requestId,
    metadata: { contact_id: call.contactId },
  });

  return ok({ id, status: "connected" }, { requestId });
}
