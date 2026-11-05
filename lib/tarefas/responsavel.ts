/**
 * QUEM PODE SER RESPONSÁVEL POR UMA TAREFA.
 *
 * `crm_tasks.assigned_to` tem chave estrangeira só para `auth.users`
 * (migration 0210): o banco recusa um id inexistente, mas aceita o usuário de
 * QUALQUER organização da instalação. Até a tela ganhar o campo "Responsável", só a API
 * escrevia ali, e ninguém conferia — um id de outra organização, ou de alguém
 * que saiu da equipe, gravava sem erro e a tarefa ficava sem dono que a visse.
 *
 * A régua é a MESMA de `GET /api/v1/team/assignable`, de onde a tela tira as
 * opções: membro da organização, não revogado, e acima de `viewer` (quem só lê
 * não conclui tarefa). Uma régua só, para a lista oferecida e a gravação
 * aceita nunca discordarem.
 *
 * ═══ A ORGANIZAÇÃO É FILTRO DE SQL, NÃO DA RLS (#3715) ═══
 *
 * A consulta deixou de ser PostgREST e virou SQL pela porta de `lib/db`. O pool
 * da aplicação NÃO passa por RLS, então quem segura o isolamento entre tenants
 * aqui é o `where organization_id = $1` — escrito uma vez, no mesmo lugar da
 * régua, e provado contra Postgres de verdade em
 * `tests/invariants/tarefas-piloto-pg.test.ts`. É o mesmo arranjo de antes: a
 * rota já passava o admin client (que também bypassa RLS) filtrado pela
 * organização da sessão, justamente porque a RLS de `user_organizations`
 * mostra a um `agent` só o próprio vínculo.
 */
import type { Db } from "@/lib/db";

export type VereditoDoResponsavel = "aceito" | "fora_da_equipe" | "falha_na_consulta";

export async function conferirResponsavel(
  db: Db,
  organizationId: string,
  userId: string,
): Promise<VereditoDoResponsavel> {
  try {
    const linha = await db.queryOne<{ user_id: string }>(
      `select user_id
         from user_organizations
        where organization_id = $1
          and user_id = $2
          and revoked_at is null
          and role <> 'viewer'
        limit 1`,
      [organizationId, userId],
    );

    return linha ? "aceito" : "fora_da_equipe";
  } catch {
    // Banco fora/inacessível é `falha_na_consulta`, nunca "aceito": a rota
    // traduz isso em 500 e a tarefa não é gravada com responsável duvidoso.
    return "falha_na_consulta";
  }
}
