import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET /api/v1/leads — listagem autenticada com contato da mesma organização.
 * POST /api/v1/leads — create lead (handler em ./_handler.ts).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { resolveAuthDual } from "@/lib/api/auth-dual";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createLeadSchema, validateRequest, type CreateLeadInput } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";
import { JANELA_SEGUNDOS, TETO_POR_TOKEN, TETO_POR_ORGANIZACAO } from "@/lib/mcp/rate-limit";

import { createLeadHandler, listLeadsHandler } from "./_handler";

export const dynamic = "force-dynamic";

const listQuerySchema = z.object({
  status: z.enum(["open", "won", "lost"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: z.string().min(1).max(2048).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  try {
    const auth = await resolveAuthDual(req, {
      requestId,
      resource: "crm_leads",
      role: "agent",
      scope: "mcp:read",
    });
    if (!auth.ok) return auth.response;

    if (auth.via === "token") {
      const porToken = await checkRateLimit(
        `leads:read:tok:${auth.apiTokenId}`,
        TETO_POR_TOKEN,
        JANELA_SEGUNDOS,
      );
      if (!porToken.allowed) {
        return fail("rate_limited", "Too many requests.", 429, {
          requestId,
          headers: { "Retry-After": String(JANELA_SEGUNDOS) },
        });
      }
      const porOrg = await checkRateLimit(
        `leads:read:org:${auth.organizationId}`,
        TETO_POR_ORGANIZACAO,
        JANELA_SEGUNDOS,
      );
      if (!porOrg.allowed) {
        return fail("rate_limited", "Too many requests for organization.", 429, {
          requestId,
          headers: { "Retry-After": String(JANELA_SEGUNDOS) },
        });
      }
    }

    const params = new URL(req.url).searchParams;
    const query = listQuerySchema.safeParse({
      status: params.get("status") ?? undefined,
      limit: params.get("limit") ?? undefined,
      cursor: params.get("cursor") ?? undefined,
    });
    if (!query.success) {
      return fail("validation_failed", "Query inválida.", 422, { requestId });
    }

    const result = await listLeadsHandler(
      auth.supabase,
      { organization_id: auth.organizationId, actor: auth.actor, requestId, idioma: auth.idioma },
      query.data,
    );
    const contactIds = [
      ...new Set(
        result.leads
          .map((lead) => lead.contact_id)
          .filter((id): id is string => typeof id === "string"),
      ),
    ];
    const contactsById = new Map<string, Record<string, unknown>>();
    if (contactIds.length > 0) {
      const { data, error } = await auth.supabase
        .from("contacts")
        .select("id, name, email, phone_number")
        .eq("organization_id", auth.organizationId)
        .in("id", contactIds);
      if (error)
        return fail("internal_error", "Não foi possível listar os leads.", 500, { requestId });
      for (const contact of data ?? []) contactsById.set(contact.id, contact);
    }

    return ok(
      result.leads.map((lead) => ({
        ...lead,
        contact:
          typeof lead.contact_id === "string" ? (contactsById.get(lead.contact_id) ?? null) : null,
      })),
      { requestId, meta: { cursor: result.cursor, has_more: result.has_more } },
    );
  } catch (err) {
    if (err instanceof ApiError && err.status < 500) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    return fail("internal_error", "Não foi possível listar os leads.", 500, { requestId });
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  let input;
  try {
    input = await validateRequest(createLeadSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const supabase = await createClient();

  try {
    const lead = await createLeadHandler(
      supabase,
      {
        organization_id: activeOrg.orgId,
        actor: { type: "user", id: authUser.id },
        requestId,
        idioma: authUser.idioma,
      },
      input as CreateLeadInput,
    );
    return ok(lead, { requestId, status: 201 });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }
}
