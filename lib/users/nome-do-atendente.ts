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
 * Custo: **uma consulta ao banco** (`public.fn_nomes_dos_membros`, migration
 * 9314), não mais uma requisição HTTP por id único. Antes desta fatia o caminho
 * fazia `auth.admin.getUserById` uma vez por pessoa (~60ms para 1, ~350ms para
 * 10, ~1,2s para 50, medidos em 127.0.0.1 contra o GoTrue local) só para ler um
 * `full_name` que já está no banco.
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
 * o nome de uma pessoa, e agora não há chamada HTTP nenhuma: UMA consulta a
 * `fn_nomes_dos_membros` resolve nome (e o e-mail que outros leitores pedem) de
 * todos os ids de uma vez.
 */
export async function nomesDosAtendentesCom(
  admin: SupabaseClient,
  orgId: string,
  userIds: Array<string | null | undefined>,
): Promise<Map<string, string | null>> {
  const unicos = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  if (unicos.length === 0) return new Map();

  // Todo id começa SEM nome — quem não tem (nem teve) vínculo com a organização
  // não ganha linha na função, e o mapa continua com a chave para o chamador
  // distinguir "sem nome" de "id não pedido".
  const nomes = new Map<string, string | null>(unicos.map((id) => [id, null]));

  try {
    const { data, error } = await admin.rpc("fn_nomes_dos_membros", {
      p_org: orgId,
      p_ids: unicos,
    });
    if (error) {
      // Falha de leitura degrada para "ninguém tem nome" (o chamador já trata a
      // ausência), com uma linha de log — nunca um mapa parcial silencioso.
      logger.warn("[nome-do-atendente] nomes não lidos: nenhum nome resolvido", {
        organizationId: orgId,
        erro: error.message,
      });
      return nomes;
    }
    for (const linha of (data ?? []) as Array<{ user_id?: string; full_name?: string | null }>) {
      if (typeof linha.user_id !== "string") continue;
      nomes.set(linha.user_id, linha.full_name ?? null);
    }
    return nomes;
  } catch (err) {
    logger.warn("[nome-do-atendente] leitura de nomes lançou", {
      organizationId: orgId,
      erro: err instanceof Error ? err.message : String(err),
    });
    return nomes;
  }
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
