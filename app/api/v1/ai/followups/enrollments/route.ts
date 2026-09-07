import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/ai/followups/enrollments — lista enrollments da org ativa
 *   (any member), filtro opcional `?status=`.
 * POST /api/v1/ai/followups/enrollments — enrollment (manager+); lógica em
 *   `lib/followup/enroll.ts`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { createFollowupEnrollmentSchema } from "@/lib/followup/api-schemas";
import { ENROLLMENT_LIST_COLUMNS, enrollFollowupFlow } from "@/lib/followup/enroll";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const ENROLLMENT_STATUSES = [
  "active",
  "waiting_reply",
  "paused_handoff",
  "paused_manual",
  "completed",
  "cancelled",
  "dead",
];

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "followup_enrollments" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org: activeOrg } = authz;

  const status = req.nextUrl.searchParams.get("status");
  if (status !== null && !ENROLLMENT_STATUSES.includes(status)) {
    return fail("invalid_request", t("status inválido."), 400, { requestId });
  }

  const supabase = await createClient();
  let query = supabase
    .from("followup_enrollments")
    .select(ENROLLMENT_LIST_COLUMNS)
    .eq("organization_id", activeOrg.orgId)
    .order("updated_at", { ascending: false });
  if (status !== null) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "followup_enrollments" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org: activeOrg } = authz;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }

  const parsed = createFollowupEnrollmentSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const result = await enrollFollowupFlow(createAdminClient(), {
    organizationId: activeOrg.orgId,
    pointerId: parsed.data.pointer_id,
    contactId: parsed.data.contact_id,
    agentId: parsed.data.agent_id,
    actorUserId: user.id,
    requestId,
  });

  if (!result.ok) {
    return fail(result.code, result.message, result.status, { requestId });
  }
  return ok(result.enrollment, { requestId, status: 201 });
}
