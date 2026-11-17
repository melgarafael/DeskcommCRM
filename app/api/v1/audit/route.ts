/**
 * GET /api/v1/audit — list audit log entries for the active organization.
 *
 * Auth: cookie session, role manager+ (or platform admin, read-only) OU token de
 * servidor `dsk_…` com `mcp:read` e papel manager+ (Spec 33, R3).
 * Filters: actor_id, action (substring), resource_type, from, to, cursor, limit.
 * Pagination: keyset over (created_at DESC, id DESC).
 *
 * DOIS PORTÕES, UM CORPO. A sessão segue pelo `requireRole` de sempre, com o
 * `allowPlatformAdmin: "leitura"` dele — opção que `resolveAuthDual` não repassa,
 * e sem ela o platform admin que lê a auditoria de uma empresa que não é a dele
 * passaria a levar 403. Por isso o token entra por um ramo à parte e os dois
 * chamam o mesmo `responder`. A organização vem da sessão ou da LINHA do token
 * e a consulta filtra por ela nos dois ramos: o token não alcança a auditoria
 * de outra empresa, nem as linhas de plataforma (`organization_id` nulo).
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO, type Idioma } from "@/lib/i18n/idiomas";
import { extractBearer } from "@/lib/mcp/auth";
import { auditQuerySchema, decodeAuditCursor, encodeAuditCursor } from "@/lib/schemas/audit";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (extractBearer(req.headers.get("authorization"))) {
    const authz = await resolveAuthDual(req, {
      requestId,
      resource: "audit",
      role: "manager",
      scope: "mcp:read",
    });
    if (!authz.ok) return authz.response;
    const teto = await tetoDeEscritaDoToken(authz, "audit", requestId);
    if (teto) return teto;
    return responder(req, authz.supabase, authz.organizationId, authz.idioma ?? IDIOMA_PADRAO, requestId);
  }

  const authz = await requireRole("manager", {
    requestId,
    resource: "audit",
    allowPlatformAdmin: "leitura",
  });
  if (!authz.ok) return authz.response;
  return responder(req, await createClient(), authz.org.orgId, authz.user.idioma, requestId);
}

async function responder(
  req: NextRequest,
  supabase: SupabaseClient,
  organizationId: string,
  idioma: Idioma,
  requestId: string,
): Promise<Response> {
  const t = (texto: string) => traduzir(texto, idioma);

  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  const parsed = auditQuerySchema.safeParse(params);
  if (!parsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const q = parsed.data;

  let query = supabase
    .from("api_audit_log")
    .select(
      "id, created_at, actor_user_id, actor_api_token_id, acting_as_platform_admin, action, resource_type, resource_id, request_id, metadata, actor_ip, actor_user_agent",
    )
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(q.limit + 1);

  if (q.actor_id) query = query.eq("actor_user_id", q.actor_id);
  if (q.action) query = query.ilike("action", `%${q.action}%`);
  if (q.resource_type) query = query.eq("resource_type", q.resource_type);
  if (q.from) query = query.gte("created_at", q.from);
  if (q.to) query = query.lte("created_at", q.to);

  if (q.cursor) {
    const c = decodeAuditCursor(q.cursor);
    if (!c) return fail("invalid_cursor", t("Cursor inválido."), 400, { requestId });
    // (created_at, id) < (cursor.created_at, cursor.id) — keyset DESC
    query = query.or(
      `created_at.lt.${c.created_at},and(created_at.eq.${c.created_at},id.lt.${c.id})`,
    );
  }

  const { data, error } = await query;
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const rows = data ?? [];
  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? encodeAuditCursor({ created_at: last.created_at, id: last.id }) : null;

  return ok(page, {
    requestId,
    meta: { cursor: nextCursor, has_more: hasMore },
  });
}
