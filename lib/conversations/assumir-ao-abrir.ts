/**
 * QUEM ABRE A CONVERSA PELO CARTÃO DE CONTATO A ASSUME, se ela está livre.
 *
 * `ensureConversation` cria a conversa SEM DONO. Com a visibilidade "só o que é
 * seu" (`visibility_mode = own`), a atendente que clica num contato era levada a
 * uma conversa que a própria regra de visibilidade escondia: tela em branco, e o
 * cliente esperando na fila de uma distribuição que podia não ter ninguém
 * elegível. Gerente e administrador enxergam todas as conversas, então não
 * precisam assumir — e não devem tirar a conversa da distribuição só por abrir um
 * cartão.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** O que o chamador (a rota) sabe de quem clicou — o recorte do `resolveAuthDual`. */
export interface QuemClicou {
  via: string;
  actor: { type: string; id: string };
  organizationId: string;
  /** Cliente da SESSÃO: a função de atribuição confere o cargo de quem chama. */
  supabase: Pick<SupabaseClient, "rpc">;
}

interface DonoDaConversa {
  assigned_to_user_id: string | null;
  assigned_to_user_name: string | null;
}

/**
 * Atribui a conversa livre à ATENDENTE que clicou. Devolve o nome do dono atual
 * quando a conversa é de OUTRA pessoa e a atendente não a enxerga (a tela avisa em
 * vez de abrir uma página em branco); `null` em todos os outros casos.
 *
 * Só a sessão de navegador e só o cargo `agent`: token de servidor não "assume"
 * nada. Nunca tira a conversa de quem já a tem — `p_enforce_expected` com dono
 * esperado nulo só assume se estiver livre.
 */
export async function assumeParaQuemClicou(
  quem: QuemClicou,
  admin: SupabaseClient,
  conversationId: string,
): Promise<string | null> {
  if (quem.via !== "session" || quem.actor.type !== "user") return null;
  const userId = quem.actor.id;

  const { data: vinculo } = await admin
    .from("user_organizations")
    .select("role")
    .eq("organization_id", quem.organizationId)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .maybeSingle();
  if ((vinculo as { role?: string } | null)?.role !== "agent") return null;

  const lerDono = async (): Promise<DonoDaConversa | null> => {
    const { data } = await admin
      .from("conversations")
      .select("assigned_to_user_id, assigned_to_user_name")
      .eq("organization_id", quem.organizationId)
      .eq("id", conversationId)
      .maybeSingle();
    return data as DonoDaConversa | null;
  };

  let dono = await lerDono();
  if (!dono || dono.assigned_to_user_id === userId) return null;

  if (dono.assigned_to_user_id === null) {
    const { data: linhas, error } = await quem.supabase.rpc("fn_conversation_assign", {
      p_organization_id: quem.organizationId,
      p_conversation_id: conversationId,
      p_to_user_id: userId,
      p_reason: "claim",
      p_enforce_expected: true,
    });
    if (!error && Array.isArray(linhas) && linhas[0]) return null;
    // Perdeu a corrida (outra pessoa assumiu no meio): reler para avisar o dono certo.
    dono = await lerDono();
    if (!dono || dono.assigned_to_user_id === userId) return null;
  }

  return dono.assigned_to_user_name?.trim() || "outra atendente";
}
