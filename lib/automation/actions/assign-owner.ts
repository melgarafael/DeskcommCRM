/**
 * Ação `assign_owner` — valida membership ativa na org (tabela
 * `user_organizations`, `revoked_at is null`) e seta owner_user_id +
 * assigned_at do lead do contexto.
 */
import { registerAction } from "@/lib/automation/actions";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";

async function execute(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  const userId = typeof config.user_id === "string" ? config.user_id : null;
  const lead = ctx.context.lead as { id: string } | undefined;
  if (!userId || !lead) return { type: "assign_owner", status: "skipped", detail: { reason: "missing_input" } };

  const { data: member } = await ctx.admin
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", ctx.organizationId)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .maybeSingle();
  if (!member) return { type: "assign_owner", status: "failed", error: "user_not_in_org" };

  const { error } = await ctx.admin
    .from("crm_leads")
    .update({ owner_user_id: userId, assigned_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", lead.id)
    .eq("organization_id", ctx.organizationId);
  if (error) return { type: "assign_owner", status: "failed", error: error.message };
  return { type: "assign_owner", status: "success", detail: { user_id: userId } };
}

registerAction({ type: "assign_owner", execute });
