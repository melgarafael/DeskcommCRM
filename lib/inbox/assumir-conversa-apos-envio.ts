/**
 * A RESPOSTA HUMANA ASSUME A CONVERSA — a MESMA regra para quem envia e para
 * quem encaminha (#2835, item 2 do CR).
 *
 * ─── Por que um helper, e não duas cópias ───────────────────────────────────
 *
 * Quando a empresa liga "a conversa fica com quem atendeu"
 * (`settings.routing.conversation_stays_with_attendant`), uma resposta humana
 * pelo Inbox ASSUME a conversa livre: a RPC `fn_conversation_assign` faz o claim
 * condicional, o `audit` grava `conversation.claimed`, a linha do tempo recebe a
 * troca de comando e o mesmo evento do botão Assumir é emitido.
 *
 * Esse bloco morava só na rota `POST /api/v1/messages`, e o encaminhamento
 * (`lib/inbox/encaminhar-mensagem.ts`) — que é envio pelo MESMO handler — não o
 * executava: quem encaminhava respondia ao cliente e a conversa continuava livre
 * para outro atendente. A tentação era copiar o bloco; copiar garantiria que,
 * no dia em que a regra ganhasse um detalhe, uma das duas cópias ficasse velha em
 * silêncio. Por isso a regra virou ESTE helper, chamado pelos DOIS caminhos de
 * escrita do Inbox.
 *
 * ─── Quem assume, e quem não assume ─────────────────────────────────────────
 *
 * Só a SESSÃO do navegador (`via: "session"`) e só um ator HUMANO
 * (`actor.type === "user"`): token de servidor e IA não são "quem atendeu", e
 * assumir em nome deles seria mentir na linha do tempo. Uma linha `failed` não
 * assume nada — não houve resposta ao cliente.
 *
 * ─── A falha do claim NUNCA vira falha de envio ─────────────────────────────
 *
 * O envio já pode ter sido aceito pelo canal quando esta função roda (ela é
 * chamada DEPOIS do handler). Portanto tudo aqui é engolido com log: um claim
 * que falha não pode fazer o operador reenviar a mensagem e duplicá-la na
 * conversa do cliente.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
import { registrarTrocaDeComando } from "@/lib/inbox/atividade-de-comando";
import { conversaFicaComQuemAtendeu } from "@/lib/schemas/routing";

export interface AssumirConversaAposEnvioParams {
  supabase: SupabaseClient;
  organizationId: string;
  actor: Actor;
  requestId: string;
  /** De ONDE veio a escrita: só a sessão do navegador é "quem atendeu". */
  via: "session" | "token";
  /** A conversa que a mensagem acabou de usar — a que pode ser assumida. */
  conversationId: string | null | undefined;
  /** O status da linha criada; `failed` não assume nada. */
  status: string;
}

/**
 * Assume a conversa livre depois de um envio humano, quando a empresa ligou a
 * regra. Idempotente por natureza: quem já é o dono não passa no claim
 * condicional (`p_enforce_expected`), e a função simplesmente não faz nada.
 */
export async function assumirConversaAposEnvio(
  p: AssumirConversaAposEnvioParams,
): Promise<void> {
  if (p.via !== "session" || p.actor.type !== "user" || p.status === "failed") return;
  if (!p.conversationId) return;

  try {
    const { data: org, error: orgError } = await p.supabase
      .from("organizations")
      .select("settings")
      .eq("id", p.organizationId)
      .maybeSingle();
    if (orgError) throw orgError;
    if (!conversaFicaComQuemAtendeu(org?.settings)) return;

    const { data: claimed, error: claimError } = await p.supabase.rpc("fn_conversation_assign", {
      p_organization_id: p.organizationId,
      p_conversation_id: p.conversationId,
      p_to_user_id: p.actor.id,
      p_reason: "claim",
      p_enforce_expected: true,
    });
    if (claimError) throw claimError;
    if (!claimed?.[0]) return;

    await audit({
      action: "conversation.claimed",
      actorUserId: p.actor.id,
      organizationId: p.organizationId,
      resourceType: "conversation",
      resourceId: p.conversationId,
      requestId: p.requestId,
    });
    // A mesma linha na linha do tempo que o botão Assumir deixa: sem ela, a
    // conversa mudaria de dono sem nenhum registro à vista de quem atende.
    await registrarTrocaDeComando({
      supabase: p.supabase,
      organizationId: p.organizationId,
      conversationId: p.conversationId,
      contactId: (claimed[0] as { contact_id: string | null }).contact_id,
      tipo: "conversation_claimed",
      actor: p.actor,
      motivo: "Assumiu o atendimento desta conversa",
    });
    // O mesmo evento que o botão Assumir emite.
    const { error: emitErr } = await p.supabase.rpc("emit_event", {
      p_event_type: "conversation.claimed",
      p_entity_kind: "conversation",
      p_entity_id: p.conversationId,
      p_payload: { assigned_to_user_id: p.actor.id },
      p_metadata: { request_id: p.requestId },
      p_organization_id: p.organizationId,
    });
    if (emitErr) console.error("[inbox.assumir] emit_event failed", emitErr.message);
  } catch (claimError) {
    console.error("[inbox.assumir] claim after reply failed", claimError);
  }
}
