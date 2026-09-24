/**
 * Ação `assign_owner` — valida membership ativa na org (tabela
 * `user_organizations`, `revoked_at is null`, role acima de viewer — doutrina
 * G3-04: responsável tem que ser atendente ativo) e seta owner_user_id +
 * assigned_at do lead do contexto.
 *
 * A consulta de membro tem três respostas, não duas: é membro; não é membro
 * (`user_not_in_org`); e não deu para saber — a consulta falhou por rede/banco
 * (`membro_indeterminado`, falha transitória, com a mensagem da consulta em
 * `detail.erro` para o suporte). As duas últimas não se confundem: dizer
 * `user_not_in_org` quando a infraestrutura caiu manda o operador mexer no que
 * está certo.
 */
import { registerAction } from "@/lib/automation/actions";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import { resolveOwnerPatch } from "@/lib/leads/owner-patch";

async function execute(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  const userId = typeof config.user_id === "string" ? config.user_id : null;
  const lead = ctx.context.lead as { id: string } | undefined;
  if (!userId || !lead) return { type: "assign_owner", status: "skipped", detail: { reason: "missing_input" } };

  const { data: member, error: erroDaConsulta } = await ctx.admin
    .from("user_organizations")
    .select("user_id, role")
    .eq("organization_id", ctx.organizationId)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .maybeSingle();
  if (erroDaConsulta) {
    // A consulta de membro também pode NÃO VOLTAR (rede, banco fora). Isso não é
    // "não é membro": culpar a configuração do operador por uma queda de
    // infraestrutura manda ele mexer no que está certo. Falha fechada na ação,
    // aberta na informação — código transitório e a mensagem do erro.
    return {
      type: "assign_owner",
      status: "failed",
      error: "membro_indeterminado",
      detail: { reason: "membro_indeterminado", erro: erroDaConsulta.message },
    };
  }
  if (!member) return { type: "assign_owner", status: "failed", error: "user_not_in_org" };
  if (member.role === "viewer") {
    // Mesma régua do bulk-assign (G3-04 invalid_owner): viewer não atende.
    return { type: "assign_owner", status: "failed", error: "invalid_owner" };
  }

  const patchResult = resolveOwnerPatch({ owner_user_id: userId });
  if (!patchResult.ok || !patchResult.patch) {
    return { type: "assign_owner", status: "failed", error: "invalid_owner" };
  }

  const { error } = await ctx.admin
    .from("crm_leads")
    .update({
      ...patchResult.patch,
      assigned_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", lead.id)
    .eq("organization_id", ctx.organizationId);
  if (error) return { type: "assign_owner", status: "failed", error: error.message };
  return { type: "assign_owner", status: "success", detail: { user_id: userId } };
}

registerAction({ type: "assign_owner", execute });
