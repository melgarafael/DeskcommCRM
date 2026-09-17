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
import { resolverNumeroDiscavel } from "@/lib/voice/numero-discavel";
import { getWacallsClient, wacallsFriendlyError, wacallsSemConexao } from "@/lib/wacalls/client";
import { resolveWacallsSession } from "@/lib/wacalls/session";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ contactId: z.string().uuid() });

/**
 * As colunas que o painel (`VoiceCallRow`, `hooks/voice/useVoiceCallSession.ts`)
 * lê. A resposta devolve a linha inteira porque o painel decide "é minha?" por
 * `owner_user_id`/`created_by`: uma resposta só com `{id, status}` escondia o
 * painel de quem discou.
 */
const COLUNAS_DO_PAINEL =
  "id, contact_id, direction, peer_phone, status, end_reason, started_at, answered_at, owner_user_id, created_by";

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
    // O cadastro guarda o celular COM o nono dígito; o WhatsApp pode tê-lo
    // registrado SEM. Discar o do cadastro mandava a oferta para um endereço
    // inexistente — ver o cabeçalho de `lib/voice/numero-discavel.ts`.
    const destino = await resolverNumeroDiscavel(supabase, activeOrg.orgId, contact.phone_number);
    if (destino.fonte === "cadastro") {
      logger.warn("wacalls: número discado sem confirmação do WhatsApp", {
        request_id: requestId,
        organization_id: activeOrg.orgId,
        contact_id: contact.id,
      });
    }
    const call = await wacalls.startCall(session.wacallsSessionId, user.id, destino.digitos);

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
      .select(COLUNAS_DO_PAINEL)
      .single();

    let linha = inserted as ({ id: string; status: string } & Record<string, unknown>) | null;
    if (insertErr?.code === "23505") {
      // A PONTE DE EVENTOS CHEGOU PRIMEIRO — e ela chega primeiro SEMPRE.
      //
      // O WaCalls emite `call-status` na `/api/events` no instante em que envia
      // a oferta, antes de responder este `startCall`; o worker grava a linha
      // por `pg` direto (~200 ms na frente deste INSERT, que passa pelo
      // PostgREST). Medido na VPS em 2026-09-15: duas ligações, dois
      // `duplicate key value violates unique constraint
      // "voice_calls_organization_id_wacalls_call_id_key"`, dois 502 na tela
      // com o telefone do outro lado tocando.
      //
      // A linha da ponte é a MESMA ligação, só que escrita por quem não sabe o
      // que esta rota sabe: que foi alguém daqui que discou, para este contato.
      // Então completa-se a linha em vez de recusar — e o `status` fica de
      // fora de propósito: o da ponte é mais novo que o "starting" daqui.
      const { data: reconciliada, error: reconcErr } = await supabase
        .from("voice_calls")
        .update({
          direction: "outbound",
          contact_id: contact.id,
          created_by: user.id,
          owner_user_id: user.id,
          updated_at: new Date().toISOString(),
        })
        .eq("organization_id", activeOrg.orgId)
        .eq("wacalls_call_id", call.callId)
        .select(COLUNAS_DO_PAINEL)
        .single();
      if (reconcErr || !reconciliada) {
        throw new Error(`voice_calls reconcile: ${reconcErr?.message}`);
      }
      linha = reconciliada as { id: string; status: string } & Record<string, unknown>;
    } else if (insertErr || !linha) {
      throw new Error(`voice_calls insert: ${insertErr?.message}`);
    }

    void audit({
      action: "voice.call_started",
      actorUserId: user.id,
      organizationId: activeOrg.orgId,
      resourceType: "voice_call",
      resourceId: linha.id,
      requestId,
      metadata: { contact_id: contact.id, direction: "outbound" },
    });

    return ok({ ...linha, callId: call.callId }, { requestId, status: 201 });
  } catch (err) {
    logger.error("wacalls: chamada outbound falhou", {
      request_id: requestId,
      organization_id: activeOrg.orgId,
      contact_id: contact.id,
      error: err instanceof Error ? err.message : String(err),
    });
    // Socket do WhatsApp caído — ver o cabeçalho de `wacallsSemConexao` para o
    // que isso É (queda de rede passageira) e para o que já NÃO É (o cliente
    // morto que `/pair` deixava para trás, resolvido na rota de pareamento).
    // 503 e não 502, porque a distinção não é cosmética: `lib/api/client.ts`
    // repete 503 (até 3 tentativas, espaçadas pelo `Retry-After`), e repetir
    // AQUI é seguro — o erro nasce ANTES de qualquer `<call>` sair para o
    // telefone, então nada foi discado duas vezes.
    if (wacallsSemConexao(err)) {
      return fail("wacalls_not_connected", wacallsFriendlyError(err), 503, {
        requestId,
        headers: { "Retry-After": "3" },
      });
    }
    return fail("wacalls_error", wacallsFriendlyError(err), 502, { requestId });
  }
}
