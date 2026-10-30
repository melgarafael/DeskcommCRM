import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET    /api/v1/ai/routers/:id — detalhe do router + membros (agent+).
 * PATCH  /api/v1/ai/routers/:id — atualiza campos (admin), audit `ai.router_updated`.
 * DELETE /api/v1/ai/routers/:id — remove o router (admin), audit `ai.router_deleted`.
 *   Cascade FK (migration 0085) já apaga ai_router_members junto.
 *
 * organization_id sempre da sessão/token — nunca do path/body.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";
import { senderRoutesSchema } from "@/lib/ai/agents/sender-routes";
import { MAX_CLASSIFIER_CONTEXT_MESSAGES } from "@/lib/ai/classifier-context";

export const dynamic = "force-dynamic";

type RouteCtx = { params: Promise<{ id: string }> };

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ROUTER_DETAIL_COLUMNS = "id, name, channel_session_id, is_active, config, fallback_agent_id";
const MEMBER_COLUMNS =
  "id, agent_id, intent_name, intent_description, examples, position, flow_pointer_id, pipeline_id, stage_id";

const patchRouterSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  is_active: z.boolean().optional(),
  fallback_agent_id: z.string().uuid().nullable().optional(),
  config: z
    .record(z.string(), z.unknown())
    .optional()
    .refine(
      (c) =>
        c?.context_message_count === undefined ||
        (typeof c.context_message_count === "number" &&
          Number.isInteger(c.context_message_count) &&
          c.context_message_count >= 0 &&
          c.context_message_count <= MAX_CLASSIFIER_CONTEXT_MESSAGES),
      "context_message_count deve ser inteiro entre 0 e 16",
    ),
});

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "ai_routers",
    role: "agent",
    scope: "config:read",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");
  const { organizationId } = authz;

  const admin = createAdminClient();

  const { data: router, error: routerErr } = await admin
    .from("ai_routers")
    .select(ROUTER_DETAIL_COLUMNS)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (routerErr) {
    return fail("internal_error", "Erro ao buscar router.", 500, { requestId });
  }
  if (!router) {
    return fail("not_found", t("Router não encontrado."), 404, { requestId });
  }

  const { data: members, error: membersErr } = await admin
    .from("ai_router_members")
    .select(MEMBER_COLUMNS)
    .eq("router_id", id)
    .eq("organization_id", organizationId)
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

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "ai_routers",
    role: "admin",
    scope: "config:write",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");
  const { organizationId, actor } = authz;

  const teto = await tetoDeEscritaDoToken(authz, "ai_routers", requestId);
  if (teto) return teto;
  const authUserId = actor.type === "user" ? actor.id : null;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }

  const parsed = patchRouterSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const patch = parsed.data;

  const admin = createAdminClient();

  const { data: existing, error: loadErr } = await admin
    .from("ai_routers")
    .select("id, config, fallback_agent_id")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (loadErr) {
    return fail("internal_error", "Erro ao carregar router.", 500, { requestId });
  }
  if (!existing) {
    return fail("not_found", t("Router não encontrado."), 404, { requestId });
  }

  const update: Record<string, unknown> = {};
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.is_active !== undefined) update.is_active = patch.is_active;
  if (patch.fallback_agent_id !== undefined) update.fallback_agent_id = patch.fallback_agent_id;
  if (patch.config !== undefined) {
    const currentConfig = (existing.config ?? {}) as Record<string, unknown>;
    update.config = { ...currentConfig, ...patch.config };
  }

  const mergedConfig = (update.config ?? existing.config ?? {}) as Record<string, unknown>;
  if (mergedConfig.sender_routes !== undefined) {
    const routes = senderRoutesSchema.safeParse(mergedConfig.sender_routes);
    if (!routes.success)
      return fail("validation_failed", "Regras por remetente inválidas.", 422, { requestId });
    const fallback =
      patch.fallback_agent_id !== undefined ? patch.fallback_agent_id : existing.fallback_agent_id;
    if (routes.data.length && (!fallback || routes.data.some((r) => r.agent_id === fallback))) {
      return fail(
        "validation_failed",
        "Escolha um fallback público diferente dos agentes reservados.",
        422,
        { requestId },
      );
    }
    const ids = [
      ...new Set([
        ...routes.data.map((r) => r.agent_id),
        ...(routes.data.length && fallback ? [fallback] : []),
      ]),
    ];
    if (ids.length) {
      const found = await admin
        .from("ai_agents")
        .select("id")
        .eq("organization_id", organizationId)
        .is("archived_at", null)
        .in("id", ids);
      if (found.error)
        return fail("internal_error", "Erro ao validar agentes.", 500, { requestId });
      if (found.data?.length !== ids.length)
        return fail("validation_failed", "Agente não encontrado nesta organização.", 422, {
          requestId,
        });
    }
    if (update.config) update.config = { ...mergedConfig, sender_routes: routes.data };
  }

  if (Object.keys(update).length === 0) {
    return ok({ id }, { requestId });
  }

  const { error: updErr } = await admin
    .from("ai_routers")
    .update(update)
    .eq("id", id)
    .eq("organization_id", organizationId);
  if (updErr) {
    if (updErr.code === "23505") {
      return fail("router_already_exists", t("Este número já tem um roteador ativo."), 409, {
        requestId,
      });
    }
    return fail("internal_error", "Erro ao atualizar router.", 500, { requestId });
  }

  void audit({
    action: "ai.router_updated",
    actorUserId: authUserId,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId,
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

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "ai_routers",
    role: "admin",
    scope: "config:write",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");
  const { organizationId, actor } = authz;

  const teto = await tetoDeEscritaDoToken(authz, "ai_routers", requestId);
  if (teto) return teto;
  const authUserId = actor.type === "user" ? actor.id : null;

  const admin = createAdminClient();

  const { data: existing, error: loadErr } = await admin
    .from("ai_routers")
    .select("id")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (loadErr) {
    return fail("internal_error", "Erro ao carregar router.", 500, { requestId });
  }
  if (!existing) {
    return fail("not_found", t("Router não encontrado."), 404, { requestId });
  }

  const { error: delErr } = await admin
    .from("ai_routers")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);
  if (delErr) {
    return fail("internal_error", "Erro ao remover router.", 500, { requestId });
  }

  void audit({
    action: "ai.router_deleted",
    actorUserId: authUserId,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId,
    resourceType: "ai_router",
    resourceId: id,
    requestId,
  });

  return ok({ id }, { requestId });
}
