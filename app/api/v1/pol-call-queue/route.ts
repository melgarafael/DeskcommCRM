/**
 * GET|POST /api/v1/pol-call-queue
 *
 * Fila de ligacoes politicas — War Room 2.0 Fase 3.
 *
 * GET  — lista pol_call_queue da organizacao. Aceita ?call_status=, ?assigned_to=, ?political_result=.
 *        Paginacao com limit/offset.
 * POST — cria um novo item na fila. Requer role manager.
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

const CALL_STATUSES = [
  "pending",
  "locked",
  "calling",
  "completed",
  "no_answer",
  "busy",
  "callback",
  "cancelled",
] as const;

const POLITICAL_RESULTS = [
  "apoio_confirmado",
  "indeciso",
  "recusa",
  "mudou_apoio",
  "sem_contato",
  "agendou_visita",
  "pediu_retorno",
  "outro",
] as const;

const criarPolCallQueueSchema = z.object({
  contact_id: z.string().uuid(),
  assigned_to: z.string().uuid().nullable().optional(),
  call_status: z.enum(CALL_STATUSES).default("pending"),
  priority: z.number().int().default(0),
  notes: z.string().max(2000).nullable().optional(),
});

// -- GET — listar pol_call_queue ----------------------------------------------

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authz = await requireRole("viewer", { requestId, resource: "pol_call_queue" });
  if (!authz.ok) return authz.response;

  const { organizationId } = authz;
  const db = createAdminClient();
  const params = req.nextUrl.searchParams;

  let query = db
    .from("pol_call_queue")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  // Filtros opcionais
  const callStatus = params.get("call_status");
  if (callStatus) query = query.eq("call_status", callStatus);

  const assignedTo = params.get("assigned_to");
  if (assignedTo) query = query.eq("assigned_to", assignedTo);

  const politicalResult = params.get("political_result");
  if (politicalResult) query = query.eq("political_result", politicalResult);

  // Paginacao simples
  const limit = Math.min(parseInt(params.get("limit") ?? "50", 10), 100);
  const offset = parseInt(params.get("offset") ?? "0", 10);
  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;

  if (error) {
    return fail("internal_error", "Erro ao buscar pol_call_queue", 500, { requestId });
  }

  return ok(
    { pol_call_queue: data ?? [] },
    {
      headers: { "x-request-id": requestId },
      meta: { total: count ?? (data?.length ?? 0), limit, offset },
    },
  );
}

// -- POST — criar item na fila ------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "pol_call_queue" });
  if (!authz.ok) return authz.response;

  const { organizationId, userId } = authz;

  const guardaSuporteWrite = await requireSupportWrite({ requestId, resource: "pol_call_queue.create" });
  if (!guardaSuporteWrite.ok) return guardaSuporteWrite.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", "JSON invalido", 400, { requestId });
  }

  const parsed = criarPolCallQueueSchema.safeParse(body);
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

  const { data: callItem, error } = await db
    .from("pol_call_queue")
    .insert({
      organization_id: organizationId,
      contact_id: parsed.data.contact_id,
      assigned_to: parsed.data.assigned_to ?? null,
      call_status: parsed.data.call_status,
      priority: parsed.data.priority,
      notes: parsed.data.notes ?? null,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return fail("conflict", "Este contato ja possui um registro na fila nesta organizacao", 409, {
        requestId,
      });
    }
    return fail("internal_error", "Erro ao criar item na fila", 500, { requestId });
  }

  // Audit log
  db.from("api_audit_log").insert({
    organization_id: organizationId,
    user_id: userId,
    action: "pol_call_queue.create",
    resource_type: "pol_call_queue",
    resource_id: callItem.id,
    request_id: requestId,
    metadata: { contact_id: callItem.contact_id, call_status: callItem.call_status },
  }).then(() => {});

  return ok({ pol_call_queue_item: callItem }, { status: 201, headers: { "x-request-id": requestId } });
}
