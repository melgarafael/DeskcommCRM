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

/**
 * O VOCABULÁRIO DO RECEBIMENTO DO CLIENTE FINAL (issue #3509).
 *
 * ─── O eixo, para não confundir com o outro ─────────────────────────────────
 *
 * `lib/cobranca` é o DONO da instalação cobrando as empresas dele (assinatura do
 * CRM). Isto aqui é o contrário: a empresa cobrando o CLIENTE dela. São dois
 * eixos, dois vocabulários e duas tabelas — e o dia em que alguém achar que dá
 * para reaproveitar `cobranca_assinaturas` para isso é o dia em que o extrato do
 * dono passa a ter pagamento de terceiro dentro.
 *
 * ─── Por que `provavel` não existe ──────────────────────────────────────────
 *
 * O estado de um recebimento é o que o BANCO diz (`pagamento_recebimentos.
 * status`), e ele só muda em duas portas: o registro do link (nasce `pendente`)
 * e o aviso do provedor (vira `paga` uma vez). Não há "provavelmente pago":
 * conciliação de extrato é uma fatia seguinte, e um estado intermediário hoje
 * seria um lugar para o código fingir certeza que não tem.
 */

/** Os provedores que este degrau conhece. Um nome novo entra aqui + no adaptador de aviso. */
export const PROVEDORES_DE_RECEBIMENTO = ["infinitepay"] as const;
export type ProvedorDeRecebimento = (typeof PROVEDORES_DE_RECEBIMENTO)[number];

/** O nome do provedor como a pessoa o conhece — o que a timeline escreve. */
export const NOME_DO_PROVEDOR: Record<ProvedorDeRecebimento, string> = { infinitepay: "InfinitePay" };

export function ehProvedorDeRecebimento(bruto: string): bruto is ProvedorDeRecebimento {
  return (PROVEDORES_DE_RECEBIMENTO as readonly string[]).includes(bruto);
}

/**
 * O estado do recebimento — o MESMO vocabulário do CHECK da tabela (migration
 * 9312). Duas listas existem porque o banco precisa recusar sozinho (um `psql`
 * na mão não passa por este arquivo); o par é medido em
 * `tests/invariants/vocabulario-banco-x-typescript.test.ts`.
 */
export const SITUACOES_DO_RECEBIMENTO = [
  "pendente",
  "paga",
  "expirada",
  "cancelada",
  "estornada",
] as const;
export type SituacaoDoRecebimento = (typeof SITUACOES_DO_RECEBIMENTO)[number];

/**
 * Os nomes de evento que CONFIRMAM pagamento.
 *
 * ⚠️ Esta lista é a nossa leitura do contrato público, não uma tradução
 * verificada: a InfinitePay não documenta assinatura nem publica um enum estável
 * de eventos (ver a pergunta 3 da issue #3509). Por isso ela é TOLERANTE para
 * nomes conhecidos e FECHADA para o resto: evento fora daqui não muda nada e
 * devolve `ignorado`. O que NÃO se faz é tratar "não sei o que é" como pago.
 */
export const EVENTOS_QUE_PAGAM = ["paid", "settled", "payment.paid", "pago", "aprovado"] as const;

/** Evento de pagamento já não vale mais (estorno/cancelamento): não vira `paga`. */
export const EVENTOS_QUE_ENCERRAM = ["refunded", "canceled", "cancelled", "expired", "estornado"] as const;

/** O corpo de um aviso de pagamento é pequeno: id do evento e alguns campos. */
export const LIMITE_DO_CORPO = 1_048_576;

/**
 * Teto do valor. Não é regra de negócio: é o limite em que um `valor` absurdo
 * (dígito a mais, centavos em unidade errada) para de ser possível sem alguém
 * perceber. R$ 1.000.000,00.
 */
export const VALOR_MAXIMO_CENTS = 100_000_000;

/** O id do pagamento no provedor cabe em 128 caracteres em qualquer formato que já vimos. */
export const TAMANHO_MAXIMO_DO_ID_EXTERNO = 128;
