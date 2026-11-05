import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/contacts — list (handler em ./_handler.ts)
 * POST /api/v1/contacts — create (handler em ./_handler.ts)
 *
 * Thin wrapper: auth + Zod + ok/fail. Lógica em listContactsHandler/createContactHandler.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import type { Actor } from "@/lib/api/handlers/types";
import { MENSAGEM_DA_RECUSA_DO_MODULO, MODULO_NAO_ENTRA_AQUI } from "@/lib/auth/modulo-autorizado";
import { requireRole } from "@/lib/auth/require-role";
import { extractBearer, validateBearerToken, ensureRole, ensureScope, McpAuthError } from "@/lib/mcp/auth";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import {
  contactCreateSchemaDoPais,
  contactListQuerySchema,
  validateRequest,
  type ContactCreate,
} from "@/lib/schemas";
import { perfilDaOrganizacao } from "@/lib/legal/perfil-do-pais";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

import { listContactsHandler, createContactHandler } from "./_handler";

export const dynamic = "force-dynamic";

/**
 * Resolução de identidade para GET /api/v1/contacts — dois modos, uma fonte
 * de verdade cada:
 *
 *  a) Sessão de navegador (cookie) → `requireRole("viewer", …)`, o MESMO gate
 *     usado no resto de `/api/v1/*` (rank efetivo do banco + MFA de sessão).
 *  b) `Authorization: Bearer dsk_…` → `validateBearerToken()` (`lib/mcp/auth.ts`),
 *     o autenticador de `api_tokens` que o MCP server já usa. `organization_id`
 *     vem da LINHA DO TOKEN no banco — nunca de query/body do cliente — então
 *     não existe caminho para um Bearer de uma org ler contatos de outra.
 *
 * Erro de token (ausente/inválido/revogado/expirado) fecha em 401; token válido
 * sem o scope `mcp:read` (ou role abaixo de `viewer`) fecha em 403. Nenhum dos
 * dois ramos loga o header ou o plaintext do token.
 *
 * ⚠️ NÃO BASTA implementar isto aqui: o `proxy.ts` global roda ANTES de
 * qualquer route handler e só reconhece cookie de sessão — sem uma entrada em
 * `lib/auth/public-paths.ts` para `/api/v1/contacts`, todo Bearer recebe 401
 * do proxy antes de chegar neste arquivo. Ver o comentário lá.
 */
type ContactsAuth =
  | { ok: true; organizationId: string; actor: Actor; supabase: SupabaseClient; idioma?: Idioma }
  | { ok: false; response: Response };

async function resolveContactsAuth(req: NextRequest, requestId: string): Promise<ContactsAuth> {
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
            err.codigo ?? (err.httpStatus === 401 ? "unauthenticated" : "forbidden"),
            err.message,
            err.httpStatus,
            { requestId },
          ),
        };
      }
      throw err;
    }

    // Token de MÓDULO não entra por aqui (spec 33, F3): esta rota lê pelos escopos do token e não
    // passa pela área consentida. O módulo alcança contatos por `resolveAuthDual`, que confere a área.
    if (auth.actor.type === "module") {
      return {
        ok: false,
        response: fail(MODULO_NAO_ENTRA_AQUI, MENSAGEM_DA_RECUSA_DO_MODULO[MODULO_NAO_ENTRA_AQUI], 403, {
          requestId,
        }),
      };
    }

    try {
      ensureScope(auth.scopes, "mcp:read");
      ensureRole(auth.role, "viewer");
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
    };
  }

  const authz = await requireRole("viewer", { requestId, resource: "contacts" });
  if (!authz.ok) return { ok: false, response: authz.response };
  return {
    ok: true,
    organizationId: authz.org.orgId,
    actor: { type: "user", id: authz.user.id },
    supabase: await createClient(),
    idioma: authz.user.idioma,
  };
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = await resolveContactsAuth(req, requestId);
  if (!auth.ok) return auth.response;
  const { organizationId, actor, supabase, idioma } = auth;
  const t = (texto: string) => traduzir(texto, idioma ?? "pt-BR");

  const url = new URL(req.url);
  const qsParsed = contactListQuerySchema.safeParse({
    search: url.searchParams.get("search") ?? undefined,
    // `getAll` (#1274): a repetição na URL soe viva pelo `getAll`. Um `get` leria
    // so a primeira e a tela mostraria uma escolha que a lista ignora.
    tag: url.searchParams.getAll("tag"),
    modo: url.searchParams.get("modo") ?? undefined,
    source: url.searchParams.get("source") ?? undefined,
    pessoais: url.searchParams.get("pessoais") ?? undefined,
    blocked: url.searchParams.get("blocked") ?? undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    order_by: url.searchParams.get("order_by") ?? undefined,
    order_dir: url.searchParams.get("order_dir") ?? undefined,
  });
  if (!qsParsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, {
      details: qsParsed.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }

  try {
    const { contacts, cursor, has_more } = await listContactsHandler(
      supabase,
      {
        organization_id: organizationId,
        actor,
        requestId,
        idioma,
      },
      qsParsed.data,
    );
    return ok(contacts, { requestId, meta: { cursor, has_more } });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  // spec 13 §4: escrita é agent+ (viewer é read-only). Sessão OU token de
  // integração (Spec 33, R2): `mcp:write` e papel `agent` na linha do token,
  // o mesmo do PATCH vizinho (`contacts/[id]`). A organização vem do cookie
  // validado ou da LINHA DO TOKEN, nunca do corpo.
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "contacts",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "contacts", requestId);
  if (teto) return teto;
  const supabase = authz.supabase;
  const organizationId = authz.organizationId;

  // O documento do titular é validado pela régua do PAÍS da organização (issue
  // #1033): quem decide é a coluna `organizations.country`, nunca o corpo da
  // requisição — mesma doutrina da moeda em `lib/catalogo/moeda-da-org.ts`.
  const perfil = await perfilDaOrganizacao(supabase, organizationId);

  let input;
  try {
    input = await validateRequest(contactCreateSchemaDoPais(perfil), req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  try {
    const result = await createContactHandler(
      supabase,
      {
        organization_id: organizationId,
        actor: authz.actor,
        requestId,
        idioma: authz.idioma,
      },
      input as ContactCreate,
    );
    return ok(result, { status: 201, requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }
}
