import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH  /api/v1/webhook-sources/[id] — atualiza campos (inclui is_active — switch da UI).
 * DELETE /api/v1/webhook-sources/[id] — remove a fonte.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail, noContent } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { autoriaDaMudanca } from "@/lib/operacao/autoria";
import { updateWebhookSourceSchema } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("manager", { requestId, resource: "webhook_sources" });
  if (!authz.ok) return authz.response;
  const { user, org: activeOrg } = authz;

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = updateWebhookSourceSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("invalid_request", "Dados inválidos.", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const supabase = await createClient();
  const { data: existing, error: fetchErr } = await supabase
    .from("webhook_sources")
    .select("id")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!existing) return fail("not_found", "Fonte não encontrada.", 404, { requestId });

  // secret plaintext do input vira secret_encrypted (migration 0041); a coluna
  // em claro não existe mais. `secret: null` remove o segredo da fonte.
  const { secret: patchedSecret, ...restPatch } = parsed.data;
  // A autoria vai junto de TODA escrita, pelo mesmo helper que o agente usa: a
  // tela precisa distinguir o que ela mesma mudou do que o assistente mudou, e
  // duas contas de "quem mexeu" divergiriam no primeiro ajuste (migration 0101).
  const patch: Record<string, unknown> = {
    ...restPatch,
    updated_at: new Date().toISOString(),
    ...autoriaDaMudanca({ type: "user", id: user.id, role: activeOrg.role }),
  };
  if (patchedSecret !== undefined) {
    if (patchedSecret === null) {
      patch.secret_encrypted = null;
    } else {
      const enc = await encryptWebhookSecret(createAdminClient(), patchedSecret);
      if (enc === null) {
        return fail(
          "encryption_unavailable",
          "Não foi possível guardar o segredo com segurança: a chave de cifra desta instalação não está ativa. Quem administra o servidor resolve rodando o update.sh, que gera e ativa a chave.",
          422,
          { requestId },
        );
      }
      patch.secret_encrypted = enc;
    }
  }

  const { data: updated, error: updErr } = await supabase
    .from("webhook_sources")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  void audit({
    action: "webhook.source_updated",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "webhook_source",
    resourceId: id,
    requestId,
    // Nunca gravar o valor do secret no audit log — só o fato da troca.
    metadata: { ...restPatch, ...(patchedSecret !== undefined ? { secret_changed: true } : {}) },
  });

  const { secret_encrypted: encAfter, ...updatedPublic } = updated as Record<string, unknown>;
  return ok({ ...updatedPublic, has_secret: encAfter !== null }, { requestId });
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("manager", { requestId, resource: "webhook_sources" });
  if (!authz.ok) return authz.response;
  const { user, org: activeOrg } = authz;

  const supabase = await createClient();
  const { data: existing, error: fetchErr } = await supabase
    .from("webhook_sources")
    .select("id")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!existing) return fail("not_found", "Fonte não encontrada.", 404, { requestId });

  const { error: delErr } = await supabase.from("webhook_sources").delete().eq("id", id);
  if (delErr) return fail("internal_error", delErr.message, 500, { requestId });

  void audit({
    action: "webhook.source_deleted",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "webhook_source",
    resourceId: id,
    requestId,
  });

  return noContent(requestId);
}
