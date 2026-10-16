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
 * O CLIENT vem de quem chama, e precisa enxergar a equipe: a RLS de
 * `user_organizations` mostra a um `agent` só o próprio vínculo. A rota passa o
 * admin client filtrado pela organização da sessão — o mesmo arranjo da rota
 * de responsáveis. Sem ele, a consulta só acharia o próprio usuário e recusaria
 * todos os outros: falha FECHADA, nunca aberta.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type VereditoDoResponsavel = "aceito" | "fora_da_equipe" | "falha_na_consulta";

export async function conferirResponsavel(
  db: SupabaseClient,
  organizationId: string,
  userId: string,
): Promise<VereditoDoResponsavel> {
  const { data, error } = await db
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .neq("role", "viewer")
    .maybeSingle();

  if (error) return "falha_na_consulta";
  return data ? "aceito" : "fora_da_equipe";
}
