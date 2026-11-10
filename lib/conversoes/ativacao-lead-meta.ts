/** Corte por organização do envio causal de LeadSubmitted. Ausência ou valor inválido desliga. */
const ISO_COM_ZONA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d{1,6}))?(?:Z|[+-]\d{2}:\d{2})$/;

function microsDoBanco(valor: unknown): bigint | null {
  if (typeof valor !== "string") return null;
  const partes = ISO_COM_ZONA.exec(valor);
  if (!partes) return null;
  const millis = Date.parse(valor);
  if (!Number.isFinite(millis)) return null;
  // Date.parse perde os três últimos dígitos de um timestamptz do Postgres.
  const micros = Number((partes[1] ?? "").padEnd(6, "0"));
  return BigInt(millis) * 1000n + BigInt(micros % 1000);
}

export function ativacaoLeadMeta(valor: unknown): bigint | null {
  return microsDoBanco(valor);
}

export function leadNasceuAposAtivacao(ativadaEmValor: unknown, createdAt: string): boolean {
  const ativadaEm = microsDoBanco(ativadaEmValor);
  const nasceuEm = microsDoBanco(createdAt);
  return ativadaEm !== null && nasceuEm !== null && nasceuEm > ativadaEm;
}
