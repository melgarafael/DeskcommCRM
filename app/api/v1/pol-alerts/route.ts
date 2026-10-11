/**
 * GET|POST /api/v1/pol-alerts
 *
 * Alertas politicos — War Room 2.0 Fase 3.
 *
 * GET  — lista pol_alerts da organizacao. Aceita ?status=, ?alert_type=, ?severity=.
 *        Paginacao com limit/offset.
 * POST — cria um novo alerta. Requer role manager.
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

const ALERT_TYPES = [
  "sentiment",
  "engagement",
  "crisis",
  "opponent",
  "territory",
  "fake_news",
  "growth",
  "momentum",
  "media",
  "survey",
  "custom",
] as const;

const SEVERITIES = [
  "info",
  "low",
  "medium",
  "high",
  "critical",
] as const;

const ALERT_STATUSES = [
  "open",
  "acknowledged",
  "investigating",
  "resolved",
  "dismissed",
] as const;

const criarPolAlertSchema = z.object({
  alert_type: z.enum(ALERT_TYPES),
  severity: z.enum(SEVERITIES).default("medium"),
  source_type: z.string().max(120).nullable().optional(),
  source_id: z.string().uuid().nullable().optional(),
  title: z.string().min(1).max(255),
  description: z.string().max(5000).nullable().optional(),
});

// -- GET — listar pol_alerts --------------------------------------------------

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authz = await requireRole("viewer", { requestId, resource: "pol_alerts" });
  if (!authz.ok) return authz.response;

  const { organizationId } = authz;
  const db = createAdminClient();
  const params = req.nextUrl.searchParams;

  let query = db
    .from("pol_alerts")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  // Filtros opcionais
  const status = params.get("status");
  if (status) query = query.eq("status", status);

  const alertType = params.get("alert_type");
  if (alertType) query = query.eq("alert_type", alertType);

  const severity = params.get("severity");
  if (severity) query = query.eq("severity", severity);

  // Paginacao simples
  const limit = Math.min(parseInt(params.get("limit") ?? "50", 10), 100);
  const offset = parseInt(params.get("offset") ?? "0", 10);
  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;

  if (error) {
    return fail("internal_error", "Erro ao buscar pol_alerts", 500, { requestId });
  }

  return ok(
    { pol_alerts: data ?? [] },
    {
      headers: { "x-request-id": requestId },
      meta: { total: count ?? (data?.length ?? 0), limit, offset },
    },
  );
}

// -- POST — criar pol_alert ---------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "pol_alerts" });
  if (!authz.ok) return authz.response;

  const { organizationId, userId } = authz;

  const guardaSuporteWrite = await requireSupportWrite({ requestId, resource: "pol_alerts.create" });
  if (!guardaSuporteWrite.ok) return guardaSuporteWrite.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", "JSON invalido", 400, { requestId });
  }

  const parsed = criarPolAlertSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_error", "Dados invalidos", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const db = createAdminClient();

  const { data: alert, error } = await db
    .from("pol_alerts")
    .insert({
      organization_id: organizationId,
      alert_type: parsed.data.alert_type,
      severity: parsed.data.severity,
      status: "open" as const,
      source_type: parsed.data.source_type ?? null,
      source_id: parsed.data.source_id ?? null,
      title: parsed.data.title,
      description: parsed.data.description ?? null,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return fail("conflict", "Alerta duplicado nesta organizacao", 409, { requestId });
    }
    return fail("internal_error", "Erro ao criar pol_alert", 500, { requestId });
  }

  // Audit log
  db.from("api_audit_log").insert({
    organization_id: organizationId,
    user_id: userId,
    action: "pol_alerts.create",
    resource_type: "pol_alerts",
    resource_id: alert.id,
    request_id: requestId,
    metadata: { title: alert.title, alert_type: alert.alert_type, severity: alert.severity },
  }).then(() => {});

  return ok({ pol_alert: alert }, { status: 201, headers: { "x-request-id": requestId } });
}
