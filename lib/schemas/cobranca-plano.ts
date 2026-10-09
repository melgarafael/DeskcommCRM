import { z } from "zod";

import { INTERVALOS } from "@/lib/cobranca/vocabulario";

/**
 * O plano de cobrança da instalação (`cobranca_planos`, spec da cobrança §2.2).
 * São os mesmos limites dos CHECKs da tabela, para a recusa sair com nome antes
 * do banco. A régua é a mesma na rota e no formulário de /admin/cobranca.
 * `moeda` não entra: é BRL, fixada pelo default e pelo CHECK.
 */
const INT4_MAX = 2_147_483_647;
const campos = {
  nome: z.string().trim().min(1).max(60),
  preco_cents: z.number().int().min(500, "O preço mínimo é R$ 5,00: abaixo disso o boleto não sai."),
  intervalo: z.enum(INTERVALOS),
  trial_dias: z.number().int().min(0).max(90),
  max_assentos: z.number().int().min(1).max(INT4_MAX).nullable(),
  max_canais: z.number().int().min(1).max(INT4_MAX).nullable(),
  teto_ia_usd_cents: z.number().int().min(100).max(INT4_MAX).nullable(),
  padrao_no_cadastro: z.boolean(),
  oferecido_ao_cliente: z.boolean(),
};

export const novoPlanoSchema = z.strictObject({
  nome: campos.nome,
  preco_cents: campos.preco_cents,
  intervalo: campos.intervalo,
  trial_dias: campos.trial_dias,
  max_assentos: campos.max_assentos.optional(),
  max_canais: campos.max_canais.optional(),
  teto_ia_usd_cents: campos.teto_ia_usd_cents.optional(),
  padrao_no_cadastro: campos.padrao_no_cadastro.optional(),
  oferecido_ao_cliente: campos.oferecido_ao_cliente.optional(),
});

export const edicaoDoPlanoSchema = z
  .strictObject({ ...campos, arquivado: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nada para mudar.");

export const COLUNAS_DO_PLANO =
  "id, nome, preco_cents, moeda, intervalo, trial_dias, max_assentos, max_canais, teto_ia_usd_cents, padrao_no_cadastro, oferecido_ao_cliente, arquivado_em, created_at, updated_at";
