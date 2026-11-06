/**
 * Acrescenta `assigned_to_user_name` às conversas que saem pela borda HTTP.
 *
 * Fica FORA de `_handler.ts` de propósito: aquele handler é compartilhado com as
 * tools MCP, que já resolvem o nome por conta própria — enriquecer lá faria a
 * mesma leitura duas vezes em toda chamada do agente.
 *
 * ## Desde a migration 0202: a coluna já vem na linha
 *
 * `fn_conversation_assign` (a ÚNICA função que atribui conversa — claim,
 * release, transfer, roteamento automático) grava `assigned_to_user_name` no
 * banco, desnormalizado, no mesmo UPDATE que grava `assigned_to_user_id`. Este
 * arquivo deixou de chamar `nomesDosAtendentes()` para TODA a página — que
 * disparava uma requisição HTTP ao GoTrue Admin API por atendente único
 * (ver o histórico em `lib/users/nome-do-atendente.ts`) — e passou a apenas
 * repassar a coluna que a query de `_handler.ts` já trouxe.
 *
 * ## O fallback, e por que ele existe
 *
 * Uma linha pode ter `assigned_to_user_id` preenchido e `assigned_to_user_name`
 * `null` só num caso raro: foi atribuída ANTES desta migration existir, e o
 * backfill da migration não alcançou (ex. clone que aplica as migrations fora
 * de ordem, ou dado corrompido por fora da RPC). Nesse caso — e SÓ nesse —
 * caímos de volta em `nomesDosAtendentes()`, restrito às linhas nessa condição
 * (nunca a página inteira), para a tela nunca regredir para "sem nome" por uma
 * migration que já rodou há muito tempo. Deveria ser raríssimo depois do
 * backfill; se isto nunca disparar em produção, é sinal de que o fallback virou
 * código morto e pode ser removido.
 *
 * O campo é opcional no tipo (`?`) porque quem consome pode estar lendo uma
 * resposta de antes deste campo existir, e porque `null` aqui é um estado
 * DECLARADO (sem service role, ou lookup que falhou) — ver
 * `lib/users/nome-do-atendente.ts`. A tela nunca deve traduzir esse `null` para
 * "sem responsável": o dono é o `assigned_to_user_id`.
 */
import { isServiceRoleConfigured } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Conversation } from "@/lib/types/messaging";

import { membrosDaOrganizacao, nomesDosAtendentes } from "./nome-do-atendente";

export type ConversationComAtendente = Conversation & {
  assigned_to_user_name?: string | null;
};

export async function comNomeDoAtendente<
  T extends { assigned_to_user_id: string | null; assigned_to_user_name?: string | null },
>(orgId: string, conversas: T[]): Promise<Array<T & { assigned_to_user_name: string | null }>> {
  // A coluna só sai para quem tem ou teve vínculo com a organização — a mesma
  // regra de `nomesDosAtendentes`, numa consulta só para a página inteira.
  // Vínculo que não pôde ser lido (ou sem service role) = ninguém ganha nome.
  const ids = [...new Set(conversas.map((c) => c.assigned_to_user_id).filter((id): id is string => Boolean(id)))];
  const membros =
    ids.length > 0 && isServiceRoleConfigured()
      ? await membrosDaOrganizacao(createAdminClient(), orgId, ids)
      : new Set<string>();

  // Só os casos inconsistentes (id sem nome) pagam o lookup — nunca a página inteira.
  const inconsistentes = conversas
    .filter((c) => c.assigned_to_user_id && membros.has(c.assigned_to_user_id) && !c.assigned_to_user_name)
    .map((c) => c.assigned_to_user_id);
  const nomesDeFallback =
    inconsistentes.length > 0 ? await nomesDosAtendentes(orgId, inconsistentes) : new Map<string, string | null>();

  return conversas.map((c) => ({
    ...c,
    assigned_to_user_name:
      c.assigned_to_user_id && membros.has(c.assigned_to_user_id)
        ? (c.assigned_to_user_name ?? nomesDeFallback.get(c.assigned_to_user_id) ?? null)
        : null,
  }));
}
