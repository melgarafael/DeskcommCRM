/**
 * Peças comuns das rotas de operação que aceitam token (Spec 33, fatia R2):
 * o contexto do handler no ramo do token, o autor de uma coluna `…_by_user_id`
 * e a conferência, na organização, de um id que veio do corpo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { AuthDual } from "@/lib/api/auth-dual";
import type { HandlerCtx } from "@/lib/api/handlers/types";

type AuthzDeToken = Extract<AuthDual, { ok: true }>;

/** Contexto do handler no ramo do token. A organização é a da linha do token, nunca a do corpo. */
export function ctxDeToken(authz: AuthzDeToken, requestId: string): HandlerCtx {
  return {
    organization_id: authz.organizationId,
    actor: authz.actor,
    requestId,
    apiTokenId: authz.apiTokenId,
  };
}

/** Autor de uma coluna `…_by_user_id`: só a pessoa da sessão. Token grava `null`, nunca o id dele. */
export function autorDe(authz: AuthzDeToken): string | null {
  return authz.actor.type === "user" ? authz.actor.id : null;
}

/**
 * Confere que `id` existe NA organização. No ramo do token o cliente é a service
 * role (a RLS não filtra) e a chave estrangeira não confere organização: sem
 * isto, um id de outra organização viraria vínculo. Erro de consulta conta como
 * ausente (falha fechada).
 */
export async function existeNaOrganizacao(
  db: SupabaseClient,
  tabela: string,
  organizationId: string,
  id: string,
): Promise<boolean> {
  const { data } = await db
    .from(tabela)
    .select("id")
    .eq("organization_id", organizationId)
    .eq("id", id)
    .maybeSingle();
  return data != null;
}
