import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/ai/routers — lista routers da org (agent+), com member_count.
 * POST /api/v1/ai/routers — cria router (admin), audit `ai.router_created`.
 *
 * Intent Router (Fase 3 do épico harness — spec 2026-07-23, migration 0085).
 * organization_id vem SEMPRE de requireRole — nunca do body. Unique parcial
 * index (channel_session_id where is_active) garante 1 router ativo por sessão
 * — violação vira 409 tratado, não 500 cru.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const ROUTER_LIST_COLUMNS = "id, name, channel_session_id, is_active, fallback_agent_id, updated_at";

const createRouterSchema = z.object({
  name: z.string().min(1).max(120),
  channel_session_id: z.string().uuid(),
  fallback_agent_id: z.string().uuid().nullable().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "ai_routers" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const admin = createAdminClient();

  const { data: routers, error: routersErr } = await admin
    .from("ai_routers")
    .select(ROUTER_LIST_COLUMNS)
    .eq("organization_id", org.orgId)
    .order("created_at", { ascending: false });
  if (routersErr) {
    return fail("internal_error", "Erro ao listar routers.", 500, { requestId });
  }

  const { data: memberRows, error: membersErr } = await admin
    .from("ai_router_members")
    .select("router_id")
    .eq("organization_id", org.orgId);
  if (membersErr) {
    return fail("internal_error", "Erro ao contar membros dos routers.", 500, { requestId });
  }

  const counts = new Map<string, number>();
  for (const m of (memberRows ?? []) as Array<{ router_id: string }>) {
    counts.set(m.router_id, (counts.get(m.router_id) ?? 0) + 1);
  }

  const result = (routers ?? []).map((r) => ({ ...r, member_count: counts.get(r.id) ?? 0 }));

  return ok({ routers: result }, { requestId });
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "ai_routers" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org } = authz;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }

  const parsed = createRouterSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const input = parsed.data;

  const admin = createAdminClient();

  // Arquivado não é destino válido — a linha só sobrevive por causa das FKs.
  //
  // Tolerante à coluna ausente, e o erro NÃO vira 404. Esta consulta produziu o
  // 404 mais enganoso do produto: num banco sem a migration 0106 o PostgREST
  // devolve 42703, `data` vem null, e descartar o `error` transformava "a
  // consulta falhou" em "esse número não é seu" — sobre um número WORKING que a
  // tela ao lado listava. O usuário só podia concluir que o CRM tinha perdido o
  // canal dele. Falhar aberto na informação: se não deu para verificar, dizemos
  // que não deu, em vez de afirmar a ausência (ver lib/channels/archived).
  const base = () =>
    admin
      .from("channel_sessions")
      .select("id")
      .eq("id", input.channel_session_id)
      .eq("organization_id", org.orgId);
  const { data: session, error: sessionErr } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );
  if (sessionErr) {
    return fail("internal_error", "Erro ao verificar o número de WhatsApp.", 500, { requestId });
  }
  if (!session) {
    return fail("channel_session_not_found", "Número de WhatsApp não encontrado nesta organização.", 404, {
      requestId,
    });
  }

  const { data: created, error: insErr } = await admin
    .from("ai_routers")
    .insert({
      organization_id: org.orgId,
      name: input.name,
      channel_session_id: input.channel_session_id,
      fallback_agent_id: input.fallback_agent_id ?? null,
      ...(input.config !== undefined ? { config: input.config } : {}),
      created_by: authUser.id,
    })
    .select("id")
    .single();

  if (insErr || !created) {
    if (insErr?.code === "23505") {
      return fail("router_already_exists", "Este número já tem um roteador ativo.", 409, { requestId });
    }
    return fail("internal_error", "Erro ao criar router.", 500, { requestId });
  }

  void audit({
    action: "ai.router_created",
    actorUserId: authUser.id,
    organizationId: org.orgId,
    resourceType: "ai_router",
    resourceId: created.id,
    requestId,
    metadata: { name: input.name, channel_session_id: input.channel_session_id },
  });

  return ok({ id: created.id }, { status: 201, requestId });
}
