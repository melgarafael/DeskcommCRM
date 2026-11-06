/**
 * O VOCABULÁRIO DO GATEWAY DE PAGAMENTO DA ORGANIZAÇÃO (issue #4058, fatia 1).
 *
 * O lado TypeScript dos CHECKs de `organization_payment_gateways` (migration
 * 9222). Os dois pares são cobrados por
 * `tests/invariants/vocabulario-banco-x-typescript.test.ts` contra o Postgres
 * descartável: valor novo entra no CHECK (migration + bloco do baseline) e aqui,
 * no MESMO commit.
 *
 * `PROVEDORES_DE_PAGAMENTO` é a lista dos provedores em que a ORGANIZAÇÃO pode
 * cobrar o cliente dela. Hoje são os mesmos dois do registro de adaptadores da
 * instalação (`lib/cobranca/provedores`), e é de propósito que a lista seja
 * própria em vez de um alias: o dia em que um deles só fizer sentido para o
 * revendedor (ou aparecer um que só faça sentido para a empresa — Pix direto,
 * Mercado Pago), as duas listas divergem sem quebrar a outra ponta. Quem
 * garante que o adaptador EXISTE para cada valor é o `switch` exaustivo de
 * `adaptador()`.
 */
export const PROVEDORES_DE_PAGAMENTO = ["stripe", "asaas"] as const;
export type ProvedorDePagamento = (typeof PROVEDORES_DE_PAGAMENTO)[number];

/**
 * `teste` | `producao` — o MESMO vocabulário do resto da cobrança
 * (`lib/cobranca/vocabulario`), e derivado do prefixo da chave, nunca digitado:
 * ver `modoDaChave` em `./modo-da-chave`.
 */
export const MODOS_DE_PAGAMENTO = ["teste", "producao"] as const;
export type ModoDePagamento = (typeof MODOS_DE_PAGAMENTO)[number];

export function ehProvedorDePagamento(valor: unknown): valor is ProvedorDePagamento {
  return typeof valor === "string" && (PROVEDORES_DE_PAGAMENTO as readonly string[]).includes(valor);
}
