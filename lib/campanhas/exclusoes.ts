/**
 * A lista de exclusão da OPERAÇÃO — "não mande campanha para este número".
 *
 * ═══ Por que não é opt-out ═══
 *
 * Opt-out é do TITULAR: ele pediu para parar, e `contacts.is_blocked` responde
 * por isso no produto inteiro — o agente também para. A exclusão aqui é uma
 * decisão de quem opera ("este número é do contador", "este é um concorrente",
 * "este cliente a gente fala por telefone"), e ela não pode virar bloqueio
 * geral: se a pessoa escrever, o atendimento responde normalmente.
 *
 * Por isso são duas listas, e não uma com um campo a mais. Juntá-las faria a
 * decisão operacional silenciar o atendimento — o oposto do que quem excluiu
 * quis dizer.
 *
 * ═══ Por que hash ═══
 *
 * Dedup e consulta funcionam igual com hash, e uma lista de "não mandar" não
 * precisa ser mais um lugar onde telefone de gente mora. O que fica legível são
 * os últimos dígitos, o suficiente para a pessoa reconhecer o que ela mesma
 * cadastrou.
 */
import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * O hash do endereço. Normaliza antes: o que entra pela tela pode vir com
 * espaço, traço e parêntese, e `+55 (48) 99999-0000` tem de casar com
 * `+5548999990000` — senão a exclusão existe e não pega.
 *
 * O mesmo cálculo está documentado no comentário da coluna (migration 0376):
 * mudar um lado sem o outro faz a lista parar de casar, em silêncio.
 */
export function hashDoEndereco(bruto: string): string {
  const normalizado = normalizarEndereco(bruto);
  return createHash("sha256").update(normalizado, "utf8").digest("hex");
}

/** Só dígitos, com o `+` na frente — a mesma forma de `contacts.phone_number`. */
export function normalizarEndereco(bruto: string): string {
  const digitos = (bruto ?? "").replace(/\D/g, "");
  return digitos === "" ? "" : `+${digitos}`;
}

/** Os últimos dígitos, para a tela. Nunca o número inteiro. */
export function finalDoEndereco(bruto: string): string {
  const n = normalizarEndereco(bruto);
  return n.length <= 4 ? n : n.slice(-4);
}

/** Um endereço só vira exclusão se for telefone de verdade. */
export function enderecoValido(bruto: string): boolean {
  return /^\+\d{8,15}$/.test(normalizarEndereco(bruto));
}

/**
 * Os hashes excluídos da organização.
 *
 * Devolve `Set` porque quem chama é a classificação da audiência, que pergunta
 * uma vez por lista e consulta por contato — e uma consulta por contato numa
 * lista de 500 seriam 500 idas ao banco.
 */
export async function hashesExcluidos(
  admin: SupabaseClient,
  organizationId: string,
): Promise<Set<string>> {
  const { data, error } = await admin
    .from("campaign_suppressions")
    .select("recipient_address_hash")
    .eq("organization_id", organizationId);
  if (error) throw new Error(`exclusões: leitura — ${error.message}`);
  return new Set(
    (data ?? []).map((l) => (l as { recipient_address_hash: string }).recipient_address_hash),
  );
}
