import { normalizePhoneBR } from "@/lib/channels/phone-variants";

/** O que foi digitado vira telefone (E.164) ou e-mail; nenhum dos dois, `null`. */
export function telefoneOuEmail(
  texto: string,
): { phone_number: string } | { email: string } | null {
  const limpo = texto.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(limpo)) return { email: limpo.toLowerCase() };
  const telefone = normalizePhoneBR(limpo);
  return telefone ? { phone_number: telefone } : null;
}
