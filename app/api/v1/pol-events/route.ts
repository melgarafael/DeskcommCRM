/**
 * GET|POST /api/v1/pol-events
 *
 * Eventos politicos — War Room 2.0 Fase 3.
 *
 * GET  — lista pol_events da organizacao. Aceita ?status=, ?type=, ?city=.
 *        Paginacao com limit/offset.
 * POST — cria um novo evento. Requer role manager.
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

const EVENT_TYPES = [
  "reuniao",
  "comicio",
  "caminhada",
  "carreata",
  "debate",
  "audiencia",
  "assembleia",
  "workshop",
  "live",
  "entrevista",
  "visita",
  "outro",
] as const;

const EVENT_STATUSES = [
  "scheduled",
  "confirmed",
  "in_progress",
  "completed",
  "cancelled",
  "postponed",
] as const;

const criarPolEventSchema = z.object({
  title: z.string().min(1).max(255),
  type: z.enum(EVENT_TYPES),
  theme: z.string().max(255).nullable().optional(),
  description: z.string().max(5000).nullable().optional(),
  city: z.string().max(120).nullable().optional(),
  state: z.string().length(2).nullable().optional(),
  neighborhood: z.string().max(120).nullable().optional(),
  venue: z.string().max(255).nullable().optional(),
  event_date: z.string().datetime(),
  event_end_date: z.string().datetime().nullable().optional(),
  estimated_audience: z.number().int().min(0).nullable().optional(),
  organizer_contact_id: z.string().uuid().nullable().optional(),
});

// -- GET — listar pol_events --------------------------------------------------

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authz = await requireRole("viewer", { requestId, resource: "pol_events" });
  if (!authz.ok) return authz.response;

  const { organizationId } = authz;
  const db = createAdminClient();
  const params = req.nextUrl.searchParams;

  let query = db
    .from("pol_events")
    .select("*")
    .eq("organization_id", organizationId)
    .order("event_date", { ascending: false });

  // Filtros opcionais
  const status = params.get("status");
  if (status) query = query.eq("status", status);

  const type = params.get("type");
  if (type) query = query.eq("type", type);

  const city = params.get("city");
  if (city) query = query.eq("city", city);

  // Paginacao simples
  const limit = Math.min(parseInt(params.get("limit") ?? "50", 10), 100);
  const offset = parseInt(params.get("offset") ?? "0", 10);
  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;

  if (error) {
    return fail("internal_error", "Erro ao buscar pol_events", 500, { requestId });
  }

  return ok(
    { pol_events: data ?? [] },
    {
      headers: { "x-request-id": requestId },
      meta: { total: count ?? (data?.length ?? 0), limit, offset },
    },
  );
}

// -- POST — criar pol_event ---------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "pol_events" });
  if (!authz.ok) return authz.response;

  const { organizationId, userId } = authz;

  const guardaSuporteWrite = await requireSupportWrite({ requestId, resource: "pol_events.create" });
  if (!guardaSuporteWrite.ok) return guardaSuporteWrite.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", "JSON invalido", 400, { requestId });
  }

  const parsed = criarPolEventSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_error", "Dados invalidos", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const db = createAdminClient();

  const { data: polEvent, error } = await db
    .from("pol_events")
    .insert({
      organization_id: organizationId,
      title: parsed.data.title,
      type: parsed.data.type,
      status: "scheduled" as const,
      theme: parsed.data.theme ?? null,
      description: parsed.data.description ?? null,
      city: parsed.data.city ?? null,
      state: parsed.data.state ?? null,
      neighborhood: parsed.data.neighborhood ?? null,
      venue: parsed.data.venue ?? null,
      event_date: parsed.data.event_date,
      event_end_date: parsed.data.event_end_date ?? null,
      estimated_audience: parsed.data.estimated_audience ?? null,
      organizer_contact_id: parsed.data.organizer_contact_id ?? null,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return fail("conflict", "Evento duplicado nesta organizacao", 409, { requestId });
    }
    return fail("internal_error", "Erro ao criar pol_event", 500, { requestId });
  }

  // Audit log
  db.from("api_audit_log").insert({
    organization_id: organizationId,
    user_id: userId,
    action: "pol_events.create",
    resource_type: "pol_events",
    resource_id: polEvent.id,
    request_id: requestId,
    metadata: { title: polEvent.title, type: polEvent.type },
  }).then(() => {});

  return ok({ pol_event: polEvent }, { status: 201, headers: { "x-request-id": requestId } });
}
