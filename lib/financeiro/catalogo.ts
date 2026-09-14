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
  // A REGRA DE COMISSÃO entra aqui, e não numa rota própria, porque é a mesma
  // coisa que as três acima: política que o negócio escreve uma vez e o dia a
  // dia consome. Sem esta linha ela não tinha porta nenhuma — e `sale_items`
  // resolve o percentual a partir dela, então toda comissão nascia 0%.
  regras_de_comissao: "commission_rules",
  // O MOLDE do lançamento que se repete. Entra aqui pelo mesmo motivo das
  // outras: é o que o negócio define uma vez e o cron consome todo mês.
  recorrencias: "recurring_entries",
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

/**
 * A regra de comissão.
 *
 * `name` existe porque o catálogo genérico o exige em toda entidade, e aqui ele
 * é o rótulo que a pessoa lê na lista ("Ana em manicure"). O que decide a
 * comissão são os outros três campos.
 *
 * Pelo menos um alvo é obrigatório, e o CHECK do banco diz o mesmo: uma regra
 * sem pessoa E sem serviço seria a regra "de tudo", que é outra coisa e mora em
 * outro lugar.
 */
export const regraDeComissaoSchema = z
  .object({
    name: nome,
    attendant_user_id: z.string().uuid().nullish(),
    event_type_id: z.string().uuid().nullish(),
    percent: z.number().min(0).max(100),
  })
  .refine((v) => Boolean(v.attendant_user_id) || Boolean(v.event_type_id), {
    message: "Escolha ao menos uma pessoa ou um serviço.",
  });

/**
 * O molde recorrente.
 *
 * `day_of_month` aceita até 31 mesmo sabendo que onze meses não têm o dia: quem
 * paga no último dia do mês escreve 31, e é o cron que resolve a queda para o
 * último dia existente. Recusar aqui obrigaria a pessoa a escolher 28 e receber
 * a cobrança três dias antes onze vezes por ano.
 */
export const recorrenciaSchema = z.object({
  name: nome,
  account_id: z.string().uuid(),
  account_plan_id: z.string().uuid().nullish(),
  direction: z.enum(DIRECOES),
  amount_cents: z.number().int().min(1).max(1_000_000_000),
  day_of_month: z.number().int().min(1).max(31),
});

export const SCHEMA_POR_ENTIDADE = {
  contas: contaSchema,
  formas_de_pagamento: formaDePagamentoSchema,
  planos_de_conta: planoDeContaSchema,
  regras_de_comissao: regraDeComissaoSchema,
  recorrencias: recorrenciaSchema,
} as const;

/** As colunas que cada entidade devolve. */
export const COLUNAS_POR_ENTIDADE: Record<EntidadeDoCatalogo, string> = {
  contas: "id, name, kind, opening_balance_cents, currency, is_active, created_at",
  formas_de_pagamento: "id, name, account_id, is_active, created_at",
  planos_de_conta: "id, name, direction, is_active, created_at",
  regras_de_comissao:
    "id, name, attendant_user_id, event_type_id, percent, is_active, created_at",
  recorrencias:
    "id, name, account_id, account_plan_id, direction, amount_cents, day_of_month, is_active, created_at",
};

/** O que a tela chama cada coisa. Nunca o nome da tabela. */
export const ROTULO_DA_ENTIDADE: Record<EntidadeDoCatalogo, string> = {
  contas: "Conta",
  formas_de_pagamento: "Forma de pagamento",
  planos_de_conta: "Plano de contas",
  regras_de_comissao: "Regra de comissão",
  recorrencias: "Lançamento recorrente",
};

export function ehEntidadeDoCatalogo(v: string): v is EntidadeDoCatalogo {
  return Object.prototype.hasOwnProperty.call(ENTIDADES_DO_CATALOGO, v);
}
