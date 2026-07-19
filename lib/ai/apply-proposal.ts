/**
 * Épico Operação Visível (F3) — aplicar uma proposta do flywheel como versão
 * nova do agente, pelo fluxo publish-por-ponteiro EXISTENTE (regras duras
 * 10/11): nada muda a versão publicada; cria-se uma versão nova (cópia da
 * publicada + bullet proposto no fim do system_prompt) e o ponteiro flipa via
 * fn_publish_ai_agent_version. O gate humano é o clique de aplicar — nada
 * auto-aplica; o rastro fica em applied_at/applied_version_id/applied_by (0053).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { publishAgentVersion } from "@/lib/ai/agents/publish";

/** Bullet entra como seção datável no FIM do prompt — diff auditável, nunca rewrite. */
export function composeAppliedPrompt(basePrompt: string, bulletContent: string): string {
  const bullet = bulletContent.trim();
  return `${basePrompt.trimEnd()}\n\n## Aprendizado do flywheel\n- ${bullet}\n`;
}

export type ApplyProposalResult =
  | { ok: true; versionId: string; versionNumber: number }
  | { ok: false; code: ApplyProposalErrorCode; message: string };

export type ApplyProposalErrorCode =
  | "proposal_not_found"
  | "proposal_already_applied"
  | "proposal_type_unsupported"
  | "agent_not_published"
  | "publish_failed"
  | "internal_error";

/** Colunas copiadas da versão publicada para a nova (conteúdo imutável — cópia integral). */
const VERSION_COPY_COLUMNS =
  "id, version_number, system_prompt, provider, model, credential_id, tool_ids, trigger_config, channel_session_id, max_steps, token_budget, cost_budget_cents, history_message_window, history_token_window, handoff_keywords, handoff_tool_enabled";

export async function applyProposal(
  admin: SupabaseClient,
  params: { orgId: string; agentId: string; proposalId: string; userId: string },
): Promise<ApplyProposalResult> {
  const { orgId, agentId, proposalId, userId } = params;

  const { data: proposal } = await admin
    .from("flywheel_distiller_proposals")
    .select("id, type, content, applied_at")
    .eq("id", proposalId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!proposal) {
    return { ok: false, code: "proposal_not_found", message: "Proposta não encontrada." };
  }
  if (proposal.applied_at !== null) {
    return {
      ok: false,
      code: "proposal_already_applied",
      message: "Proposta já foi aplicada como versão nova.",
    };
  }
  if (proposal.type !== "playbook_bullet") {
    return {
      ok: false,
      code: "proposal_type_unsupported",
      message: `Aplicação automática só existe para playbook_bullet (esta é ${proposal.type}).`,
    };
  }

  const { data: agent } = await admin
    .from("ai_agents")
    .select("id, published_version_id")
    .eq("id", agentId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!agent?.published_version_id) {
    return {
      ok: false,
      code: "agent_not_published",
      message: "O agente precisa de uma versão publicada para receber a proposta.",
    };
  }

  const { data: base } = await admin
    .from("ai_agent_versions")
    .select(VERSION_COPY_COLUMNS)
    .eq("id", agent.published_version_id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!base) {
    return { ok: false, code: "internal_error", message: "Versão publicada não encontrada." };
  }

  const { data: maxRow } = await admin
    .from("ai_agent_versions")
    .select("version_number")
    .eq("agent_id", agentId)
    .eq("organization_id", orgId)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextNumber = (maxRow?.version_number ?? 0) + 1;

  const { data: created, error: insErr } = await admin
    .from("ai_agent_versions")
    .insert({
      organization_id: orgId,
      agent_id: agentId,
      version_number: nextNumber,
      system_prompt: composeAppliedPrompt(base.system_prompt, proposal.content),
      provider: base.provider,
      model: base.model,
      credential_id: base.credential_id,
      tool_ids: base.tool_ids,
      trigger_config: base.trigger_config ?? undefined,
      channel_session_id: base.channel_session_id,
      max_steps: base.max_steps,
      token_budget: base.token_budget,
      cost_budget_cents: base.cost_budget_cents,
      history_message_window: base.history_message_window,
      history_token_window: base.history_token_window,
      handoff_keywords: base.handoff_keywords,
      handoff_tool_enabled: base.handoff_tool_enabled,
      status: "draft",
      created_by: userId,
    })
    .select("id, version_number")
    .single();
  if (insErr || !created) {
    return { ok: false, code: "internal_error", message: "Falha ao criar a versão nova." };
  }

  const published = await publishAgentVersion(admin, {
    orgId,
    agentId,
    versionId: created.id,
  });
  if (!published.ok) {
    // Versão draft órfã fica como rastro inofensivo (draft nunca roda) — o
    // motivo real da falha (credencial revogada, sessão offline) volta ao operador.
    return {
      ok: false,
      code: "publish_failed",
      message: `Publicação vetada: ${published.code}. A proposta segue pendente.`,
    };
  }

  const { error: markErr } = await admin
    .from("flywheel_distiller_proposals")
    .update({
      applied_at: new Date().toISOString(),
      applied_version_id: created.id,
      applied_by: userId,
    })
    .eq("id", proposalId)
    .eq("organization_id", orgId)
    .is("applied_at", null);
  if (markErr) {
    return { ok: false, code: "internal_error", message: "Versão publicada, mas falhou ao marcar a proposta." };
  }

  return { ok: true, versionId: created.id, versionNumber: created.version_number };
}
