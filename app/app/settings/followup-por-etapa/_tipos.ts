/**
 * O que a tela de Follow-up por etapa passa para o cartão.
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

/**
 * Um fluxo de "negócio parado na mesma etapa" — a regra de `automation_rules`
 * que guarda o prazo. É o MESMO tipo que `lib/automation/prazos-da-etapa-parada`
 * produz, reexportado aqui para o componente de cliente não importar da página.
 */
export type { FluxoDeEtapaParada as FluxoDaTela } from "@/lib/automation/prazos-da-etapa-parada";
