import type { Lead } from "@/lib/types/leads";

/** Soma apenas valores da mesma moeda; não há conversão cambial no quadro. */
export function totaisPorMoeda(leads: Pick<Lead, "currency" | "value_cents">[]) {
  const totais = new Map<string, number>();
  for (const lead of leads) {
    if (lead.value_cents == null) continue;
    const currency = lead.currency ?? "BRL";
    totais.set(currency, (totais.get(currency) ?? 0) + lead.value_cents);
  }
  return [...totais]
    .filter(([, cents]) => cents > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, cents]) => ({ currency, cents }));
}
