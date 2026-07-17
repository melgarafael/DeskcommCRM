/**
 * GET  /api/v1/ai/budget — current budget snapshot for the active org (manager+).
 * PATCH /api/v1/ai/budget — admin-only mutation of monthly limit / threshold /
 *                           action_at_100pct.
 *
 * organization_id resolved from JWT via requireRole — never from body.
 * Service role used for the PATCH upsert; we filter by the trusted orgId.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { getBudgetStatus } from "@/lib/ai/budget/check";

export const dynamic = "force-dynamic";

const patchSchema = z
  .object({
    monthly_limit_cents: z.number().int().min(0).optional(),
    alarm_threshold_pct: z.number().int().min(1).max(100).optional(),
    action_at_100pct: z.enum(["throttle", "disable"]).optional(),
  })
  .refine(
    (v) =>
      v.monthly_limit_cents !== undefined ||
      v.alarm_threshold_pct !== undefined ||
      v.action_at_100pct !== undefined,
    { message: "At least one field is required." },
  );

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "ai_budget" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const status = await getBudgetStatus(activeOrg.orgId);
  return ok(status, { requestId });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "ai_budget" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("validation_failed", "JSON inválido.", 422, { requestId });
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_failed", "Payload inválido.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const admin = createAdminClient();

  // Upsert: ensure a row exists for this org.
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.monthly_limit_cents !== undefined) {
    patch.monthly_limit_cents = parsed.data.monthly_limit_cents;
  }
  if (parsed.data.alarm_threshold_pct !== undefined) {
    patch.alarm_threshold_pct = parsed.data.alarm_threshold_pct;
  }
  if (parsed.data.action_at_100pct !== undefined) {
    patch.action_at_100pct = parsed.data.action_at_100pct;
  }

  const { data: existing } = await admin
    .from("ai_budgets")
    .select("organization_id")
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (existing) {
    const { error: updErr } = await admin
      .from("ai_budgets")
      .update(patch)
      .eq("organization_id", activeOrg.orgId);
    if (updErr) {
      console.warn("[ai-budget] update failed", {
        orgId: activeOrg.orgId,
        error: updErr.message,
      });
      return fail("internal_error", "Erro ao atualizar orçamento.", 500, { requestId });
    }
  } else {
    const { error: insErr } = await admin.from("ai_budgets").insert({
      organization_id: activeOrg.orgId,
      ...patch,
    });
    if (insErr) {
      console.warn("[ai-budget] insert failed", {
        orgId: activeOrg.orgId,
        error: insErr.message,
      });
      return fail("internal_error", "Erro ao criar orçamento.", 500, { requestId });
    }
  }

  const status = await getBudgetStatus(activeOrg.orgId);
  return ok(status, { requestId });
}
