import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET    /api/v1/ai/routers/:id — detalhe do router + membros (agent+).
 * PATCH  /api/v1/ai/routers/:id — atualiza campos (admin), audit `ai.router_updated`.
 * DELETE /api/v1/ai/routers/:id — remove o router (admin), audit `ai.router_deleted`.
 *   Cascade FK (migration 0085) já apaga ai_router_members junto.
 *
 * organization_id sempre de requireRole — nunca do path/body.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type RouteCtx = { params: Promise<{ id: string }> };

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ROUTER_DETAIL_COLUMNS = "id, name, channel_session_id, is_active, config, fallback_agent_id";
const MEMBER_COLUMNS = "id, agent_id, intent_name, intent_description, examples, position";

const patchRouterSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  is_active: z.boolean().optional(),
  fallback_agent_id: z.string().uuid().nullable().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await requireRole("agent", { requestId, resource: "ai_routers" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const admin = createAdminClient();

  const { data: router, error: routerErr } = await admin
    .from("ai_routers")
    .select(ROUTER_DETAIL_COLUMNS)
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (routerErr) {
    return fail("internal_error", "Erro ao buscar router.", 500, { requestId });
  }
  if (!router) {
    return fail("not_found", "Router não encontrado.", 404, { requestId });
  }

  const { data: members, error: membersErr } = await admin
    .from("ai_router_members")
    .select(MEMBER_COLUMNS)
    .eq("router_id", id)
    .eq("organization_id", org.orgId)
    .order("position", { ascending: true });
  if (membersErr) {
    return fail("internal_error", "Erro ao buscar membros do router.", 500, { requestId });
  }

  return ok({ router, members: members ?? [] }, { requestId });
}

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await requireRole("admin", { requestId, resource: "ai_routers" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org } = authz;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }

  const parsed = patchRouterSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const patch = parsed.data;

  const admin = createAdminClient();

  const { data: existing, error: loadErr } = await admin
    .from("ai_routers")
    .select("id, config")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (loadErr) {
    return fail("internal_error", "Erro ao carregar router.", 500, { requestId });
  }
  if (!existing) {
    return fail("not_found", "Router não encontrado.", 404, { requestId });
  }

  const update: Record<string, unknown> = {};
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.is_active !== undefined) update.is_active = patch.is_active;
  if (patch.fallback_agent_id !== undefined) update.fallback_agent_id = patch.fallback_agent_id;
  if (patch.config !== undefined) {
    const currentConfig = (existing.config ?? {}) as Record<string, unknown>;
    update.config = { ...currentConfig, ...patch.config };
  }

  if (Object.keys(update).length === 0) {
    return ok({ id }, { requestId });
  }

  const { error: updErr } = await admin
    .from("ai_routers")
    .update(update)
    .eq("id", id)
    .eq("organization_id", org.orgId);
  if (updErr) {
    if (updErr.code === "23505") {
      return fail("router_already_exists", "Este número já tem um roteador ativo.", 409, { requestId });
    }
    return fail("internal_error", "Erro ao atualizar router.", 500, { requestId });
  }

  void audit({
    action: "ai.router_updated",
    actorUserId: authUser.id,
    organizationId: org.orgId,
    resourceType: "ai_router",
    resourceId: id,
    requestId,
    metadata: { patch: Object.keys(update) },
  });

  return ok({ id }, { requestId });
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

export async function DELETE(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await requireRole("admin", { requestId, resource: "ai_routers" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org } = authz;

  const admin = createAdminClient();

  const { data: existing, error: loadErr } = await admin
    .from("ai_routers")
    .select("id")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (loadErr) {
    return fail("internal_error", "Erro ao carregar router.", 500, { requestId });
  }
  if (!existing) {
    return fail("not_found", "Router não encontrado.", 404, { requestId });
  }

  const { error: delErr } = await admin
    .from("ai_routers")
    .delete()
    .eq("id", id)
    .eq("organization_id", org.orgId);
  if (delErr) {
    return fail("internal_error", "Erro ao remover router.", 500, { requestId });
  }

  void audit({
    action: "ai.router_deleted",
    actorUserId: authUser.id,
    organizationId: org.orgId,
    resourceType: "ai_router",
    resourceId: id,
    requestId,
  });

  return ok({ id }, { requestId });
}
