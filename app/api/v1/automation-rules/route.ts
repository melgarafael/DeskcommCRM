/**
 * GET  /api/v1/automation-rules — lista as regras de automação da org ativa.
 * POST /api/v1/automation-rules — cria uma regra. is_active NUNCA aceito no
 *   create (schema não tem o campo) — regra nasce pausada (default FALSE do banco).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAutomationRuleSchema } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptRuleActionSecrets } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "automation_rules" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("automation_rules")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false });
  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "automation_rules" });
  if (!authz.ok) return authz.response;
  const { user, org: activeOrg } = authz;

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = createAutomationRuleSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("invalid_request", "Dados inválidos.", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  // Secrets de call_webhook nunca ficam em claro no jsonb (migration 0041).
  const safeActions = await encryptRuleActionSecrets(createAdminClient(), parsed.data.actions);
  if (safeActions === null) {
    return fail(
      "encryption_unavailable",
      "Não foi possível guardar o segredo do webhook com segurança. Configure NUVEMSHOP_OAUTH_ENCRYPTION_KEY e tente de novo — ou crie a ação sem segredo.",
      422,
      { requestId },
    );
  }

  const supabase = await createClient();
  const { data: created, error: insErr } = await supabase
    .from("automation_rules")
    .insert({
      organization_id: activeOrg.orgId,
      created_by_user_id: user.id,
      name: parsed.data.name,
      trigger_event: parsed.data.trigger_event,
      conditions: parsed.data.conditions,
      actions: safeActions,
    })
    .select("*")
    .single();
  if (insErr || !created) {
    return fail("internal_error", insErr?.message ?? "automation_rule_insert_failed", 500, { requestId });
  }

  void audit({
    action: "automation.rule_created",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "automation_rule",
    resourceId: created.id,
    requestId,
    metadata: { name: parsed.data.name, trigger_event: parsed.data.trigger_event },
  });

  return ok(created, { requestId, status: 201 });
}
