/**
 * GET /api/v1/billing/subscription — plano e status de cobrança do tenant ativo.
 *
 * Admin-only (spec 13 §4, linha `billing`): dinheiro do tenant é assunto de
 * quem administra a organização, não de agent/manager. Em instalação
 * self-host (sem nenhuma linha em organization_subscriptions) devolve
 * `{ subscribed: false }` — não é erro, é o estado normal de quem nunca
 * assinou a Genesisia.
 */
import { randomUUID } from "node:crypto";

import { requireRole } from "@/lib/auth/require-role";
import { ok, fail } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET() {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "billing" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("organization_subscriptions")
    .select(
      "id, status, current_period_end, trial_ends_at, canceled_at, plan:billing_plans(id, code, name, description, price_cents, currency, billing_interval, features)",
    )
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();

  if (error) {
    return fail("internal_error", "Failed to load subscription", 500, { requestId });
  }

  if (!data) {
    return ok({ subscribed: false }, { requestId });
  }

  return ok({ subscribed: true, ...data }, { requestId });
}
