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

export function ehProvedorDeRecebimento(bruto: string): bruto is ProvedorDeRecebimento {
  return (PROVEDORES_DE_RECEBIMENTO as readonly string[]).includes(bruto);
}

/**
 * O estado do recebimento — o MESMO vocabulário do CHECK da tabela (migration
 * 9043). Duas listas existem porque o banco precisa recusar sozinho (um `psql`
 * na mão não passa por este arquivo); o par é medido em
 * `lib/pagamentos/vocabulario.test.ts`.
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
 * A janela do carimbo de tempo na assinatura HMAC, em segundos. É a mesma
 * pergunta da Stripe (`TOLERANCIA_DO_WEBHOOK_S`): sem janela, uma assinatura
 * capturada vale para sempre, e o aviso de pagamento é justamente o que não pode
 * ser reentregue fora de hora.
 */
export const TOLERANCIA_DO_AVISO_S = 300;

/**
 * Teto do valor. Não é regra de negócio: é o limite em que um `valor` absurdo
 * (dígito a mais, centavos em unidade errada) para de ser possível sem alguém
 * perceber. R$ 1.000.000,00.
 */
export const VALOR_MAXIMO_CENTS = 100_000_000;

/** O id do pagamento no provedor cabe em 128 caracteres em qualquer formato que já vimos. */
export const TAMANHO_MAXIMO_DO_ID_EXTERNO = 128;

/** O teto do link: URL de checkout é curta; 2048 é o teto prático de navegador. */
export const TAMANHO_MAXIMO_DO_LINK = 2048;
