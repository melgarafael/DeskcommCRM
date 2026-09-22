/**
 * FORMATAÇÃO COMERCIAL CANÔNICA — um só lugar.
 *
 * `comoMoeda` e `numeroDoPedido` viviam copiados em `pedidos/_client.tsx` e
 * `products/_client.tsx`, e outras dez telas importavam de dentro da página de
 * pedidos (`@/app/app/pedidos/_client`) — acoplando a tela inteira a quem só
 * queria formatar um número. Mesmo comportamento = mesmo módulo.
 */

/** O valor como quem vende lê. */
export function comoMoeda(cents: number, moeda: string): string {
  const v = (cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 });
  return moeda === "BRL" ? `R$ ${v}` : `${moeda} ${v}`;
}

/** O número do pedido como aparece na tela e no PDF. */
export function numeroDoPedido(numero: number): string {
  return `PED-${String(numero).padStart(4, "0")}`;
}
