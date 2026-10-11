/**
 * GET|PATCH|DELETE /api/v1/pol-narratives/[id]
 *
 * Operacoes em uma narrativa politica especifica.
 *
 * GET    — detalhe da narrativa (viewer+)
 * PATCH  — atualizar parcialmente (manager+)
 * DELETE — hard delete (admin only, dados de tenant)
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
  "whatsapp",
  "news",
  "cross_platform",
] as const;

const SENTIMENTS = ["positive", "negative", "neutral", "mixed"] as const;

const STRATEGIC_STATUSES = [
  "monitoring",
  "opportunity",
  "threat",
  "crisis",
  "resolved",
] as const;

const atualizarNarrativaSchema = z
  .object({
    theme: z.string().min(1).max(500),
    platform: z.enum(PLATFORMS).nullable(),
    city: z.string().max(120).nullable(),
    sentiment: z.enum(SENTIMENTS).nullable(),
    strength: z.number().min(0).max(100).nullable(),
    posts_count: z.number().int().min(0).nullable(),
    reach: z.number().int().min(0).nullable(),
    engagement_score: z.number().min(0).nullable(),
    strategic_status: z.enum(STRATEGIC_STATUSES),
    recommended_action: z.string().max(2000).nullable(),
  })
  .partial(); // PATCH = todos opcionais

// -- Helpers ------------------------------------------------------------------

async function buscarNarrativa(db: ReturnType<typeof createAdminClient>, id: string, organizationId: string) {
  return db
    .from("pol_narratives")
    .select("*")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .single();
}

// -- GET ----------------------------------------------------------------------

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("viewer", { requestId, resource: "pol_narratives" });
  if (!authz.ok) return authz.response;

  const db = createAdminClient();
  const { data: narrativa, error } = await buscarNarrativa(db, id, authz.organizationId);

  if (error || !narrativa) {
    return fail("not_found", "Narrativa nao encontrada", 404, { requestId });
  }

  return ok({ pol_narrative: narrativa }, { headers: { "x-request-id": requestId } });
}

// -- PATCH --------------------------------------------------------------------

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("manager", { requestId, resource: "pol_narratives" });
  if (!authz.ok) return authz.response;

  const { organizationId, userId } = authz;

  const guardaSuporteWrite = await requireSupportWrite({
    requestId,
    resource: "pol_narratives.update",
  });
  if (!guardaSuporteWrite.ok) return guardaSuporteWrite.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", "JSON invalido", 400, { requestId });
  }

  const parsed = atualizarNarrativaSchema.safeParse(body);
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
    .from("pol_narratives")
    .select("id")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .single();

  if (errBusca || !existente) {
    return fail("not_found", "Narrativa nao encontrada", 404, { requestId });
  }

  const { data: atualizada, error: errUpdate } = await db
    .from("pol_narratives")
    .update(parsed.data)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select()
    .single();

  if (errUpdate) {
    return fail("internal_error", "Erro ao atualizar narrativa", 500, { requestId });
  }

  // Audit log
  await db.from("api_audit_log").insert({
    organization_id: organizationId,
    user_id: userId,
    action: "pol_narratives.update",
    resource_id: id,
    metadata: { campos_alterados: Object.keys(parsed.data) },
  });

  return ok({ pol_narrative: atualizada }, { headers: { "x-request-id": requestId } });
}

// -- DELETE -------------------------------------------------------------------

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("admin", { requestId, resource: "pol_narratives" });
  if (!authz.ok) return authz.response;

  const { organizationId, userId } = authz;

  const guardaSuporteWrite = await requireSupportWrite({
    requestId,
    resource: "pol_narratives.delete",
  });
  if (!guardaSuporteWrite.ok) return guardaSuporteWrite.response;

  const db = createAdminClient();

  const { data: existente, error: errBusca } = await db
    .from("pol_narratives")
    .select("id, theme")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .single();

  if (errBusca || !existente) {
    return fail("not_found", "Narrativa nao encontrada", 404, { requestId });
  }

  const { error: errDelete } = await db
    .from("pol_narratives")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);

  if (errDelete) {
    return fail("internal_error", "Erro ao deletar narrativa", 500, { requestId });
  }

  // Audit log
  await db.from("api_audit_log").insert({
    organization_id: organizationId,
    user_id: userId,
    action: "pol_narratives.delete",
    resource_id: id,
    metadata: { theme: existente.theme },
  });

  return ok({ deleted: true }, { headers: { "x-request-id": requestId } });
}
