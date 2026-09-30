/**
 * O ESTADO DA ORGANIZAÇÃO — a única regra de "este tenant pode operar?".
 *
 * `organizations.status` aceita `active | suspended | redacted | archived`
 * (CHECK `organizations_status_check`). Até a migration 0492 cada consumidor
 * decidia sozinho se olhava a coluna, e quase nenhum olhava: suspender gravava
 * o status e só a tela de `/app` redirecionava — API, tokens, fila do agente,
 * automações e envio seguiam (auditoria de 28/09/2026, P3).
 *
 * A regra agora mora em dois lugares que dizem a MESMA coisa, cada um na sua
 * camada:
 *
 *  - no banco, `fn_user_org_ids()`/`fn_user_role_in_org()` só alcançam
 *    organização `active` (RLS, PostgREST, Realtime);
 *  - aqui, para o que roda com service role e não passa pela RLS (rotas, fila,
 *    dreno de eventos, envio).
 *
 * "Operar" é o critério: só `active` opera. `redacted` e `archived` são estados
 * terminais — nada deles deve voltar a agir sozinho.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const ESTADOS_DA_ORGANIZACAO = ["active", "suspended", "redacted", "archived"] as const;
export type EstadoDaOrganizacao = (typeof ESTADOS_DA_ORGANIZACAO)[number];

/** Código de erro das respostas que recusam por organização parada. */
export const CODIGO_ORGANIZACAO_SUSPENSA = "tenant_suspended";

/**
 * A organização pode operar? Estado desconhecido ou ausente conta como ativo —
 * o banco sempre preenche a coluna (`default 'active' not null`), então
 * `undefined` aqui só aparece em objeto montado por quem não leu o status, e
 * recusar nesse caso derrubaria quem não tem nada a ver com suspensão.
 */
export function organizacaoOpera(estado: string | null | undefined): boolean {
  return estado === undefined || estado === null || estado === "active";
}

/**
 * Os ids das organizações que NÃO operam — para excluir de uma fila em lote
 * (`.not("organization_id", "in", ...)`), no molde que a rodada de campanhas
 * já usava. Lista curta por natureza: suspensão é exceção.
 */
export async function organizacoesParadas(admin: SupabaseClient): Promise<string[]> {
  const { data, error } = await admin.from("organizations").select("id").neq("status", "active");
  if (error) throw new Error(`organizacoes_paradas: ${error.message}`);
  return (data ?? []).map((o) => (o as { id: string }).id);
}

/**
 * Filtro PostgREST pronto para `.not("organization_id", "in", filtro)`, ou
 * `null` quando não há nada a excluir (o PostgREST recusa `in.()` vazio).
 */
export function filtroSemParadas(ids: string[]): string | null {
  return ids.length > 0 ? `(${ids.join(",")})` : null;
}

/** A organização existe e opera? Falha de leitura propaga — quem decide acesso falha fechado. */
export async function organizacaoAtiva(admin: SupabaseClient, orgId: string): Promise<boolean> {
  const { data, error } = await admin
    .from("organizations")
    .select("status")
    .eq("id", orgId)
    .maybeSingle();
  if (error) throw new Error(`organizacao_ativa: ${error.message}`);
  if (!data) return false;
  return organizacaoOpera((data as { status: string }).status);
}
