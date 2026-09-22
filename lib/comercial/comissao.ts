/**
 * COMISSÃO DO PEDIDO — matemática pura.
 *
 * A regra mora no PRODUTO (`catalog_products.comissao_pct`, NULL = sem regra),
 * como no Mercos. A comissão do pedido é a soma por item de
 * `subtotal × pct / 100`, com `Math.round` por item (mesma doutrina do
 * `subtotalDoItem`: truncar some centavos sem ninguém ver).
 */
export interface ItemComissionavel {
  subtotal_cents: number;
  comissao_pct: number | null;
}

export function comissaoDoItem(subtotalCents: number, pct: number | null): number {
  if (pct == null || pct <= 0) return 0;
  return Math.round((subtotalCents * Math.min(100, pct)) / 100);
}

export function comissaoDoPedido(itens: ItemComissionavel[]): { cents: number; base_cents: number } {
  let cents = 0;
  let base = 0;
  for (const it of itens) {
    if (it.comissao_pct != null && it.comissao_pct > 0) base += it.subtotal_cents;
    cents += comissaoDoItem(it.subtotal_cents, it.comissao_pct);
  }
  return { cents, base_cents: base };
}
