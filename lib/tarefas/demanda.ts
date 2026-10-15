/**
 * A DEMANDA A QUE UMA TAREFA PODE SER PRESA (#2818).
 *
 * `crm_tasks.demanda_id` tem chave estrangeira simples para `demandas`, e a
 * conferência de chave estrangeira do Postgres não passa pela RLS: o banco
 * recusa um id inexistente, mas aceita a demanda de QUALQUER organização da
 * instalação. A régua de quem pode ser apontado mora aqui, como a do
 * responsável em `responsavel.ts`: a demanda tem de ser da organização da
 * sessão, conferida à mão (CLAUDE.md, multi-tenancy).
 *
 * O client é o da sessão: a RLS de `demandas` já mostra só as organizações do
 * usuário, e o `.eq("organization_id")` estreita para a organização ATIVA
 * (quem é membro de duas não prende a tarefa de uma na demanda da outra).
 *
 * Demanda ENCERRADA (`fechada_em` preenchida) também é recusada (#2842): a
 * tarefa existe para cobrar o que falta NAQUELE atendimento, e presa a um
 * atendimento que já acabou ela some da seção do inbox e contradiz o
 * "Nenhuma demanda aberta" ao lado. Vale para criar e para vincular na edição.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type VereditoDaDemanda = "aceita" | "encerrada" | "fora_da_organizacao" | "falha_na_consulta";

export async function conferirDemanda(
  db: SupabaseClient,
  organizationId: string,
  demandaId: string,
): Promise<VereditoDaDemanda> {
  const { data, error } = await db
    .from("demandas")
    .select("id, fechada_em")
    .eq("organization_id", organizationId)
    .eq("id", demandaId)
    .maybeSingle();

  if (error) return "falha_na_consulta";
  if (!data) return "fora_da_organizacao";
  return data.fechada_em ? "encerrada" : "aceita";
}
