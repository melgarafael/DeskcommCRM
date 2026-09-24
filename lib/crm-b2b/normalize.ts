/**
 * Normalização de CNPJ (só dígitos, 14) e nome (casefold + espaços).
 * Não toca em organizations.cnpj — empresas clientes vivem em `companies`.
 */

export function normalizeCnpj(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length !== 14) return null;
  // Rejeita sequência trivial (000... / 111...).
  if (/^(\d)\1{13}$/.test(digits)) return null;
  return digits;
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
