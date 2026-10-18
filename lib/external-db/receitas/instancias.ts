/**
 * INSTÂNCIA DE RECEITA: receita escolhida + parâmetros preenchidos na tela,
 * gravada na coluna `receitas` de `external_db_connections` (jsonb).
 *
 * Espelha o padrão de `lib/external-db/fontes.ts` (lerFontesDoBanco): o que
 * vem do banco é validado aqui; bruto inválido → falha fechada, nunca lista
 * parcial. O `fixos` é validado pelo `parametrosFixos` da receita escolhida
 * pela rota de gravação (`validarFixosDaReceita`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { IDS_DAS_RECEITAS, receitaDe } from "./registro";
import type { DestinoDaInstancia, InstanciaDeReceita } from "./tipos";

const MAX_INSTANCIAS = 20;

/**
 * Schema de uma instância de receita. O `fixos` é `unknown` aqui: a validação
 * cruzada `fixos` × `parametrosFixos da receita` é feita pela rota antes de
 * gravar, em `validarFixosDaReceita`.
 */
/** Funil + etapa do lead de interesse (R5/D6). `.strict()`: chave estranha é recusada. */
export const destinoDaInstanciaSchema = z
  .object({
    pipeline_id: z.string().uuid(),
    stage_id: z.string().uuid(),
  })
  .strict();

export const instanciaDeReceitaSchemaItem = z
  .object({
    id: z.string().uuid(),
    receita: z.enum(IDS_DAS_RECEITAS as [string, ...string[]]),
    rotulo: z.string().trim().min(1).max(80),
    descricao: z.string().trim().max(300),
    fixos: z.unknown(),
    ativa: z.boolean(),
    destino: destinoDaInstanciaSchema.optional(),
  })
  .strict();

export type VereditoDoDestino = { ok: true } | { ok: false; motivo: "funil_inexistente" | "etapa_inexistente" | "etapa_de_outro_funil" | "indisponivel" };

/**
 * O funil e a etapa de destino existem NESTA organização, vivos, e a etapa é do funil?
 * Roda na gravação da instância E na hora de usar (o funil pode ter sido arquivado
 * depois). `organization_id` vem sempre do chamador (sessão/turno), nunca do corpo.
 * Funil de outra organização é "inexistente": a resposta não confirma que ele existe.
 */
export async function validarDestinoDaInstancia(
  admin: SupabaseClient,
  organizationId: string,
  destino: DestinoDaInstancia,
): Promise<VereditoDoDestino> {
  const funil = await admin
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("id", destino.pipeline_id)
    .eq("is_archived", false)
    .maybeSingle();
  if (funil.error) return { ok: false, motivo: "indisponivel" };
  if (!funil.data) return { ok: false, motivo: "funil_inexistente" };
  const etapa = await admin
    .from("crm_stages")
    .select("id, pipeline_id, is_won, is_lost")
    .eq("organization_id", organizationId)
    .eq("id", destino.stage_id)
    .eq("is_archived", false)
    .maybeSingle();
  if (etapa.error) return { ok: false, motivo: "indisponivel" };
  if (!etapa.data) return { ok: false, motivo: "etapa_inexistente" };
  const e = etapa.data as { pipeline_id: string; is_won: boolean; is_lost: boolean };
  if (e.pipeline_id !== destino.pipeline_id) return { ok: false, motivo: "etapa_de_outro_funil" };
  // Lead novo não nasce já ganho nem perdido.
  if (e.is_won || e.is_lost) return { ok: false, motivo: "etapa_inexistente" };
  return { ok: true };
}

/**
 * Valida `fixos` contra o `parametrosFixos` da receita. Lança se não bater.
 * Chamado pela rota de gravação antes de gravar no banco.
 */
export function validarFixosDaReceita(receitaId: string, fixos: unknown): void {
  const receita = receitaDe(receitaId);
  if (!receita) throw new Error(`receita_inexistente:${receitaId}`);
  const parseado = receita.parametrosFixos.safeParse(fixos);
  if (!parseado.success) {
    // Motivo legível (as mensagens do Zod da receita já são em português), não o JSON cru do Zod.
    const motivo = parseado.error.issues
      .map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ");
    throw new Error(`fixos_invalidos:${receitaId}: ${motivo}`);
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
