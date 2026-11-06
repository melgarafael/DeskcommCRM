/**
 * O nome de quem atende — e a declaração de quando ele não pode ser resolvido.
 *
 * ## O defeito que este arquivo existe para consertar
 *
 * A tool MCP `crm_list_conversations` devolvia `assigned_to_user_name` e a rota
 * REST da MESMA listagem devolvia só o UUID: **a IA sabia o nome de quem estava
 * atendendo o cliente e a tela não.** Por isso nenhuma linha do inbox conseguia
 * dizer com quem a pessoa está falando.
 *
 * ## Por que o nome não sai do client do request
 *
 * No MCP o `ctx.supabase` já é `createAdminClient()` (por isso existe
 * `nomesDosAtendentesCom`, que recebe o client). A rota de conversas usa o client do REQUEST (anon key + JWT do usuário), e
 * `supabase.auth.admin.getUserById` fala com o endpoint admin do GoTrue, que
 * responde **403 `not_admin`** para esse token. Medido: o supabase-js **não
 * lança** nesse caso — devolve `{ data: { user: null }, error }` —, então o
 * `catch` do helper nem dispara e a função entrega `null` para TODOS os nomes,
 * calada. Seria um badge que nunca mostra nome, sem nenhum erro em lugar nenhum.
 *
 * ## E por que o client dos DADOS não muda
 *
 * A tentação é passar o admin client para o handler inteiro. Isso desligaria o
 * eixo 5 de governança em silêncio: `listConversationsHandler` não tem filtro de
 * escopo próprio — só `.eq("organization_id", ...)` — e quem restringe um `agent`
 * a `own`/`own_and_unassigned` é EXCLUSIVAMENTE a policy `conversations_select`,
 * que o service role bypassa. O admin client entra aqui e **só** aqui, para o
 * nome, com a org resolvida de fonte confiável pelo chamador.
 *
 * ## Sem service role, o `null` é DECLARADO
 *
 * Mesma escolha de `/api/v1/team/assignable`: num self-host sem
 * `SUPABASE_SERVICE_ROLE_KEY` o campo vem `null` porque **decidimos**, com log,
 * não porque uma chamada falhou sem ninguém ver. A tela cai no rótulo genérico e
 * continua dizendo que há um responsável — o `assigned_to_user_id` é a verdade; o
 * nome é a cortesia.
 *
 * ## Só membros da organização ganham nome
 *
 * O nome só se resolve para quem tem ou teve vínculo em `user_organizations`
 * com a `orgId` do chamador — uma consulta só, para todos os ids. Sem filtro de `revoked_at` de propósito: quem saiu da equipe segue
 * com o nome no histórico que escreveu. Id sem vínculo, ou vínculo que não pôde
 * ser lido, fica sem nome (o chamador já trata a ausência).
 *
 * LGPD: expõe SÓ `full_name`. Nunca e-mail, telefone, `user_metadata` inteiro ou
 * qualquer outro dado do usuário — o mesmo mínimo que `team/assignable` expõe.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { isServiceRoleConfigured } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Custo, medido em 127.0.0.1 contra o GoTrue local: é **uma requisição HTTP por
 * id único** (o dedupe reduz N, não o transforma em 1). ~60ms para 1, ~350ms para
 * 10, ~1,2s para 50 — e 50 exigiria uma página com 50 donos DISTINTOS. Se este
 * número virar problema, o conserto é desnormalizar o nome na linha (o repo já
 * faz isso em `conversation_notes.created_by_name`), não aumentar o paralelismo.
 */
export async function nomesDosAtendentes(
  orgId: string,
  userIds: Array<string | null | undefined>,
): Promise<Map<string, string | null>> {
  const unicos = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  if (unicos.length === 0) return new Map();

  if (!isServiceRoleConfigured()) {
    // Declarado, não acidental: uma linha de log por leitura degradada, e o
    // chamador recebe um mapa VAZIO (não um mapa de nulls), para nunca confundir
    // "não consegui ler" com "esse atendente não tem nome".
    logger.info("[nome-do-atendente] sem service role: o nome do atendente não é resolvido", {
      atendentes: unicos.length,
    });
    return new Map();
  }

  return nomesDosAtendentesCom(createAdminClient(), orgId, unicos);
}

/**
 * O mesmo, com o admin client de quem chama — o MCP já recebe um no contexto
 * (`ctx.supabase`). A regra de vínculo é a mesma: não há segundo caminho para
 * o nome de uma pessoa.
 */
export async function nomesDosAtendentesCom(
  admin: SupabaseClient,
  orgId: string,
  userIds: Array<string | null | undefined>,
): Promise<Map<string, string | null>> {
  const unicos = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  if (unicos.length === 0) return new Map();
  const membros = await membrosDaOrganizacao(admin, orgId, unicos);

  const pares = await Promise.all(
    unicos.map(async (id): Promise<readonly [string, string | null]> => {
      if (!membros.has(id)) return [id, null] as const;
      try {
        const { data, error } = await admin.auth.admin.getUserById(id);
        if (error) {
          // O supabase-js NÃO lança aqui — é este ramo, e não o catch, que pega o
          // caso real (403 not_admin, usuário apagado, GoTrue fora do ar).
          logger.warn("[nome-do-atendente] lookup falhou", { user_id: id, erro: error.message });
          return [id, null] as const;
        }
        const nome = (data?.user?.user_metadata?.full_name as string | undefined) ?? null;
        return [id, nome] as const;
      } catch (err) {
        logger.warn("[nome-do-atendente] lookup lançou", {
          user_id: id,
          erro: err instanceof Error ? err.message : String(err),
        });
        return [id, null] as const;
      }
    }),
  );
  return new Map(pares);
}

/**
 * Quais destes ids têm (ou tiveram) vínculo com a organização. Falha → conjunto
 * vazio (ninguém ganha nome). Exportada para o leitor que expõe mais que o nome
 * (métricas por atendente devolvem também o e-mail): a regra de vínculo é esta.
 */
export async function membrosDaOrganizacao(
  admin: SupabaseClient,
  orgId: string,
  ids: string[],
): Promise<Set<string>> {
  try {
    // `organization_id` filtrado À MÃO: o admin bypassa a RLS.
    const { data, error } = await admin
      .from("user_organizations")
      .select("user_id")
      .eq("organization_id", orgId)
      .in("user_id", ids);
    if (error) throw new Error(error.message);
    return new Set((data ?? []).map((v) => String(v.user_id)));
  } catch (err) {
    logger.warn("[nome-do-atendente] vínculos não lidos: nenhum nome resolvido", {
      organizationId: orgId,
      erro: err instanceof Error ? err.message : String(err),
    });
    return new Set();
  }
}
