/**
 * GET|POST /api/v1/pol-content-generator
 *
 * CRUD de conteudo gerado para campanhas politicas.
 *
 * GET  — lista pol_generated_content da organizacao. Aceita ?content_type=, ?platform=, ?generation_source=.
 *        Paginacao com limit/offset. Ordenado por created_at desc.
 * POST — cria um novo conteudo. Requer role manager.
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

const CONTENT_TYPES = [
  "video_script",
  "caption",
  "carousel",
  "story",
  "reel_script",
  "live_script",
  "article",
  "thread",
  "other",
] as const;

const GENERATION_SOURCES = [
  "manual",
  "ai_auto",
  "ai_assisted",
  "template",
] as const;

const criarConteudoSchema = z.object({
  title: z.string().min(1).max(500),
  topic: z.string().min(1).max(500),
  target_audience: z.string().max(500).nullable().optional(),
  content_type: z.enum(CONTENT_TYPES).default("other"),
  script: z.string().max(10000).nullable().optional(),
  caption: z.string().max(5000).nullable().optional(),
  hashtags: z.array(z.string().max(100)).nullable().optional(),
  cta: z.string().max(500).nullable().optional(),
  platform: z.enum(PLATFORMS).nullable().optional(),
  viral_score: z.number().min(0).max(100).nullable().optional(),
  quality_score: z.number().min(0).max(100).nullable().optional(),
  generation_source: z.enum(GENERATION_SOURCES).default("manual"),
});

// -- GET — listar conteudo gerado ---------------------------------------------

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authz = await requireRole("viewer", { requestId, resource: "pol_generated_content" });
  if (!authz.ok) return authz.response;

  const { organizationId } = authz;
  const db = createAdminClient();
  const params = req.nextUrl.searchParams;

  let query = db
    .from("pol_generated_content")
    .select(
      "id, title, topic, target_audience, content_type, script, caption, hashtags, cta, platform, viral_score, quality_score, generation_source, created_at, updated_at",
    )
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  // Filtros opcionais
  const contentType = params.get("content_type");
  if (contentType) query = query.eq("content_type", contentType);

  const platform = params.get("platform");
  if (platform) query = query.eq("platform", platform);

  const generationSource = params.get("generation_source");
  if (generationSource) query = query.eq("generation_source", generationSource);

  // Paginacao simples
  const limit = Math.min(parseInt(params.get("limit") ?? "50", 10), 100);
  const offset = parseInt(params.get("offset") ?? "0", 10);
  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;

  if (error) {
    return fail("internal_error", "Erro ao buscar pol_generated_content", 500, { requestId });
  }

  return ok(
    { pol_generated_content: data ?? [] },
    {
      headers: { "x-request-id": requestId },
      meta: { total: count ?? (data?.length ?? 0), limit, offset },
    },
  );
}

// -- POST — criar conteudo ----------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "pol_generated_content" });
  if (!authz.ok) return authz.response;

  const { organizationId, userId } = authz;

  const guardaSuporteWrite = await requireSupportWrite({ requestId, resource: "pol_generated_content.create" });
  if (!guardaSuporteWrite.ok) return guardaSuporteWrite.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", "JSON invalido", 400, { requestId });
  }

  const parsed = criarConteudoSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_error", "Dados invalidos", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const db = createAdminClient();

  const { data: conteudo, error } = await db
    .from("pol_generated_content")
    .insert({
      organization_id: organizationId,
      title: parsed.data.title,
      topic: parsed.data.topic,
      target_audience: parsed.data.target_audience ?? null,
      content_type: parsed.data.content_type,
      script: parsed.data.script ?? null,
      caption: parsed.data.caption ?? null,
      hashtags: parsed.data.hashtags ?? null,
      cta: parsed.data.cta ?? null,
      platform: parsed.data.platform ?? null,
      viral_score: parsed.data.viral_score ?? null,
      quality_score: parsed.data.quality_score ?? null,
      generation_source: parsed.data.generation_source,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return fail("conflict", "Conteudo duplicado nesta organizacao", 409, {
        requestId,
      });
    }
    return fail("internal_error", "Erro ao criar conteudo", 500, { requestId });
  }

  // Audit log
  await db.from("api_audit_log").insert({
    organization_id: organizationId,
    user_id: userId,
    action: "pol_generated_content.create",
    resource_id: conteudo.id,
    metadata: { title: conteudo.title, content_type: conteudo.content_type, generation_source: conteudo.generation_source },
  });

  return ok({ pol_generated_content: conteudo }, { status: 201, headers: { "x-request-id": requestId } });
}
