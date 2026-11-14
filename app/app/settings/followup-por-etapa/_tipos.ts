/**
 * O que a tela de Entrada e follow-up passa para os dois cartões.
 *
 * Fica num arquivo próprio e não no `page.tsx` porque um componente de cliente
 * que importasse o tipo da página arrastaria a página inteira (com `requireAuth`,
 * `createClient` e as consultas) para o grafo do navegador — o `import type` some
 * na compilação, mas a proximidade convida ao import normal na primeira pressa.
 */

/** Um funil aberto e as etapas ABERTAS dele, na ordem do quadro. */
export interface FunilDaTela {
  id: string;
  name: string;
  etapas: Array<{ id: string; name: string }>;
}
