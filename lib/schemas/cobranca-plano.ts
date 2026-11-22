import { z } from "zod";

import { INTERVALOS, MOEDAS, RECURSOS, RECURSOS_DO_PLANO, type RecursoDoPlano } from "@/lib/cobranca/vocabulario";

/**
 * O plano de cobrança da instalação (`cobranca_planos`, spec da cobrança §2.2).
 * São os mesmos limites dos CHECKs da tabela, para a recusa sair com nome antes
 * do banco. A régua é a mesma na rota e no formulário de /admin/cobranca.
 * `moeda` (migration 9332) entra só na CRIAÇÃO, com BRL como padrão: depois de
 * criado, o plano não troca de moeda — quem assinou ficaria cobrado noutra
 * moeda sem ter escolhido, e a Stripe não muda a moeda de um cliente.
 *
 * Os campos de teto NÃO são digitados aqui: saem de `RECURSOS` (vocabulario.ts),
 * que declara a coluna e o piso de cada recurso. Um recurso novo entra no
 * vocabulário e aparece no schema sozinho — o contrário (schema sem o campo)
 * faria a rota aceitar o payload e o banco recusar o valor.
 */
const INT4_MAX = 2_147_483_647;

type ColunaDeRecurso = (typeof RECURSOS)[RecursoDoPlano]["coluna"];

/** O teto de um recurso: inteiro >= piso do CHECK, ou `null` (sem limite). */
const teto = (recurso: RecursoDoPlano) =>
  z.number().int().min(RECURSOS[recurso].minimo).max(INT4_MAX).nullable();

const TETOS = Object.fromEntries(
  RECURSOS_DO_PLANO.map((recurso) => [RECURSOS[recurso].coluna, teto(recurso)]),
) as { [C in ColunaDeRecurso]: z.ZodNullable<z.ZodNumber> };

const TETOS_OPCIONAIS = Object.fromEntries(
  RECURSOS_DO_PLANO.map((recurso) => [RECURSOS[recurso].coluna, teto(recurso).optional()]),
) as { [C in ColunaDeRecurso]: z.ZodOptional<z.ZodNullable<z.ZodNumber>> };

const campos = {
  nome: z.string().trim().min(1).max(60),
  preco_cents: z.number().int().min(500, "O preço mínimo é 5,00 na moeda do plano: abaixo disso o boleto não sai."),
  intervalo: z.enum(INTERVALOS),
  trial_dias: z.number().int().min(0).max(90),
  padrao_no_cadastro: z.boolean(),
  oferecido_ao_cliente: z.boolean(),
};

export const novoPlanoSchema = z.strictObject({
  nome: campos.nome,
  preco_cents: campos.preco_cents,
  moeda: z.enum(MOEDAS).optional(),
  intervalo: campos.intervalo,
  trial_dias: campos.trial_dias,
  ...TETOS_OPCIONAIS,
  padrao_no_cadastro: campos.padrao_no_cadastro.optional(),
  oferecido_ao_cliente: campos.oferecido_ao_cliente.optional(),
});

export const edicaoDoPlanoSchema = z
  .strictObject({ ...campos, ...TETOS, arquivado: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nada para mudar.");

/**
 * O `SELECT` do plano inteiro — string LITERAL de propósito: o supabase-js só
 * tipa as colunas devolvidas quando o argumento é um literal (um `join()` vira
 * `string` e o retorno degrada para `GenericStringError`). As colunas dos tetos
 * são as do vocabulário, e `vocabulario.test.ts` reprova se uma delas faltar
 * aqui — a lista digitada não fica sem gate.
 */
export const COLUNAS_DO_PLANO =
  "id, nome, preco_cents, moeda, intervalo, trial_dias, max_assentos, max_canais, teto_ia_usd_cents, padrao_no_cadastro, oferecido_ao_cliente, arquivado_em, created_at, updated_at";
