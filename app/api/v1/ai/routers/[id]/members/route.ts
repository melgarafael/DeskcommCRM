import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PUT /api/v1/ai/routers/:id/members — substitui a lista INTEIRA de membros
 * do router (admin), audit `ai.router_members_updated`. `position` = índice
 * do array recebido. organization_id sempre de requireRole.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

type RouteCtx = { params: Promise<{ id: string }> };

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const memberInputSchema = z.object({
  agent_id: z.string().uuid(),
  intent_name: z.string().min(1).max(120),
  intent_description: z.string().min(1).max(2000),
  examples: z.array(z.string()).default([]),
});

const membersPutSchema = z.object({
  members: z.array(memberInputSchema),
});

export async function PUT(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await requireRole("admin", { requestId, resource: "ai_routers" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org } = authz;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }

  const parsed = membersPutSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const { members } = parsed.data;

  const admin = createAdminClient();

  const { data: router, error: routerErr } = await admin
    .from("ai_routers")
    .select("id")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (routerErr) {
    return fail("internal_error", "Erro ao carregar router.", 500, { requestId });
  }
  if (!router) {
    return fail("not_found", t("Router não encontrado."), 404, { requestId });
  }

  // Substitui a lista inteira: apaga os membros atuais (filtrando org) e
  // insere os novos com position = índice do array recebido.
  const { error: delErr } = await admin
    .from("ai_router_members")
    .delete()
    .eq("router_id", id)
    .eq("organization_id", org.orgId);
  if (delErr) {
    return fail("internal_error", "Erro ao limpar membros do router.", 500, { requestId });
  }

  if (members.length > 0) {
    const rows = members.map((m, position) => ({
      organization_id: org.orgId,
      router_id: id,
      agent_id: m.agent_id,
      intent_name: m.intent_name,
      intent_description: m.intent_description,
      examples: m.examples,
      position,
    }));

    const { error: insErr } = await admin.from("ai_router_members").insert(rows);
    if (insErr) {
      if (insErr.code === "23505") {
        return fail("duplicate_intent_name", t("Duas intenções não podem ter o mesmo nome no router."), 409, {
          requestId,
        });
      }
      return fail("internal_error", "Erro ao gravar membros do router.", 500, { requestId });
    }
  }

  void audit({
    action: "ai.router_members_updated",
    actorUserId: authUser.id,
    organizationId: org.orgId,
    resourceType: "ai_router",
    resourceId: id,
    requestId,
    metadata: { count: members.length },
  });

  return ok({ count: members.length }, { requestId });
}
