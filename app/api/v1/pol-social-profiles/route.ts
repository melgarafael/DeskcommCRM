/**
 * GET|POST /api/v1/pol-social-profiles
 *
 * CRUD de perfis sociais politicos — monitoramento de redes.
 *
 * GET  — lista pol_social_profiles da organizacao. Aceita ?platform=, ?category=, ?active=.
 *        Paginacao com limit/offset.
 * POST — cria um novo pol_social_profile. Requer role manager.
 *
 * Seguranca: organizacao resolvida do cookie/JWT (fonte confiavel). Nunca do body.
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

const criarPolSocialProfileSchema = z.object({
  platform: z.enum(PLATFORMS),
  username: z.string().min(1).max(120),
  display_name: z.string().max(200).nullable().optional(),
  bio: z.string().max(2000).nullable().optional(),
  followers: z.number().int().nonnegative().nullable().optional(),
  following: z.number().int().nonnegative().nullable().optional(),
  posts_count: z.number().int().nonnegative().nullable().optional(),
  engagement_rate: z.number().nonnegative().nullable().optional(),
  category: z.enum(CATEGORIES).default("monitorado"),
  active: z.boolean().default(true),
});

// -- GET — listar pol_social_profiles -----------------------------------------

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authz = await requireRole("viewer", { requestId, resource: "pol_social_profiles" });
  if (!authz.ok) return authz.response;

  const { organizationId } = authz;
  const db = createAdminClient();
  const params = req.nextUrl.searchParams;

  let query = db
    .from("pol_social_profiles")
    .select(
      "id, platform, username, display_name, bio, followers, following, posts_count, engagement_rate, category, active, created_at, updated_at",
    )
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  // Filtros opcionais
  const platform = params.get("platform");
  if (platform) query = query.eq("platform", platform);

  const category = params.get("category");
  if (category) query = query.eq("category", category);

  const active = params.get("active");
  if (active !== null) query = query.eq("active", active === "true");

  // Paginacao simples
  const limit = Math.min(parseInt(params.get("limit") ?? "50", 10), 100);
  const offset = parseInt(params.get("offset") ?? "0", 10);
  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;

  if (error) {
    return fail("internal_error", "Erro ao buscar pol_social_profiles", 500, { requestId });
  }

  return ok(
    { pol_social_profiles: data ?? [] },
    {
      headers: { "x-request-id": requestId },
      meta: { total: count ?? (data?.length ?? 0), limit, offset },
    },
  );
}

// -- POST — criar pol_social_profile ------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "pol_social_profiles" });
  if (!authz.ok) return authz.response;

  const { organizationId, userId } = authz;

  const guardaSuporteWrite = await requireSupportWrite({ requestId, resource: "pol_social_profiles.create" });
  if (!guardaSuporteWrite.ok) return guardaSuporteWrite.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", "JSON invalido", 400, { requestId });
  }

  const parsed = criarPolSocialProfileSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_error", "Dados invalidos", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const db = createAdminClient();

  const { data: profile, error } = await db
    .from("pol_social_profiles")
    .insert({
      organization_id: organizationId,
      platform: parsed.data.platform,
      username: parsed.data.username,
      display_name: parsed.data.display_name ?? null,
      bio: parsed.data.bio ?? null,
      followers: parsed.data.followers ?? null,
      following: parsed.data.following ?? null,
      posts_count: parsed.data.posts_count ?? null,
      engagement_rate: parsed.data.engagement_rate ?? null,
      category: parsed.data.category,
      active: parsed.data.active,
    })
    .select()
    .single();

  if (error) {
    // Duplicate org+platform+username constraint
    if (error.code === "23505") {
      return fail("conflict", "Este perfil (plataforma + username) ja existe nesta organizacao", 409, {
        requestId,
      });
    }
    return fail("internal_error", "Erro ao criar pol_social_profile", 500, { requestId });
  }

  // Audit log
  await db.from("api_audit_log").insert({
    organization_id: organizationId,
    user_id: userId,
    action: "pol_social_profiles.create",
    resource_id: profile.id,
    metadata: { platform: profile.platform, username: profile.username, category: profile.category },
  });

  return ok({ pol_social_profile: profile }, { status: 201, headers: { "x-request-id": requestId } });
}
