import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PUT /api/v1/ai/routers/:id/members — substitui a lista INTEIRA de membros
 * do router (admin), audit `ai.router_members_updated`. `position` = índice
 * do array recebido. organization_id sempre de requireRole.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";
import type { PoolClient } from "pg";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { writeRouterMembers } from "@/lib/ai/agents/router-members";
import { replaceRouterMembersHttp } from "@/lib/ai/agents/router-members-http";
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
  // Sem esta linha o Zod descartava o campo em silêncio e o vínculo
  // intenção → roteiro nunca era gravado (revisão do #1573, B2).
  flow_pointer_id: z.string().uuid().nullable().default(null),
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

  let db: PoolClient | undefined;
  try {
    if (process.env.SUPABASE_DB_URL) {
      db = await getRequestPool().connect();
      await db.query("begin");
      await writeRouterMembers(db, org.orgId, id, members, "replace");
      await db.query("commit");
    } else {
      await replaceRouterMembersHttp(createAdminClient(), org.orgId, id, members);
    }
  } catch (error) {
    if (db) await db.query("rollback");
    const message = error instanceof Error ? error.message : "";
    const code = (error as { code?: string }).code;
    if (message === "router_not_found")
      return fail("not_found", t("Router não encontrado."), 404, { requestId });
    if (message === "member_agent_not_found")
      return fail("validation_failed", t("Um dos agentes não existe nesta organização."), 422, {
        requestId,
      });
    if (message === "member_flow_not_found")
      return fail(
        "validation_failed",
        t("O fluxo de atendimento escolhido não existe nesta organização."),
        422,
        { requestId },
      );
    if (message === "duplicate_intent_name" || code === "23505")
      return fail(
        "duplicate_intent_name",
        t("Duas intenções não podem ter o mesmo nome no router."),
        409,
        { requestId },
      );
    return fail("internal_error", "Erro ao gravar membros do router.", 500, { requestId });
  } finally {
    db?.release();
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
