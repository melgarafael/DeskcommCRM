/**
 * De quem são as tarefas da lista da tela de Tarefas.
 *
 * `todos` é o comportamento de antes (a tela abre assim, ninguém perde nada ao
 * atualizar); `eu` vira `me`, que a rota resolve pelo usuário da sessão (o id não sai do
 * navegador, e é o mesmo valor do endereço que o lembrete abre); `ninguem` = sem responsável;
 * qualquer outro valor é o id de um membro da equipe.
 */
export type FiltroDeResponsavel = "todos" | "eu" | "ninguem" | (string & {});

/** O que vai para `GET /api/v1/tasks?assigned_to=`: `me`, o id de quem, `ninguem`, ou nada (todos). */
export function responsavelDoFiltro(filtro: FiltroDeResponsavel): string | undefined {
  if (filtro === "todos") return undefined;
  if (filtro === "eu") return "me";
  return filtro;
}
