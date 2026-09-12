/**
 * DELETE /api/v1/voice/calls/[id] — encerra uma chamada ativa (§5.3).
 * O fechamento definitivo de `voice_calls` (status/duration/end_reason) é
 * feito pela ponte de eventos do worker ao receber `call-ended` via SSE
 * (§4.2 da spec) — esta rota só pede pro WaCalls desligar.
 */
import { randomUUID } from "node:crypto";

import { noContent, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { getWacallsClient, wacallsFriendlyError } from "@/lib/wacalls/client";
import { podeEncerrar, resolveVoiceCall } from "@/lib/wacalls/calls";

export const dynamic = "force-dynamic";

export async function DELETE(
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

  // SÓ QUEM ESTÁ NA LINHA DESLIGA.
  //
  // `resolveVoiceCall` escopava só pela organização, e o efeito era que qualquer
  // `agent` derrubava a ligação de qualquer colega — no meio da frase, sem
  // rastro. Num escritório que compartilha um número isso é o botão vermelho do
  // painel de outra pessoa. Chamada que ninguém assumiu não tem áudio de
  // ninguém a cortar: o caminho dela é `/reject`.
  if (!podeEncerrar(call, user.id)) {
    return fail(
      "voice_call_not_yours",
      "Esta chamada é de outra pessoa. Só quem está na linha pode encerrá-la.",
      403,
      { requestId },
    );
  }

  try {
    await wacalls.endCall(call.wacallsSessionId, call.wacallsCallId);
    void audit({
      action: "voice.call_ended",
      actorUserId: user.id,
      organizationId: activeOrg.orgId,
      resourceType: "voice_call",
      resourceId: id,
      requestId,
      metadata: { contact_id: call.contactId },
    });
    return noContent(requestId);
  } catch (err) {
    return fail("wacalls_error", wacallsFriendlyError(err), 502, { requestId });
  }
}
