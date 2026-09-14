/**
 * As regras da comanda que NÃO moram no banco.
 *
 * O schema (migration 0240) garante os invariantes: nada é apagado, saldo é
 * derivado, lançamento pago é imutável, a comissão fica congelada na linha do
 * item. O que sobra para cá são as duas contas que precisam acontecer ANTES do
 * insert, e que por isso não podem ser um CHECK: quanto vale o item, e qual
 * percentual de comissão a organização combinou para aquele par de pessoa e
 * serviço.
 *
 * As duas são puras. Comissão calculada errado é dinheiro que sai errado do
 * bolso de alguém que trabalhou, e isso não se descobre por teste de tela.
 */
import { z } from "zod";

/** Uma linha de `commission_rules`, como a rota a lê. */
export interface RegraDeComissao {
  attendant_user_id: string | null;
  event_type_id: string | null;
  percent: number;
}

/**
 * O percentual que vale para este item, pela precedência combinada.
 *
 * **pessoa + serviço** vence **pessoa**, que vence **serviço**, que vence zero.
 * A ordem não é estética: a regra mais específica é a que alguém escreveu
 * pensando exatamente naquele caso, e deixá-la perder para uma regra geral
 * escrita antes faria a configuração parecer ignorada.
 *
 * Zero quando nada casa, e zero é resposta legítima: nem todo item gera
 * comissão, e inventar um padrão aqui criaria dívida com quem atendeu.
 *
 * ⚠️ Empate dentro do mesmo nível de especificidade resolve pelo MAIOR
 * percentual. Duas regras igualmente específicas são uma configuração
 * ambígua — o schema não a proíbe —, e nesse caso errar a favor de quem
 * trabalhou é a escolha que não precisa ser explicada depois.
 */
export function percentualDaComissao(
  regras: readonly RegraDeComissao[],
  alvo: { attendantUserId: string | null; eventTypeId: string | null },
): number {
  const { attendantUserId, eventTypeId } = alvo;

  const maior = (candidatas: readonly RegraDeComissao[]): number | null =>
    candidatas.length === 0 ? null : Math.max(...candidatas.map((r) => Number(r.percent)));

  if (attendantUserId && eventTypeId) {
    const exatas = maior(
      regras.filter(
        (r) => r.attendant_user_id === attendantUserId && r.event_type_id === eventTypeId,
      ),
    );
    if (exatas !== null) return exatas;
  }

  if (attendantUserId) {
    const porPessoa = maior(
      regras.filter((r) => r.attendant_user_id === attendantUserId && r.event_type_id === null),
    );
    if (porPessoa !== null) return porPessoa;
  }

  if (eventTypeId) {
    const porServico = maior(
      regras.filter((r) => r.event_type_id === eventTypeId && r.attendant_user_id === null),
    );
    if (porServico !== null) return porServico;
  }

  return 0;
}

/**
 * Quanto vale a linha.
 *
 * O desconto do ITEM entra aqui; o desconto da COMANDA não, e a separação é a
 * mesma que o schema faz na comissão: um abatimento dado no caixa não pode
 * reduzir o que foi combinado com quem atendeu.
 *
 * Piso em zero porque um desconto maior que o item viraria crédito silencioso
 * na soma da comanda. Recusar a entrada seria pior: quem digitou um desconto
 * grande demais quer um item de graça, não um erro.
 */
export function totalDoItem(input: {
  quantidade: number;
  precoUnitarioCents: number;
  descontoCents: number;
}): number {
  return Math.max(input.quantidade * input.precoUnitarioCents - input.descontoCents, 0);
}

export const itemSchema = z.object({
  event_type_id: z.string().uuid().nullish(),
  description: z.string().min(1).max(200),
  attendant_user_id: z.string().uuid().nullish(),
  quantity: z.number().int().min(1).max(999).default(1),
  unit_price_cents: z.number().int().min(0).max(100_000_000),
  discount_cents: z.number().int().min(0).max(100_000_000).default(0),
});

export const abrirComandaSchema = z.object({
  contact_id: z.string().uuid().nullish(),
  /**
   * A comanda que nasce de um agendamento.
   *
   * É o caminho que fecha o laço da agenda: faturar conclui o compromisso, e é
   * `fn_finalizar_comanda` quem faz isso. Idempotente por `appointment_id` —
   * dois toques no botão não abrem duas comandas para o mesmo atendimento.
   */
  appointment_id: z.string().uuid().nullish(),
  notes: z.string().max(2000).nullish(),
});

export const alterarComandaSchema = z.object({
  discount_cents: z.number().int().min(0).max(100_000_000).optional(),
  notes: z.string().max(2000).nullish().optional(),
  /** Cancelar é mudança de STATUS, nunca delete: comanda é história. */
  cancel: z.literal(true).optional(),
});

export const finalizarSchema = z.object({
  payment_method_id: z.string().uuid(),
  loyalty_points: z.number().int().min(0).max(10_000).default(0),
});

export const estornarSchema = z.object({
  reason: z.string().min(3).max(500),
});
