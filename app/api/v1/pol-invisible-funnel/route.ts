/**
 * GET|POST /api/v1/pol-invisible-funnel
 *
 * Funil invisivel politico — War Room 2.0 Fase 3.
 *
 * GET  — lista pol_invisible_funnel da organizacao. Aceita ?funnel_stage=, ?interaction_class=.
 *        Paginacao com limit/offset.
 * POST — cria um novo registro no funil. Requer role manager.
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

const FUNNEL_STAGES = [
  "awareness",
  "interest",
  "consideration",
  "intent",
  "evaluation",
  "conversion",
] as const;

const INTERACTION_CLASSES = [
  "cold",
  "warm",
  "hot",
  "engaged",
  "advocate",
] as const;

const criarPolInvisibleFunnelSchema = z.object({
  contact_id: z.string().uuid(),
  funnel_stage: z.enum(FUNNEL_STAGES).default("awareness"),
  funnel_score: z.number().int().default(0),
  theme_affinity: z.string().max(255).nullable().optional(),
  interaction_class: z.enum(INTERACTION_CLASSES).default("cold"),
  next_action: z.string().max(500).nullable().optional(),
});

// -- GET — listar pol_invisible_funnel ----------------------------------------

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authz = await requireRole("viewer", { requestId, resource: "pol_invisible_funnel" });
  if (!authz.ok) return authz.response;

  const { organizationId } = authz;
  const db = createAdminClient();
  const params = req.nextUrl.searchParams;

  let query = db
    .from("pol_invisible_funnel")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  // Filtros opcionais
  const funnelStage = params.get("funnel_stage");
  if (funnelStage) query = query.eq("funnel_stage", funnelStage);

  const interactionClass = params.get("interaction_class");
  if (interactionClass) query = query.eq("interaction_class", interactionClass);

  // Paginacao simples
  const limit = Math.min(parseInt(params.get("limit") ?? "50", 10), 100);
  const offset = parseInt(params.get("offset") ?? "0", 10);
  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;

  if (error) {
    return fail("internal_error", "Erro ao buscar pol_invisible_funnel", 500, { requestId });
  }

  return ok(
    { pol_invisible_funnel: data ?? [] },
    {
      headers: { "x-request-id": requestId },
      meta: { total: count ?? (data?.length ?? 0), limit, offset },
    },
  );
}

// -- POST — criar registro no funil -------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "pol_invisible_funnel" });
  if (!authz.ok) return authz.response;

  const { organizationId, userId } = authz;

  const guardaSuporteWrite = await requireSupportWrite({ requestId, resource: "pol_invisible_funnel.create" });
  if (!guardaSuporteWrite.ok) return guardaSuporteWrite.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", "JSON invalido", 400, { requestId });
  }

  const parsed = criarPolInvisibleFunnelSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_error", "Dados invalidos", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const db = createAdminClient();

  // Verificar se contact_id existe e pertence a organizacao
  const { data: contact, error: errContact } = await db
    .from("contacts")
    .select("id")
    .eq("id", parsed.data.contact_id)
    .eq("organization_id", organizationId)
    .single();

  if (errContact || !contact) {
    return fail("not_found", "Contato nao encontrado nesta organizacao", 404, { requestId });
  }

  const { data: funnelRecord, error } = await db
    .from("pol_invisible_funnel")
    .insert({
      organization_id: organizationId,
      contact_id: parsed.data.contact_id,
      funnel_stage: parsed.data.funnel_stage,
      funnel_score: parsed.data.funnel_score,
      theme_affinity: parsed.data.theme_affinity ?? null,
      interaction_class: parsed.data.interaction_class,
      next_action: parsed.data.next_action ?? null,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return fail("conflict", "Este contato ja possui registro no funil invisivel nesta organizacao", 409, {
        requestId,
      });
    }
    return fail("internal_error", "Erro ao criar registro no funil invisivel", 500, { requestId });
  }

  // Audit log
  db.from("api_audit_log").insert({
    organization_id: organizationId,
    user_id: userId,
    action: "pol_invisible_funnel.create",
    resource_type: "pol_invisible_funnel",
    resource_id: funnelRecord.id,
    request_id: requestId,
    metadata: { contact_id: funnelRecord.contact_id, funnel_stage: funnelRecord.funnel_stage },
  }).then(() => {});

  return ok({ pol_invisible_funnel: funnelRecord }, { status: 201, headers: { "x-request-id": requestId } });
}
