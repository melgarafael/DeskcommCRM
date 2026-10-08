/**
 * Recarregar a aba — O ÚNICO caminho é o pedido de quem está na tela (o botão
 * do aviso da #2335). Separado num módulo próprio de propósito: é o que o teste
 * mocka para prover que NADA recarrega sozinho quando a organização diverge.
 */
export function recarregarAba(): void {
  if (typeof window === "undefined") return;
  window.location.reload();
}
