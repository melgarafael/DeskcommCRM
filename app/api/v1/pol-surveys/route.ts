/**
 * GET|POST /api/v1/pol-surveys
 *
 * Pesquisas politicas — War Room 2.0 Fase 3.
 *
 * GET  — lista pol_surveys da organizacao. Aceita ?status=, ?type=.
 *        Paginacao com limit/offset.
 * POST — cria uma nova pesquisa. Requer role manager.
 *        public_token gerado server-side, NUNCA aceito do cliente.
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

const SURVEY_TYPES = [
  "field",
  "online",
  "phone",
  "door_to_door",
  "other",
] as const;

const SURVEY_STATUSES = [
  "draft",
  "active",
  "paused",
  "completed",
  "archived",
] as const;

const criarPolSurveySchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().max(5000).nullable().optional(),
  type: z.enum(SURVEY_TYPES).default("field"),
  start_date: z.string().datetime().nullable().optional(),
  end_date: z.string().datetime().nullable().optional(),
});

// -- GET — listar pol_surveys -------------------------------------------------

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authz = await requireRole("viewer", { requestId, resource: "pol_surveys" });
  if (!authz.ok) return authz.response;

  const { organizationId } = authz;
  const db = createAdminClient();
  const params = req.nextUrl.searchParams;

  let query = db
    .from("pol_surveys")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  // Filtros opcionais
  const status = params.get("status");
  if (status) query = query.eq("status", status);

  const type = params.get("type");
  if (type) query = query.eq("type", type);

  // Paginacao simples
  const limit = Math.min(parseInt(params.get("limit") ?? "50", 10), 100);
  const offset = parseInt(params.get("offset") ?? "0", 10);
  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;

  if (error) {
    return fail("internal_error", "Erro ao buscar pol_surveys", 500, { requestId });
  }

  return ok(
    { pol_surveys: data ?? [] },
    {
      headers: { "x-request-id": requestId },
      meta: { total: count ?? (data?.length ?? 0), limit, offset },
    },
  );
}

// -- POST — criar pol_survey --------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "pol_surveys" });
  if (!authz.ok) return authz.response;

  const { organizationId, userId } = authz;

  const guardaSuporteWrite = await requireSupportWrite({ requestId, resource: "pol_surveys.create" });
  if (!guardaSuporteWrite.ok) return guardaSuporteWrite.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", "JSON invalido", 400, { requestId });
  }

  const parsed = criarPolSurveySchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_error", "Dados invalidos", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const db = createAdminClient();

  // public_token gerado server-side — NUNCA aceito do cliente
  const publicToken = randomUUID().replace(/-/g, "");

  const { data: survey, error } = await db
    .from("pol_surveys")
    .insert({
      organization_id: organizationId,
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      type: parsed.data.type,
      status: "draft" as const,
      public_token: publicToken,
      start_date: parsed.data.start_date ?? null,
      end_date: parsed.data.end_date ?? null,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return fail("conflict", "Pesquisa duplicada nesta organizacao", 409, { requestId });
    }
    return fail("internal_error", "Erro ao criar pol_survey", 500, { requestId });
  }

  // Audit log
  db.from("api_audit_log").insert({
    organization_id: organizationId,
    user_id: userId,
    action: "pol_surveys.create",
    resource_type: "pol_surveys",
    resource_id: survey.id,
    request_id: requestId,
    metadata: { title: survey.title, type: survey.type, public_token: publicToken },
  }).then(() => {});

  return ok({ pol_survey: survey }, { status: 201, headers: { "x-request-id": requestId } });
}
