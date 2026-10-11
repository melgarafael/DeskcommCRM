/**
 * GET|PATCH|DELETE /api/v1/pol-social-profiles/[id]
 *
 * Operacoes em um pol_social_profile especifico.
 *
 * GET    — detalhe do pol_social_profile (viewer+)
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
] as const;

const CATEGORIES = [
  "monitorado",
  "influencer",
  "aliado",
  "neutro",
  "adversario",
] as const;

const atualizarPolSocialProfileSchema = z
  .object({
    platform: z.enum(PLATFORMS),
    username: z.string().min(1).max(120),
    display_name: z.string().max(200).nullable(),
    bio: z.string().max(2000).nullable(),
    followers: z.number().int().nonnegative().nullable(),
    following: z.number().int().nonnegative().nullable(),
    posts_count: z.number().int().nonnegative().nullable(),
    engagement_rate: z.number().nonnegative().nullable(),
    category: z.enum(CATEGORIES),
    active: z.boolean(),
  })
  .partial(); // PATCH = todos opcionais

// -- Helpers ------------------------------------------------------------------

async function buscarPolSocialProfile(db: ReturnType<typeof createAdminClient>, id: string, organizationId: string) {
  return db
    .from("pol_social_profiles")
    .select("*")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .single();
}

// -- GET ----------------------------------------------------------------------

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("viewer", { requestId, resource: "pol_social_profiles" });
  if (!authz.ok) return authz.response;

  const db = createAdminClient();
  const { data: profile, error } = await buscarPolSocialProfile(db, id, authz.organizationId);

  if (error || !profile) {
    return fail("not_found", "Perfil social nao encontrado", 404, { requestId });
  }

  return ok({ pol_social_profile: profile }, { headers: { "x-request-id": requestId } });
}

// -- PATCH --------------------------------------------------------------------

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("manager", { requestId, resource: "pol_social_profiles" });
  if (!authz.ok) return authz.response;

  const { organizationId, userId } = authz;

  const guardaSuporteWrite = await requireSupportWrite({
    requestId,
    resource: "pol_social_profiles.update",
  });
  if (!guardaSuporteWrite.ok) return guardaSuporteWrite.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", "JSON invalido", 400, { requestId });
  }

  const parsed = atualizarPolSocialProfileSchema.safeParse(body);
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
    .from("pol_social_profiles")
    .select("id")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .single();

  if (errBusca || !existente) {
    return fail("not_found", "Perfil social nao encontrado", 404, { requestId });
  }

  const { data: atualizado, error: errUpdate } = await db
    .from("pol_social_profiles")
    .update(parsed.data)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select()
    .single();

  if (errUpdate) {
    // Duplicate org+platform+username constraint on update
    if (errUpdate.code === "23505") {
      return fail("conflict", "Este perfil (plataforma + username) ja existe nesta organizacao", 409, {
        requestId,
      });
    }
    return fail("internal_error", "Erro ao atualizar pol_social_profile", 500, { requestId });
  }

  // Audit log
  await db.from("api_audit_log").insert({
    organization_id: organizationId,
    user_id: userId,
    action: "pol_social_profiles.update",
    resource_id: id,
    metadata: { campos_alterados: Object.keys(parsed.data) },
  });

  return ok({ pol_social_profile: atualizado }, { headers: { "x-request-id": requestId } });
}

// -- DELETE -------------------------------------------------------------------

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("manager", { requestId, resource: "pol_social_profiles" });
  if (!authz.ok) return authz.response;

  const { organizationId, userId } = authz;

  const guardaSuporteWrite = await requireSupportWrite({
    requestId,
    resource: "pol_social_profiles.delete",
  });
  if (!guardaSuporteWrite.ok) return guardaSuporteWrite.response;

  const db = createAdminClient();

  const { data: existente, error: errBusca } = await db
    .from("pol_social_profiles")
    .select("id, platform, username")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .single();

  if (errBusca || !existente) {
    return fail("not_found", "Perfil social nao encontrado", 404, { requestId });
  }

  const { error: errDelete } = await db
    .from("pol_social_profiles")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);

  if (errDelete) {
    return fail("internal_error", "Erro ao deletar pol_social_profile", 500, { requestId });
  }

  // Audit log
  await db.from("api_audit_log").insert({
    organization_id: organizationId,
    user_id: userId,
    action: "pol_social_profiles.delete",
    resource_id: id,
    metadata: { platform: existente.platform, username: existente.username },
  });

  return ok({ deleted: true }, { headers: { "x-request-id": requestId } });
}
