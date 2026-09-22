import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * O BLOQUEIO DE CRÉDITO — uma regra, dois chamadores (POST cria, PATCH aprova).
 *
 * Conta como "em aberto" todo pedido comprometido: fora de rascunho (intenção,
 * não compromisso), entregue (ciclo encerrado) e cancelado (morto). Rascunho
 * novo nunca é barrado — a barreira aparece quando ele vira compromisso.
 *
 * Sem limite definido (NULL) não há o que estourar: a ausência de análise de
 * crédito é visível na ficha, não um zero que barra tudo.
 */

const STATUS_EM_ABERTO = ["em_analise", "aprovado", "faturado", "expedido"];

export interface SituacaoDeCredito {
  /** false = sem limite definido; não há bloqueio possível. */
  temLimite: boolean;
  limite_cents: number | null;
  em_aberto_cents: number;
}

export async function situacaoDeCredito(
  supabase: SupabaseClient,
  orgId: string,
  contactId: string,
): Promise<SituacaoDeCredito> {
  const [{ data: contato }, { data: abertos }] = await Promise.all([
    supabase
      .from("contacts")
      .select("limite_credito_cents")
      .eq("id", contactId)
      .eq("organization_id", orgId)
      .maybeSingle(),
    supabase
      .from("commercial_orders")
      .select("total_cents")
      .eq("organization_id", orgId)
      .eq("contact_id", contactId)
      .in("status", STATUS_EM_ABERTO),
  ]);

  const limite = (contato as unknown as { limite_credito_cents: number | null } | null)
    ?.limite_credito_cents ?? null;
  const emAberto = (abertos ?? []).reduce(
    (s: number, p: unknown) => s + ((p as { total_cents: number }).total_cents ?? 0),
    0,
  );
  return { temLimite: limite !== null, limite_cents: limite, em_aberto_cents: emAberto };
}

/** true = cabe no limite (ou não há limite); false = estoura. */
export function cabeNoCredito(situacao: SituacaoDeCredito, novoTotalCents: number): boolean {
  if (!situacao.temLimite || situacao.limite_cents === null) return true;
  return situacao.em_aberto_cents + novoTotalCents <= situacao.limite_cents;
}
