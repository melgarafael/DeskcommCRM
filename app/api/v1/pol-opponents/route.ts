/**
 * GET|POST /api/v1/pol-opponents
 *
 * CRUD de oponentes politicos — monitoramento de adversarios.
 *
 * GET  — lista pol_opponents da organizacao. Aceita ?risk_level=, ?platform=, ?active=.
 *        Paginacao com limit/offset. Ordenado por threat_score desc.
 * POST — cria um novo pol_opponent. Requer role manager.
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
  "website",
] as const;

const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;

const criarPolOpponentSchema = z.object({
  name: z.string().min(1).max(255),
  platform: z.enum(PLATFORMS).nullable().optional(),
  username: z.string().max(255).nullable().optional(),
  bio: z.string().max(2000).nullable().optional(),
  followers: z.number().int().min(0).nullable().optional(),
  engagement_rate: z.number().min(0).max(100).nullable().optional(),
  risk_level: z.enum(RISK_LEVELS).default("low"),
  threat_score: z.number().min(0).max(100).nullable().optional(),
  active: z.boolean().default(true),
});

// -- GET — listar pol_opponents -----------------------------------------------

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authz = await requireRole("viewer", { requestId, resource: "pol_opponents" });
  if (!authz.ok) return authz.response;

  const { organizationId } = authz;
  const db = createAdminClient();
  const params = req.nextUrl.searchParams;

  let query = db
    .from("pol_opponents")
    .select(
      "id, name, platform, username, bio, followers, engagement_rate, risk_level, threat_score, active, created_at, updated_at",
    )
    .eq("organization_id", organizationId)
    .order("threat_score", { ascending: false, nullsFirst: false });

  // Filtros opcionais
  const riskLevel = params.get("risk_level");
  if (riskLevel) query = query.eq("risk_level", riskLevel);

  const platform = params.get("platform");
  if (platform) query = query.eq("platform", platform);

  const active = params.get("active");
  if (active !== null) query = query.eq("active", active === "true");

  // Paginacao simples
  const limit = Math.min(parseInt(params.get("limit") ?? "50", 10), 100);
  const offset = parseInt(params.get("offset") ?? "0", 10);
  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;

  if (error) {
    return fail("internal_error", "Erro ao buscar pol_opponents", 500, { requestId });
  }

  return ok(
    { pol_opponents: data ?? [] },
    {
      headers: { "x-request-id": requestId },
      meta: { total: count ?? (data?.length ?? 0), limit, offset },
    },
  );
}

// -- POST — criar pol_opponent ------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "pol_opponents" });
  if (!authz.ok) return authz.response;

  const { organizationId, userId } = authz;

  const guardaSuporteWrite = await requireSupportWrite({ requestId, resource: "pol_opponents.create" });
  if (!guardaSuporteWrite.ok) return guardaSuporteWrite.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", "JSON invalido", 400, { requestId });
  }

  const parsed = criarPolOpponentSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_error", "Dados invalidos", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const db = createAdminClient();

  const { data: polOpponent, error } = await db
    .from("pol_opponents")
    .insert({
      organization_id: organizationId,
      name: parsed.data.name,
      platform: parsed.data.platform ?? null,
      username: parsed.data.username ?? null,
      bio: parsed.data.bio ?? null,
      followers: parsed.data.followers ?? null,
      engagement_rate: parsed.data.engagement_rate ?? null,
      risk_level: parsed.data.risk_level,
      threat_score: parsed.data.threat_score ?? null,
      active: parsed.data.active,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return fail("conflict", "Este oponente ja existe nesta organizacao", 409, {
        requestId,
      });
    }
    return fail("internal_error", "Erro ao criar pol_opponent", 500, { requestId });
  }

  // Audit log
  await db.from("api_audit_log").insert({
    organization_id: organizationId,
    user_id: userId,
    action: "pol_opponents.create",
    resource_id: polOpponent.id,
    metadata: { name: polOpponent.name, risk_level: polOpponent.risk_level },
  });

  return ok({ pol_opponent: polOpponent }, { status: 201, headers: { "x-request-id": requestId } });
}
