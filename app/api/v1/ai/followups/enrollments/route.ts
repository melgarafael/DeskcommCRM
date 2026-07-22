/**
 * GET  /api/v1/ai/followups/enrollments — lista enrollments da org ativa
 *   (any member), filtro opcional `?status=`. A fila completa (com detalhe de
 *   nó/grafo) é a Onda 7; aqui é só o CRUD mínimo pro gatilho manual.
 * POST /api/v1/ai/followups/enrollments — enrollment manual (manager+):
 *   valida pointer ativo (status='active' + active_version_id) e contato da
 *   mesma org, resolve o nó `trigger` da version pinada e nasce nele com
 *   `next_eval_at=now` — o próximo tick do worker o pega imediatamente.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createFollowupEnrollmentSchema } from "@/lib/followup/api-schemas";
import { flowGraphSchema } from "@/lib/followup/graph-schema";

export const dynamic = "force-dynamic";

const LIST_COLUMNS =
  "id, pointer_id, contact_id, status, current_node_id, next_eval_at, outcome, started_at, completed_at, updated_at";
const ENROLLMENT_STATUSES = ["active", "waiting_reply", "paused_handoff", "completed", "cancelled", "dead"];

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "followup_enrollments" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const status = req.nextUrl.searchParams.get("status");
  if (status !== null && !ENROLLMENT_STATUSES.includes(status)) {
    return fail("invalid_request", "status inválido.", 400, { requestId });
  }

  const supabase = await createClient();
  let query = supabase
    .from("followup_enrollments")
    .select(LIST_COLUMNS)
    .eq("organization_id", activeOrg.orgId)
    .order("updated_at", { ascending: false });
  if (status !== null) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "followup_enrollments" });
  if (!authz.ok) return authz.response;
  const { user, org: activeOrg } = authz;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }

  const parsed = createFollowupEnrollmentSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const { pointer_id, contact_id } = parsed.data;

  const supabase = await createClient();

  const { data: pointer, error: pointerErr } = await supabase
    .from("followup_flow_pointers")
    .select("id, status, active_version_id")
    .eq("organization_id", activeOrg.orgId)
    .eq("id", pointer_id)
    .maybeSingle();
  if (pointerErr) return fail("internal_error", pointerErr.message, 500, { requestId });
  if (!pointer) return fail("not_found", "Fluxo não encontrado.", 404, { requestId });
  if (pointer.status !== "active" || !pointer.active_version_id) {
    return fail("flow_not_active", "Fluxo não está ativo (precisa estar publicado).", 422, { requestId });
  }

  const { data: contact, error: contactErr } = await supabase
    .from("contacts")
    .select("id")
    .eq("organization_id", activeOrg.orgId)
    .eq("id", contact_id)
    .maybeSingle();
  if (contactErr) return fail("internal_error", contactErr.message, 500, { requestId });
  if (!contact) return fail("not_found", "Contato não encontrado.", 404, { requestId });

  const { data: version, error: versionErr } = await supabase
    .from("followup_flow_versions")
    .select("graph")
    .eq("organization_id", activeOrg.orgId)
    .eq("id", pointer.active_version_id)
    .maybeSingle();
  if (versionErr) return fail("internal_error", versionErr.message, 500, { requestId });
  if (!version) return fail("internal_error", "Version ativa do fluxo não encontrada.", 500, { requestId });

  const graph = flowGraphSchema.parse(version.graph);
  const triggerNode = graph.nodes.find((n) => n.type === "trigger");
  if (!triggerNode) {
    return fail("internal_error", "Grafo publicado sem nó trigger.", 500, { requestId });
  }

  const now = new Date().toISOString();
  const { data: created, error: insErr } = await supabase
    .from("followup_enrollments")
    .insert({
      organization_id: activeOrg.orgId,
      pointer_id,
      version_id: pointer.active_version_id,
      contact_id,
      current_node_id: triggerNode.id,
      status: "active",
      next_eval_at: now,
    })
    .select(LIST_COLUMNS)
    .single();

  if (insErr || !created) {
    if (insErr?.code === "23505") {
      return fail("conflict", "Já existe um enrollment ativo deste fluxo para este contato.", 409, { requestId });
    }
    return fail("internal_error", insErr?.message ?? "followup_enrollment_insert_failed", 500, { requestId });
  }

  void audit({
    action: "followup_enrollment.created",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "followup_enrollment",
    resourceId: created.id,
    requestId,
    metadata: { pointer_id, contact_id, version_id: pointer.active_version_id },
  });

  return ok(created, { requestId, status: 201 });
}
