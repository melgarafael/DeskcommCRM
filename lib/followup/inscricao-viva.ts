import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A INSCRIÇÃO VIVA — o predicado do índice único, numa fonte só.
 *
 * O que faz a ação `start_message_flow` devolver `live_enrollment_exists` é o
 * banco recusando o INSERT com `23505` no índice parcial
 * `idx_followup_enrollments_one_live`
 * (`organization_id, contact_id`, `where status in (active, waiting_reply,
 * paused_handoff, paused_manual)`). Este módulo é a LEITURA desse mesmo
 * predicado, e existe para que quem precisa perguntar antes de tentar — a
 * varredura de silêncio e, agora, a condição "contato tem follow-up vivo" da
 * regra — pergunte EXATAMENTE o que o banco exige.
 *
 * Antes desta fonte, cada consumidor repetia a sua cópia da lista de status (o
 * próprio `silence-sweep.ts` dizia isso no comentário: "não há constante
 * exportada compartilhada; cada consumidor já repete a própria cópia"). Duas
 * cópias divergem em silêncio: uma condição que perguntasse por `active` só
 * diria "não" para quem está em `paused_handoff`, e a regra mandaria a ação
 * tentar de novo — a tentativa que o índice recusa, com tupla morta e 409 no
 * gateway.
 *
 * Uma lista de status para os dois lados: quem MEXER nela mexe no predicado do
 * índice na migration e aqui, e é o teste
 * `lib/automation/fatos-do-contato.test.ts` que cobra a igualdade (ele compara
 * a cadeia de chamadas das duas leituras, argumento por argumento).
 */
export const STATUS_VIVOS = ["active", "waiting_reply", "paused_handoff", "paused_manual"] as const;

/** Quantos contatos por `in(...)`: a lista viaja na URL do PostgREST. */
export const LOTE_DE_CONTATOS = 100;

/**
 * Dos `contactIds`, quais JÁ têm um enrollment VIVO (qualquer fluxo da org — o
 * índice único é por organização e contato). Uma pergunta para o lote inteiro,
 * nunca uma por contato: quem chama em laço faz N+1.
 *
 * Lista vazia não vira consulta: `in("contact_id", [])` no PostgREST é uma
 * ida ao banco para receber nada.
 */
export async function lerContatosComInscricaoViva(
  supabase: SupabaseClient,
  orgId: string,
  contactIds: readonly string[],
): Promise<Set<string>> {
  const vivos = new Set<string>();
  if (contactIds.length === 0) return vivos;
  for (let i = 0; i < contactIds.length; i += LOTE_DE_CONTATOS) {
    const { data, error } = await supabase
      .from("followup_enrollments")
      .select("contact_id")
      .eq("organization_id", orgId)
      .in("status", [...STATUS_VIVOS])
      .in("contact_id", contactIds.slice(i, i + LOTE_DE_CONTATOS));
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as Array<{ contact_id: string }>) vivos.add(row.contact_id);
  }
  return vivos;
}
