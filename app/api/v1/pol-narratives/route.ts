/**
 * GET|POST /api/v1/pol-narratives
 *
 * CRUD de narrativas politicas — monitoramento de narrativas por plataforma.
 *
 * GET  — lista pol_narratives da organizacao. Aceita ?sentiment=, ?strategic_status=, ?platform=.
 *        Paginacao com limit/offset. Ordenado por strength desc.
 * POST — cria uma nova narrativa. Requer role manager.
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

const criarNarrativaSchema = z.object({
  theme: z.string().min(1).max(500),
  platform: z.enum(PLATFORMS).nullable().optional(),
  city: z.string().max(120).nullable().optional(),
  sentiment: z.enum(SENTIMENTS).nullable().optional(),
  strength: z.number().min(0).max(100).nullable().optional(),
  posts_count: z.number().int().min(0).nullable().optional(),
  reach: z.number().int().min(0).nullable().optional(),
  engagement_score: z.number().min(0).nullable().optional(),
  strategic_status: z.enum(STRATEGIC_STATUSES).default("monitoring"),
  recommended_action: z.string().max(2000).nullable().optional(),
});

// -- GET — listar narrativas --------------------------------------------------

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authz = await requireRole("viewer", { requestId, resource: "pol_narratives" });
  if (!authz.ok) return authz.response;

  const { organizationId } = authz;
  const db = createAdminClient();
  const params = req.nextUrl.searchParams;

  let query = db
    .from("pol_narratives")
    .select(
      "id, theme, platform, city, sentiment, strength, posts_count, reach, engagement_score, strategic_status, recommended_action, created_at, updated_at",
    )
    .eq("organization_id", organizationId)
    .order("strength", { ascending: false, nullsFirst: false });

  // Filtros opcionais
  const sentiment = params.get("sentiment");
  if (sentiment) query = query.eq("sentiment", sentiment);

  const strategicStatus = params.get("strategic_status");
  if (strategicStatus) query = query.eq("strategic_status", strategicStatus);

  const platform = params.get("platform");
  if (platform) query = query.eq("platform", platform);

  // Paginacao simples
  const limit = Math.min(parseInt(params.get("limit") ?? "50", 10), 100);
  const offset = parseInt(params.get("offset") ?? "0", 10);
  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;

  if (error) {
    return fail("internal_error", "Erro ao buscar pol_narratives", 500, { requestId });
  }

  return ok(
    { pol_narratives: data ?? [] },
    {
      headers: { "x-request-id": requestId },
      meta: { total: count ?? (data?.length ?? 0), limit, offset },
    },
  );
}

// -- POST — criar narrativa --------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "pol_narratives" });
  if (!authz.ok) return authz.response;

  const { organizationId, userId } = authz;

  const guardaSuporteWrite = await requireSupportWrite({ requestId, resource: "pol_narratives.create" });
  if (!guardaSuporteWrite.ok) return guardaSuporteWrite.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", "JSON invalido", 400, { requestId });
  }

  const parsed = criarNarrativaSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_error", "Dados invalidos", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const db = createAdminClient();

  const { data: narrativa, error } = await db
    .from("pol_narratives")
    .insert({
      organization_id: organizationId,
      theme: parsed.data.theme,
      platform: parsed.data.platform ?? null,
      city: parsed.data.city ?? null,
      sentiment: parsed.data.sentiment ?? null,
      strength: parsed.data.strength ?? null,
      posts_count: parsed.data.posts_count ?? null,
      reach: parsed.data.reach ?? null,
      engagement_score: parsed.data.engagement_score ?? null,
      strategic_status: parsed.data.strategic_status,
      recommended_action: parsed.data.recommended_action ?? null,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return fail("conflict", "Narrativa duplicada nesta organizacao", 409, {
        requestId,
      });
    }
    return fail("internal_error", "Erro ao criar narrativa", 500, { requestId });
  }

  // Audit log
  await db.from("api_audit_log").insert({
    organization_id: organizationId,
    user_id: userId,
    action: "pol_narratives.create",
    resource_id: narrativa.id,
    metadata: { theme: narrativa.theme, strategic_status: narrativa.strategic_status },
  });

  return ok({ pol_narrative: narrativa }, { status: 201, headers: { "x-request-id": requestId } });
}
