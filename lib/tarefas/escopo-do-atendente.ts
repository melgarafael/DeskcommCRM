/**
 * O QUE O BANCO DEIXA O ATENDENTE VER EM TAREFAS — lido para a TELA (#4737).
 *
 * ─── Quem restringe é a RLS, não este arquivo ─────────────────────────────
 *
 * A regra de "quem vê qual tarefa" mora em `crm_tasks_select`
 * (`supabase/baseline.sql`): `fn_can_view_task(organization_id, assigned_to,
 * created_by)` OU a opção "Atendentes podem mexer na agenda dos colegas"
 * (`fn_colegas_podem_mexer_na_agenda`). A rota `/api/v1/tasks` não acrescenta
 * recorte nenhum — ela devolve o que a policy entrega. Uma chave só na rota
 * seria uma segunda regra para a mesma coisa, e as duas divergiram no #4800
 * (a rota respondia 403 onde a RLS liberava).
 *
 * Esta função NÃO autoriza nada. Ela só repete a régua da policy para a tela
 * saber o que dizer e o que oferecer: com a lista já recortada pelo banco,
 * oferecer um colega no seletor mostraria uma fração das tarefas dele como se
 * fosse a lista inteira.
 *
 * ─── A régua, espelhada da policy ─────────────────────────────────────────
 *
 *  - platform admin, `viewer`, `manager` e `admin`: veem tudo (`null`);
 *  - "Atendentes podem mexer na agenda dos colegas" LIGADA (o padrão, e
 *    ausente conta como ligada — `colegasPodemMexerNaAgendaLigado`): tudo;
 *  - desligada, vale "O que cada atendente enxerga" (`visibility_mode`,
 *    ausente = `own_and_unassigned`, como o `coalesce` da função):
 *      `all` → tudo; `own_and_unassigned` → as suas, as que criou e as sem
 *      responsável; qualquer outro valor → as suas e as que criou (`own`).
 *
 * Nunca lança: `settings` torto cai na mesma leitura que o banco faria.
 */
import type { Role } from "@/lib/auth/types";
import { colegasPodemMexerNaAgendaLigado } from "@/lib/schemas/settings";

/** `null` = vê as tarefas da equipe; senão, o recorte que a RLS aplica. */
export type EscopoDaTelaDeTarefas = "own_and_unassigned" | "own" | null;

export function escopoDaTelaDeTarefas(entrada: {
  papel: Role;
  /** `user.is_platform_admin` — o `fn_is_platform_admin()` da policy. */
  platformAdmin: boolean;
  /** `organizations.settings` da organização ativa. */
  settings: unknown;
}): EscopoDaTelaDeTarefas {
  if (entrada.platformAdmin) return null;
  if (entrada.papel === "viewer" || entrada.papel === "manager" || entrada.papel === "admin") return null;
  if (colegasPodemMexerNaAgendaLigado(entrada.settings)) return null;

  const modo =
    entrada.settings && typeof entrada.settings === "object" && !Array.isArray(entrada.settings)
      ? (entrada.settings as Record<string, unknown>).visibility_mode
      : undefined;
  if (modo === "all") return null;
  if (modo === undefined || modo === null || modo === "own_and_unassigned") return "own_and_unassigned";
  return "own";
}
