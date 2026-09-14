/**
 * O CATÁLOGO FINANCEIRO — a decisão de o que cada entidade aceita.
 *
 * Fica fora da rota porque é regra, e regra se testa sem HTTP. A rota valida,
 * chama e traduz erro; quem sabe o que é um plano de contas válido é este
 * arquivo.
 *
 * As três entidades compartilham forma (nome + ativo + organização) e divergem
 * em uma coisa cada. A tentação é um CRUD genérico com `tabela` no path; o custo
 * disso é que a divergência some — e é justamente ela que importa: a conta tem
 * saldo inicial e moeda, a forma de pagamento aponta para uma conta, o plano tem
 * direção. Três schemas explícitos dizem isso; um genérico esconderia.
 */
import { z } from "zod";

/** As três tabelas do catálogo, e o que a rota aceita em `tipo`. */
export const ENTIDADES_DO_CATALOGO = {
  contas: "financial_accounts",
  formas_de_pagamento: "payment_methods",
  planos_de_conta: "account_plans",
} as const;

export type EntidadeDoCatalogo = keyof typeof ENTIDADES_DO_CATALOGO;

export const TIPOS_DE_CONTA = ["cash", "bank", "other"] as const;
export const DIRECOES = ["in", "out"] as const;

const nome = z.string().trim().min(2, "O nome precisa de pelo menos 2 caracteres").max(80);

export const contaSchema = z.object({
  name: nome,
  kind: z.enum(TIPOS_DE_CONTA).default("cash"),
  /**
   * Em centavos e assinado: uma conta pode começar negativa (cheque especial,
   * cartão com fatura aberta). Recusar negativo aqui obrigaria quem tem a
   * mentir no cadastro.
   */
  opening_balance_cents: z.coerce.number().int().default(0),
  currency: z.string().length(3).default("BRL"),
});

export const formaDePagamentoSchema = z.object({
  name: nome,
  /**
   * `nullish` e não obrigatório: dá para cadastrar a forma antes de decidir a
   * conta, e é comum — quem está montando o catálogo lista as formas que aceita
   * antes de abrir a conta no banco. O que NÃO pode é finalizar comanda com
   * forma sem conta, e essa checagem pertence à finalização, não ao cadastro.
   */
  account_id: z.string().uuid().nullish(),
});

export const planoDeContaSchema = z.object({
  name: nome,
  /**
   * Sem default, de propósito. No sistema de origem as 17 linhas eram todas
   * `debito` — inclusive "Serviços" e "Comissão", que são coisas opostas: um
   * campo que existia e não distinguia nada. Um default aqui reproduziria isso,
   * porque quem cadastra depressa aceita o que vem. Obrigar a escolher é o
   * ponto.
   */
  direction: z.enum(DIRECOES),
});

export const SCHEMA_POR_ENTIDADE = {
  contas: contaSchema,
  formas_de_pagamento: formaDePagamentoSchema,
  planos_de_conta: planoDeContaSchema,
} as const;

/** As colunas que cada entidade devolve. */
export const COLUNAS_POR_ENTIDADE: Record<EntidadeDoCatalogo, string> = {
  contas: "id, name, kind, opening_balance_cents, currency, is_active, created_at",
  formas_de_pagamento: "id, name, account_id, is_active, created_at",
  planos_de_conta: "id, name, direction, is_active, created_at",
};

/** O que a tela chama cada coisa. Nunca o nome da tabela. */
export const ROTULO_DA_ENTIDADE: Record<EntidadeDoCatalogo, string> = {
  contas: "Conta",
  formas_de_pagamento: "Forma de pagamento",
  planos_de_conta: "Plano de contas",
};

export function ehEntidadeDoCatalogo(v: string): v is EntidadeDoCatalogo {
  return Object.prototype.hasOwnProperty.call(ENTIDADES_DO_CATALOGO, v);
}
