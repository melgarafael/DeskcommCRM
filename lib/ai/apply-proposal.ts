/**
 * Épico Operação Visível (F3) — aplicar uma proposta do flywheel como versão
 * nova do agente, pelo fluxo publish-por-ponteiro EXISTENTE (regras duras
 * 10/11): nada muda a versão publicada; cria-se uma versão nova (cópia da
 * publicada + bullet proposto no fim do system_prompt) e o ponteiro flipa via
 * fn_publish_ai_agent_version. O gate humano é o clique de aplicar — nada
 * auto-aplica; o rastro fica em applied_at/applied_version_id/applied_by (0053).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { versionPayloadFrom } from "@/lib/ai/agents/duplicate";
import { publishAgentVersion } from "@/lib/ai/agents/publish";

/** Bullet entra como seção datável no FIM do prompt — diff auditável, nunca rewrite. */
export function composeAppliedPrompt(basePrompt: string, bulletContent: string): string {
  const bullet = bulletContent.trim();
  return `${basePrompt.trimEnd()}\n\n## Aprendizado do flywheel\n- ${bullet}\n`;
}

export type ApplyProposalResult =
  | { ok: true; versionId: string; versionNumber: number }
  | { ok: true; entryId: string }
  | { ok: false; code: ApplyProposalErrorCode; message: string };

export type ApplyProposalErrorCode =
  | "proposal_not_found"
  | "proposal_already_applied"
  | "proposal_type_unsupported"
  | "agent_not_published"
  | "publish_failed"
  | "internal_error";

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
      message: "Proposta já foi aplicada.",
    };
  }
  if (proposal.type === "org_memory_entry") {
    const title =
      proposal.content.length > 80 ? `${proposal.content.slice(0, 77)}...` : proposal.content;
    const { data: entry, error: entryErr } = await admin
      .from("org_memory_entries")
      .insert({
        organization_id: orgId,
        title,
        body: proposal.content,
        source: "flywheel",
        status: "active",
        proposal_id: proposalId,
        created_by: userId,
      })
      .select("id")
      .single();
    if (entryErr || !entry) {
      return { ok: false, code: "internal_error", message: "Falha ao gravar a memória da org." };
    }
    const { error: markErr } = await admin
      .from("flywheel_distiller_proposals")
      .update({ applied_at: new Date().toISOString(), applied_by: userId })
      .eq("id", proposalId)
      .eq("organization_id", orgId);
    if (markErr) {
      return {
        ok: false,
        code: "internal_error",
        message: "Memória gravada, mas falhou ao marcar a proposta.",
      };
    }
    return { ok: true, entryId: entry.id };
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

  // Cópia INTEGRAL da linha publicada (`*`, sem lista de colunas à mão): o que
  // sai daqui é lido só por `versionPayloadFrom`, que escolhe o que a nova
  // versão leva. Lista escrita à mão aqui perdia 11 chaves de
  // `versionShapeSchema` (#2126) — e voltaria a perder na próxima coluna.
  const { data: base } = await admin
    .from("ai_agent_versions")
    .select("*")
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
      // Mesma cópia do duplicar: TODAS as chaves de conteúdo da versão publicada
      // vêm daqui. A lista escrita à mão que vivia neste INSERT deixava de fora
      // followup, operator_*, pipeline_ids, knowledge_source_ids, split_*,
      // inbound_debounce_ms, cases_enabled e proposal_ai_draft_enabled (#2126) —
      // a proposta era aplicada e a nova versão publicada voltava ao default do
      // banco naqueles onze campos.
      ...versionPayloadFrom(base),
      // Única chave da cópia que muda: o bullet proposto entra no fim do prompt.
      system_prompt: composeAppliedPrompt(base.system_prompt, proposal.content),
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
