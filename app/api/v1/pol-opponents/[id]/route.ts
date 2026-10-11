/**
 * GET|PATCH|DELETE /api/v1/pol-opponents/[id]
 *
 * Operacoes em um pol_opponent especifico.
 *
 * GET    — detalhe do pol_opponent (viewer+)
 * PATCH  — atualizar parcialmente (manager+)
 * DELETE — hard delete (manager+)
 *
 * Seguranca: filtramos organization_id do cookie/JWT — nunca do body.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireSupportWrite } from "@/lib/impersonate/support";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// -- Validacao ----------------------------------------------------------------

const PLATFORMS = [
  "instagram",
  "facebook",
  "twitter",
  "tiktok",
  "youtube",
  "linkedin",
  "website",
] as const;

const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;

const atualizarPolOpponentSchema = z
  .object({
    name: z.string().min(1).max(255),
    platform: z.enum(PLATFORMS).nullable(),
    username: z.string().max(255).nullable(),
    bio: z.string().max(2000).nullable(),
    followers: z.number().int().min(0).nullable(),
    engagement_rate: z.number().min(0).max(100).nullable(),
    risk_level: z.enum(RISK_LEVELS),
    threat_score: z.number().min(0).max(100).nullable(),
    active: z.boolean(),
  })
  .partial(); // PATCH = todos opcionais

// -- Helpers ------------------------------------------------------------------

async function buscarPolOpponent(db: ReturnType<typeof createAdminClient>, id: string, organizationId: string) {
  return db
    .from("pol_opponents")
    .select("*")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .single();
}

// -- GET ----------------------------------------------------------------------

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("viewer", { requestId, resource: "pol_opponents" });
  if (!authz.ok) return authz.response;

  const db = createAdminClient();
  const { data: polOpponent, error } = await buscarPolOpponent(db, id, authz.organizationId);

  if (error || !polOpponent) {
    return fail("not_found", "Pol_opponent nao encontrado", 404, { requestId });
  }

  return ok({ pol_opponent: polOpponent }, { headers: { "x-request-id": requestId } });
}

// -- PATCH --------------------------------------------------------------------

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("manager", { requestId, resource: "pol_opponents" });
  if (!authz.ok) return authz.response;

  const { organizationId, userId } = authz;

  const guardaSuporteWrite = await requireSupportWrite({
    requestId,
    resource: "pol_opponents.update",
  });
  if (!guardaSuporteWrite.ok) return guardaSuporteWrite.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", "JSON invalido", 400, { requestId });
  }

  const parsed = atualizarPolOpponentSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_error", "Dados invalidos", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  if (Object.keys(parsed.data).length === 0) {
    return fail("bad_request", "Nenhum campo para atualizar", 400, { requestId });
  }

  const db = createAdminClient();

  // Verificar existencia + tenant
  const { data: existente, error: errBusca } = await db
    .from("pol_opponents")
    .select("id")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .single();

  if (errBusca || !existente) {
    return fail("not_found", "Pol_opponent nao encontrado", 404, { requestId });
  }

  const { data: atualizado, error: errUpdate } = await db
    .from("pol_opponents")
    .update(parsed.data)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select()
    .single();

  if (errUpdate) {
    return fail("internal_error", "Erro ao atualizar pol_opponent", 500, { requestId });
  }

  // Audit log
  await db.from("api_audit_log").insert({
    organization_id: organizationId,
    user_id: userId,
    action: "pol_opponents.update",
    resource_id: id,
    metadata: { campos_alterados: Object.keys(parsed.data) },
  });

  return ok({ pol_opponent: atualizado }, { headers: { "x-request-id": requestId } });
}

// -- DELETE -------------------------------------------------------------------

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("manager", { requestId, resource: "pol_opponents" });
  if (!authz.ok) return authz.response;

  const { organizationId, userId } = authz;

  const guardaSuporteWrite = await requireSupportWrite({
    requestId,
    resource: "pol_opponents.delete",
  });
  if (!guardaSuporteWrite.ok) return guardaSuporteWrite.response;

  const db = createAdminClient();

  const { data: existente, error: errBusca } = await db
    .from("pol_opponents")
    .select("id, name")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .single();

  if (errBusca || !existente) {
    return fail("not_found", "Pol_opponent nao encontrado", 404, { requestId });
  }

  // Hard delete
  const { error: errDelete } = await db
    .from("pol_opponents")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);

  if (errDelete) {
    return fail("internal_error", "Erro ao deletar pol_opponent", 500, { requestId });
  }

  // Audit log
  await db.from("api_audit_log").insert({
    organization_id: organizationId,
    user_id: userId,
    action: "pol_opponents.delete",
    resource_id: id,
    metadata: { name: existente.name },
  });

  return ok({ deleted: true }, { headers: { "x-request-id": requestId } });
}
