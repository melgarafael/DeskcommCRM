/**
 * Resolução de identidade para rotas que atendem NAVEGADOR e SERVIDOR.
 *
 * Dois modos, uma fonte de verdade cada:
 *
 *  a) Sessão de navegador (cookie) → `requireRole(...)`, o MESMO gate do resto
 *     de `/api/v1/*` (rank efetivo do banco + MFA de sessão).
 *  b) `Authorization: Bearer dsk_…` → `validateBearerToken()` (`lib/mcp/auth.ts`),
 *     o autenticador de `api_tokens` que o MCP server já usa. `organization_id`
 *     vem da LINHA DO TOKEN no banco, nunca de query ou body do cliente, então
 *     não existe caminho para um Bearer de uma org escrever noutra.
 *
 * Erro de token (ausente, inválido, revogado, expirado) fecha em 401; token
 * válido sem o scope exigido, ou com role abaixo do mínimo, fecha em 403.
 * Nenhum dos dois ramos loga o header nem o plaintext do token.
 *
 * ⚠️ NÃO BASTA chamar isto na rota: o `proxy.ts` global roda ANTES de qualquer
 * route handler e só reconhece cookie de sessão. Sem uma entrada em
 * `lib/auth/public-paths.ts` para o caminho, todo Bearer recebe 401 do proxy
 * antes de chegar ao handler. "Público" ali quer dizer "o proxy não decide",
 * nunca "sem autenticação".
 *
 * Este módulo nasceu de `app/api/v1/contacts/route.ts`, que implementou o
 * padrão inline primeiro. A lógica é a mesma; o que muda por rota é o scope e
 * o rank mínimo, que viram parâmetro em vez de cópia.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { type NextRequest } from "next/server";

import type { Actor } from "@/lib/api/handlers/types";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import type { Role } from "@/lib/auth/types";
import type { Idioma } from "@/lib/i18n/idiomas";
import {
  McpAuthError,
  ensureRole,
  ensureScope,
  extractBearer,
  validateBearerToken,
} from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type AuthDual =
  | {
      ok: true;
      organizationId: string;
      actor: Actor;
      supabase: SupabaseClient;
      idioma?: Idioma;
      /** Por onde a identidade entrou. Útil para audit e para decidir texto de erro. */
      via: "session" | "token";
    }
  | { ok: false; response: Response };

export interface AuthDualOptions {
  /** Correlaciona a resposta com o audit log. */
  requestId: string;
  /** `resource_type` gravado no audit `authz.denied` (ex.: "messages"). */
  resource: string;
  /** Rank mínimo exigido nos DOIS modos. */
  role: Role;
  /** Scope exigido do token. Rotas de escrita usam `mcp:write`. */
  scope: string;
}

/**
 * Aceita sessão OU token de servidor, devolvendo sempre a mesma forma para o
 * handler. O chamador não precisa saber por onde a identidade entrou.
 */
export async function resolveAuthDual(
  req: NextRequest,
  { requestId, resource, role, scope }: AuthDualOptions,
): Promise<AuthDual> {
  const authHeader = req.headers.get("authorization");

  if (extractBearer(authHeader)) {
    let auth;
    try {
      auth = await validateBearerToken(authHeader);
    } catch (err) {
      if (err instanceof McpAuthError) {
        return {
          ok: false,
          response: fail(
            err.httpStatus === 401 ? "unauthenticated" : "forbidden",
            err.message,
            err.httpStatus,
            { requestId },
          ),
        };
      }
      throw err;
    }

    try {
      ensureScope(auth.scopes, scope);
      ensureRole(auth.role, role);
    } catch (err) {
      if (err instanceof McpAuthError) {
        return {
          ok: false,
          response: fail("forbidden_role", err.message, err.httpStatus, { requestId }),
        };
      }
      throw err;
    }

    // organization_id vem do TOKEN (fonte confiável), nunca do cliente.
    return {
      ok: true,
      organizationId: auth.organizationId,
      actor: auth.actor,
      supabase: createAdminClient(),
      via: "token",
    };
  }

  const authz = await requireRole(role, { requestId, resource });
  if (!authz.ok) return { ok: false, response: authz.response };
  return {
    ok: true,
    organizationId: authz.org.orgId,
    actor: { type: "user", id: authz.user.id },
    supabase: await createClient(),
    idioma: authz.user.idioma,
    via: "session",
  };
}
