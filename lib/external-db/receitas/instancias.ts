/**
 * INSTÂNCIA DE RECEITA: receita escolhida + parâmetros preenchidos na tela,
 * gravada na coluna `receitas` de `external_db_connections` (jsonb).
 *
 * Espelha o padrão de `lib/external-db/fontes.ts` (lerFontesDoBanco): o que
 * vem do banco é validado aqui; bruto inválido → falha fechada, nunca lista
 * parcial. O `fixos` é validado pelo `parametrosFixos` da receita escolhida
 * pela rota de gravação (`validarFixosDaReceita`).
 */
import { z } from "zod";

import { IDS_DAS_RECEITAS, receitaDe } from "./registro";
import type { InstanciaDeReceita } from "./tipos";

const MAX_INSTANCIAS = 20;

/**
 * Schema de uma instância de receita. O `fixos` é `unknown` aqui: a validação
 * cruzada `fixos` × `parametrosFixos da receita` é feita pela rota antes de
 * gravar, em `validarFixosDaReceita`.
 */
export const instanciaDeReceitaSchemaItem = z
  .object({
    id: z.string().uuid(),
    receita: z.enum(IDS_DAS_RECEITAS as [string, ...string[]]),
    rotulo: z.string().trim().min(1).max(80),
    descricao: z.string().trim().max(300),
    fixos: z.unknown(),
    ativa: z.boolean(),
  })
  .strict();

/**
 * Valida `fixos` contra o `parametrosFixos` da receita. Lança se não bater.
 * Chamado pela rota de gravação antes de gravar no banco.
 */
export function validarFixosDaReceita(receitaId: string, fixos: unknown): void {
  const receita = receitaDe(receitaId);
  if (!receita) throw new Error(`receita_inexistente:${receitaId}`);
  const parseado = receita.parametrosFixos.safeParse(fixos);
  if (!parseado.success) {
    throw new Error(`fixos_invalidos:${receitaId}: ${parseado.error.message}`);
  }
}

const instanciasSchema = z.array(instanciaDeReceitaSchemaItem).max(MAX_INSTANCIAS);

/** Interpreta o que veio do banco. Falha FECHADA: lixo é `{ ok: false }`. */
export function lerReceitasDoBanco(bruto: unknown): { ok: true; instancias: InstanciaDeReceita[] } | { ok: false } {
  const lido = instanciasSchema.safeParse(bruto);
  return lido.success ? { ok: true, instancias: lido.data } : { ok: false };
}

/** Schema do corpo da rota PUT: a lista inteira de instâncias da conexão. */
export const atualizarReceitasSchema = z.object({
  receitas: instanciasSchema,
});
