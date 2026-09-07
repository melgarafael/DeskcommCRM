import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH  /api/v1/automation-rules/[id] — atualiza campos (inclui is_active — switch da UI).
 * DELETE /api/v1/automation-rules/[id] — remove a regra.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail, noContent } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { autoriaDaMudanca } from "@/lib/operacao/autoria";
import { updateAutomationRuleSchema } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptRuleActionSecrets } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("manager", { requestId, resource: "automation_rules" });
  if (!authz.ok) return authz.response;
  const { user, org: activeOrg } = authz;

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = updateAutomationRuleSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("invalid_request", "Dados inválidos.", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const supabase = await createClient();
  const { data: existing, error: fetchErr } = await supabase
    .from("automation_rules")
    .select("id")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!existing) return fail("not_found", "Regra não encontrada.", 404, { requestId });

  // Secrets de call_webhook nunca ficam em claro no jsonb (migration 0041);
  // secret_enc existente (round-trip do editor) passa intacto.
  // A autoria vai junto de TODA escrita, pelo mesmo helper que o agente usa: uma
  // regra ligada é o estado mais perigoso do sistema, e a tela precisa dizer
  // quem a ligou (migration 0101).
  const patch: Record<string, unknown> = {
    ...parsed.data,
    updated_at: new Date().toISOString(),
    ...autoriaDaMudanca({ type: "user", id: user.id, role: activeOrg.role }),
  };
  if (parsed.data.actions !== undefined) {
    const safeActions = await encryptRuleActionSecrets(createAdminClient(), parsed.data.actions);
    if (safeActions === null) {
      return fail(
        "encryption_unavailable",
        "Não foi possível guardar o segredo do webhook com segurança: a chave de cifra desta instalação não está ativa. Quem administra o servidor resolve rodando o update.sh, que gera e ativa a chave.",
        422,
        { requestId },
      );
    }
    patch.actions = safeActions;
  }

  const { data: updated, error: updErr } = await supabase
    .from("automation_rules")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  const { actions: _actionsWithSecrets, ...auditableRule } = parsed.data;
  void audit({
    action: "automation.rule_updated",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "automation_rule",
    resourceId: id,
    requestId,
    // actions fora do audit: config de call_webhook carrega secret plaintext no input.
    metadata: { ...auditableRule, ...(parsed.data.actions !== undefined ? { actions_changed: true } : {}) },
  });

  return ok(updated, { requestId });
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("manager", { requestId, resource: "automation_rules" });
  if (!authz.ok) return authz.response;
  const { user, org: activeOrg } = authz;

  const supabase = await createClient();
  const { data: existing, error: fetchErr } = await supabase
    .from("automation_rules")
    .select("id")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!existing) return fail("not_found", "Regra não encontrada.", 404, { requestId });

  const { error: delErr } = await supabase.from("automation_rules").delete().eq("id", id);
  if (delErr) return fail("internal_error", delErr.message, 500, { requestId });

  void audit({
    action: "automation.rule_deleted",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "automation_rule",
    resourceId: id,
    requestId,
  });

  return noContent(requestId);
}
