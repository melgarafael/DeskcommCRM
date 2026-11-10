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
 * ═══ A ORGANIZAÇÃO VAI NO SQL (#3715) ═══
 *
 * A consulta deixou de ser a cadeia do PostgREST e virou SQL pela porta de
 * `lib/db`; o `where organization_id = $1` (parâmetro vinculado, nunca
 * interpolação) é o que estreita para a organização ATIVA — quem é membro de
 * duas não prende a tarefa de uma na demanda da outra. O pool não passa por
 * RLS, então o filtro explícito é a única barreira, e é por isso que ele é
 * provado contra Postgres real em `tests/invariants/tarefas-piloto-pg.test.ts`.
 *
 * Demanda ENCERRADA (`fechada_em` preenchida) também é recusada (#2842): a
 * tarefa existe para cobrar o que falta NAQUELE atendimento, e presa a um
 * atendimento que já acabou ela some da seção do inbox e contradiz o
 * "Nenhuma demanda aberta" ao lado. Vale para criar e para vincular na edição.
 */
import type { Db } from "@/lib/db";

export type VereditoDaDemanda = "aceita" | "encerrada" | "fora_da_organizacao" | "falha_na_consulta";

export async function conferirDemanda(
  db: Db,
  organizationId: string,
  demandaId: string,
): Promise<VereditoDaDemanda> {
  try {
    const demanda = await db.queryOne<{ id: string; fechada_em: string | Date | null }>(
      `select id, fechada_em
         from demandas
        where organization_id = $1
          and id = $2
        limit 1`,
      [organizationId, demandaId],
    );

    if (!demanda) return "fora_da_organizacao";
    return demanda.fechada_em ? "encerrada" : "aceita";
  } catch {
    // Sem resposta do banco não há como afirmar que a demanda é desta
    // organização: falha FECHADA, e a rota traduz em 500.
    return "falha_na_consulta";
  }
}
