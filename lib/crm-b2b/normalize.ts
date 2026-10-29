/**
 * Normalização de CNPJ (só dígitos, 14) e nome (casefold + espaços).
 * Não toca em organizations.cnpj — empresas clientes vivem em `companies`.
 */
import { isValidCnpj } from "@/lib/cobranca/documento";

/**
 * Devolve os 14 dígitos do CNPJ, ou `null` quando formato/DV são inválidos.
 *
 * O TAMANHO não basta: `11.222.333/0001-00` tem 14 dígitos e não é CNPJ de
 * válido. Antes desta régua a empresa entrava com o número errado, e o erro
 * só aparecia depois, ao tentar enriquecer o cadastro. O checksum confere o
 * dígito; ele não comprova existência nem situação cadastral na Receita.
 *
 * Quem confere o dígito é `isValidCnpj`, a MESMA função que a cobrança usa no
 * documento do pagador (mod-11 da Receita). Uma implementação só: duas réguas
 * divergiriam no dia em que uma aprendesse um caso novo.
 *
 * O CNPJ alfabético da Receita (12 posições alfanuméricas + 2 dígitos) ainda
 * NÃO passa por aqui: `companies.normalized_cnpj` tem
 * `check (normalized_cnpj ~ '^\d{14}$')`, e aceitar letras exigiria migration.
 */
export function normalizeCnpj(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length !== 14) return null;
  // `isValidCnpj` já recusa a sequência trivial (000... / 111...) e o DV errado.
  return isValidCnpj(digits) ? digits : null;
}

export function formatCnpj(normalized: string): string {
  const d = normalized.replace(/\D/g, "");
  if (d.length !== 14) return normalized;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

export function normalizePersonName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const collapsed = raw
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return collapsed.length > 0 ? collapsed : null;
}
