/**
 * POST /api/v1/voice/calls — inicia chamada de voz outbound (§5.1 da spec).
 *
 * Body: `{ contactId }`. O telefone NUNCA vem do frontend — é lido do
 * contato, escopado pela org, igual todo resto do sistema resolve
 * destinatário a partir de dado próprio, nunca do que o cliente mandou.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { exigirVozLigada } from "@/lib/voice/guarda";
import { getWacallsClient, wacallsFriendlyError } from "@/lib/wacalls/client";
import { resolveWacallsSession } from "@/lib/wacalls/session";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ contactId: z.string().uuid() });

export async function POST(req: Request): Promise<Response> {
  // Acompanhamento administrativo somente-leitura não liga, não atende, não
  // desliga e não pareia: o efeito é do tenant, não de quem observa.
  const suporteNegado = await requireSupportWrite();
  if (suporteNegado) return suporteNegado;

  const requestId = randomUUID();

  const authz = await requireRole("agent", { requestId, resource: "voice_calls" });
  if (!authz.ok) return authz.response;
  const { user, org: activeOrg } = authz;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_body", "contactId é obrigatório (uuid).", 400, { requestId });
  }

  const wacalls = getWacallsClient();
  if (!wacalls) {
    return fail("wacalls_not_configured", "Chamada de voz não está configurada.", 503, { requestId });
  }

  const supabase = await createClient();

  // Segundo portão do mesmo consentimento. Não é redundante com o do
  // pareamento: uma organização que pareou e DEPOIS desligou fica, por um
  // instante, com sessão viva e escolha `false` — e é nesse instante que
  // alguém clicaria "Chamar". O desligar despareia, mas a ordem dos efeitos
  // não é uma coisa em que vale a pena confiar num caminho que expõe a conta.
  // `instalacaoOferece: true` porque o `getWacallsClient()` acima já provou
  // o fato e já devolveu 503 se fosse falso — a guarda não o relê pelo env.
  const vozDesligada = await exigirVozLigada(supabase, activeOrg.orgId, {
    requestId,
    instalacaoOferece: true,
  });
  if (vozDesligada) return vozDesligada;

  const session = await resolveWacallsSession(supabase, activeOrg.orgId);
  if (!session) {
    return fail(
      "wacalls_not_paired",
      "Chamada de voz ainda não foi pareada para esta organização. Configure em Configurações › Canais.",
      409,
      { requestId },
    );
  }

  const { data: contactRaw } = await supabase
    .from("contacts")
    .select("id, phone_number, name, is_blocked, is_anonymized")
    .eq("organization_id", activeOrg.orgId)
    .eq("id", parsed.data.contactId)
    .maybeSingle();
  const contact = contactRaw as {
    id: string;
    phone_number: string | null;
    name: string | null;
    is_blocked: boolean | null;
    is_anonymized: boolean | null;
  } | null;
  if (!contact) return fail("not_found", "Contato não encontrado.", 404, { requestId });

  // QUEM PEDIU PARA NÃO SER INCOMODADO NÃO RECEBE LIGAÇÃO.
  //
  // A seleção era `id, phone_number, name` — as duas flags nem chegavam à rota,
  // e o discador ligava para quem tinha mandado "PARAR". Um telefonema é MAIS
  // intrusivo que a mensagem que `is_blocked` já barra em
  // `app/api/v1/messages/_handler.ts`: ele toca no bolso da pessoa. Mesmo 403
  // `forbidden` de lá, para que a tela trate os dois do mesmo jeito.
  if (contact.is_blocked) {
    return fail("forbidden", "Contato bloqueou o atendimento.", 403, { requestId });
  }
  // Contato anonimizado não tem mais telefone real guardado, e o que sobrou não
  // é dele. 422 e não 403, pela mesma assimetria que o envio de mensagem já
  // usa: não é permissão que falta, é o alvo que não existe mais.
  if (contact.is_anonymized) {
    return fail("contact_anonymized", "Contato anonimizado não pode ser chamado.", 422, {
      requestId,
    });
  }
  if (!contact.phone_number) {
    return fail("contact_without_phone", "Este contato não tem telefone cadastrado.", 422, { requestId });
  }

  try {
    const call = await wacalls.startCall(session.wacallsSessionId, user.id, contact.phone_number);

    const { data: inserted, error: insertErr } = await supabase
      .from("voice_calls")
      .insert({
        organization_id: activeOrg.orgId,
        channel_session_id: session.channelSessionId,
        contact_id: contact.id,
        wacalls_call_id: call.callId,
        direction: "outbound",
        peer_phone: contact.phone_number,
        status: "starting",
        created_by: user.id,
        // Quem discou já está na linha: o dono nasce aqui, e não espera o SSE
        // devolver o `owner`. Sem isto haveria uma janela em que a ligação é de
        // ninguém — e "de ninguém" é o estado em que qualquer colega desliga.
        owner_user_id: user.id,
      })
      .select("id")
      .single();
    if (insertErr || !inserted) throw new Error(`voice_calls insert: ${insertErr?.message}`);

    void audit({
      action: "voice.call_started",
      actorUserId: user.id,
      organizationId: activeOrg.orgId,
      resourceType: "voice_call",
      resourceId: (inserted as { id: string }).id,
      requestId,
      metadata: { contact_id: contact.id, direction: "outbound" },
    });

    return ok(
      { id: (inserted as { id: string }).id, callId: call.callId, status: "starting" },
      { requestId, status: 201 },
    );
  } catch (err) {
    logger.error("wacalls: chamada outbound falhou", {
      request_id: requestId,
      organization_id: activeOrg.orgId,
      contact_id: contact.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return fail("wacalls_error", wacallsFriendlyError(err), 502, { requestId });
  }
}
