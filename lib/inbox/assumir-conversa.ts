/**
 * Assume pela sessão e conserva os efeitos do botão Assumir (#3479).
 *
 * Abrir uma conversa e assumir pelo botão passam pela MESMA regra: só quem
 * venceu o CAS audita, emite o evento e registra a timeline. Zero linhas
 * continua sendo no-op; a rota /claim decide se responde 409. Não muda seu
 * contrato nem reexecuta efeitos para o dono atual.
 *
 * #4019 — o negócio ABERTO do contato é decidido dentro da própria
 * `fn_conversation_assign`, na MESMA transação (migration 9208). Num `claim`
 * (Assumir e Iniciar conversa) ela só dá dono a negócio SEM responsável: nunca
 * tira o card de um colega (decisão do #3216, reafirmada no doc 267).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/api/handlers/types";
import { registrarTrocaDeComando } from "@/lib/inbox/atividade-de-comando";
import type { Conversation } from "@/lib/types/messaging";

export async function assumirConversaComEfeitos(
  supabase: SupabaseClient,
  p: {
    organizationId: string;
    conversationId: string;
    actor: Extract<Actor, { type: "user" }>;
    requestId: string;
    expectedAssignee?: string | null;
  },
): Promise<{ conversation: Conversation | null; error: { message: string } | null }> {
  // Optimistic lock (spec 04 §9.2): expected null/omitido = só assume se livre;
  // expected uuid = takeover consciente. UPDATE + evento na mesma transação.
  const { data, error } = await supabase.rpc("fn_conversation_assign", {
    p_organization_id: p.organizationId,
    p_conversation_id: p.conversationId,
    p_to_user_id: p.actor.id,
    p_reason: "claim",
    ...(p.expectedAssignee ? { p_expected_assignee: p.expectedAssignee } : {}),
    p_enforce_expected: true,
  });

  if (error) {
    return { conversation: null, error };
  }
  const row = data?.[0];
  if (!row) {
    return { conversation: null, error: null };
  }

  const conv = row as unknown as Conversation;

  await audit({
    action: "conversation.claimed",
    actorUserId: p.actor.id,
    organizationId: conv.organization_id,
    resourceType: "conversation",
    resourceId: conv.id,
    requestId: p.requestId,
  });

  await supabase
    .rpc("emit_event", {
      p_event_type: "conversation.claimed",
      p_entity_kind: "conversation",
      p_entity_id: conv.id,
      p_payload: { assigned_to_user_id: p.actor.id },
      p_metadata: { request_id: p.requestId },
      p_organization_id: conv.organization_id,
    })
    .then(({ error: emitErr }) => {
      if (emitErr) console.error("[conversation.claim] emit_event failed", emitErr.message);
    });

  // A linha na TELA. O `emit_event` acima e o audit não são lidos por atendente
  // nenhum; sem esta chamada, assumir uma conversa era invisível na timeline —
  // grep por atividade nas três rotas de troca de dono devolvia zero.
  await registrarTrocaDeComando({
    supabase,
    organizationId: conv.organization_id,
    conversationId: conv.id,
    contactId: conv.contact_id,
    tipo: "conversation_claimed",
    actor: p.actor,
    // Canônico em português: quem traduz é a LEITURA (`t(item.reason)`). Ver o
    // bloco "vocabulario de dominio persistido" em `lib/i18n/dicionario.ts`.
    motivo: "Assumiu o atendimento desta conversa",
  });

  return { conversation: conv, error: null };
}
