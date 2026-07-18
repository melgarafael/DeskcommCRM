/**
 * GET /api/v1/cron/attendant-heartbeat — AT-08 auto-offline.
 *
 * Marca `is_available=false` todo atendente online que não emite heartbeat há
 * mais que HEARTBEAT_TIMEOUT_MINUTES (defesa contra aba fechada sem beforeunload,
 * spec 04 §8.2). Trigger NUNCA faz HTTP — este é um cron TS que faz UPDATE via
 * admin client (varredura system-wide, não tenant-scoped). Mesmo contrato de auth
 * dos demais crons (Bearer INTERNAL_CRON_SECRET|INTERNAL_SECRET, fail-closed).
 *
 * O cutoff (now − timeout) e o predicado de "velho" são lógica pura em
 * lib/routing/eligibility.ts (isHeartbeatStale), testada com clock mockado — a
 * regra dos 15min é constante NOMEADA única, não número mágico espalhado.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { HEARTBEAT_TIMEOUT_MINUTES } from "@/lib/routing/eligibility";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authHeader = req.headers.get("authorization") ?? "";
  const provided = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const cutoff = new Date(Date.now() - HEARTBEAT_TIMEOUT_MINUTES * 60_000).toISOString();

  const supabaseAdmin = createAdminClient();
  const { data, error } = await supabaseAdmin
    .from("attendant_availability")
    .update({ is_available: false, updated_at: new Date().toISOString() })
    .eq("is_available", true)
    .or(`last_heartbeat_at.is.null,last_heartbeat_at.lt.${cutoff}`)
    .select("user_id");

  if (error) {
    console.error("[attendant-heartbeat] sweep failed", error.message);
    return fail("internal_error", "Failed to sweep stale heartbeats.", 500, { requestId });
  }

  const swept = data?.length ?? 0;
  void audit({
    action: "attendant.heartbeat_swept",
    requestId,
    bypassedRls: true,
    metadata: { swept, timeout_minutes: HEARTBEAT_TIMEOUT_MINUTES, cutoff },
  });

  return ok({ swept, cutoff }, { requestId });
}
