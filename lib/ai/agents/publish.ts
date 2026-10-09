/**
 * Publish wrapper around the SQL function fn_publish_ai_agent_version.
 * Spec 10 §4.5.
 *
 * Returns a discriminated result so the caller maps validation errors to 422
 * with a stable error code, and unknown errors to 500.
 */
import { chaveDePlataforma } from "@/lib/ai/runtime/agent";
import { audit } from "@/lib/audit";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PUBLISH_ERROR_CODES, type PublishErrorCode } from "./validation";

/**
 * Quem publicou (se houver). Os três caminhos HUMANOS de publicação passam o
 * actor/requestId; os caminhos automatizados (onboarding, primeira publicação,
 * proposta) publicam sem — e a auditoria da chave nova emite de todo jeito, com
 * ator nulo. Um registro sem ator é melhor que nenhum: a pergunta que ele
 * responde é "a chave mudou?", não "quem apertou o botão".
 */
export interface QuemPublicou {
  actorUserId?: string | null;
  actorApiTokenId?: string | null;
  requestId?: string | null;
}

export interface PublishOk {
  ok: true;
  agent_id: string;
  version_id: string;
  previous_version_id: string | null;
  published_at: string;
}

export interface PublishFail {
  ok: false;
  code: PublishErrorCode | "internal_error";
  message: string;
}

export type PublishResult = PublishOk | PublishFail;

interface PublishRow {
  agent_id: string;
  version_id: string;
  previous_version_id: string | null;
  published_at: string;
}

export async function publishAgentVersion(
  admin: SupabaseClient,
  params: { orgId: string; agentId: string; versionId: string; expectedProvenance?: "onboarding" | "legacy_reconciliation"; quemPublicou?: QuemPublicou },
): Promise<PublishResult> {
  const { data: version, error: readError } = await admin
    .from("ai_agent_versions")
    .select("provider,credential_id,handoff_legal_enabled")
    .eq("organization_id", params.orgId)
    .eq("agent_id", params.agentId)
    .eq("id", params.versionId)
    .maybeSingle();
  if (readError || !version)
    return { ok: false, code: "version_not_found", message: "version_not_found" };
  const platform = version.credential_id === null;
  if (platform && !chaveDePlataforma(version.provider))
    return { ok: false, code: "credential_missing", message: "credential_missing" };
  const { data, error } = await admin.rpc("fn_publish_ai_agent_version", {
    p_org_id: params.orgId,
    p_agent_id: params.agentId,
    p_version_id: params.versionId,
    ...(params.expectedProvenance ? { p_platform_credential_verified: platform, p_expected_provenance: params.expectedProvenance } : platform ? { p_platform_credential_verified: true } : {}),
  });

  if (error) {
    // Postgres P0001 with the reason as message.
    const raw = (error.message ?? "").trim();
    if (PUBLISH_ERROR_CODES.has(raw)) {
      return { ok: false, code: raw as PublishErrorCode, message: raw };
    }
    return { ok: false, code: "internal_error", message: raw || "publish_failed" };
  }

  const row = Array.isArray(data)
    ? (data[0] as PublishRow | undefined)
    : (data as PublishRow | null);
  if (!row) {
    return { ok: false, code: "internal_error", message: "no_row_returned" };
  }

  // #2156, seção 5 — um registro À PARTE do `ai_agent.published` que os
  // call sites já emitem: `ai_agent.legal_handoff_changed`, só quando a
  // publicação MUDA o valor da chave por assunto jurídico. Ponto único: os
  // três caminhos humanos (rota REST, salvar rascunho, reverter) e os
  // automatizados passam por aqui.
  void audarMudancaDeChaveJuridica(admin, {
    orgId: params.orgId,
    agentId: params.agentId,
    versionId: row.version_id,
    previousVersionId: row.previous_version_id,
    enabled: version.handoff_legal_enabled ?? true,
    quemPublicou: params.quemPublicou,
  });

  return {
    ok: true,
    agent_id: row.agent_id,
    version_id: row.version_id,
    previous_version_id: row.previous_version_id,
    published_at: row.published_at,
  };
}

/**
 * `ai_agent.legal_handoff_changed` — o registro À PARTE de `ai_agent.published`
 * que marca, sozinho, que a chave por ASSUNTO JURÍDICO do agente mudou
 * (#2156, seção 5 do desenho do mantenedor).
 *
 * Regras:
 * - emite SÓ quando a publicação muda o valor em relação à versão publicada
 *   anterior (mesmo valor → silêncio: publicar um rascunho que não mexeu na
 *   chave não é mudança de chave);
 * - SEM versão publicada anterior a referência é o PADRÃO da coluna
 *   (`true`, ligado) — assim o primeiro publish de um agente que já nasce com
 *   a chave desligada também audita, com `previous_version_id: null`;
 * - fire-and-forget, como os demais registros desta base: falha de auditoria
 *   nunca derruba a publicação que já aconteceu.
 */
export async function audarMudancaDeChaveJuridica(
  admin: SupabaseClient,
  params: {
    orgId: string;
    agentId: string;
    versionId: string;
    previousVersionId: string | null;
    enabled: boolean;
    quemPublicou?: QuemPublicou;
  },
): Promise<void> {
  let anterior = true; // padrão da coluna: ligado
  if (params.previousVersionId) {
    const { data } = await admin
      .from("ai_agent_versions")
      .select("handoff_legal_enabled")
      .eq("organization_id", params.orgId)
      .eq("id", params.previousVersionId)
      .maybeSingle();
    if (typeof data?.handoff_legal_enabled === "boolean") anterior = data.handoff_legal_enabled;
  }

  if (params.enabled === anterior) return;

  await audit({
    action: "ai_agent.legal_handoff_changed",
    actorUserId: params.quemPublicou?.actorUserId ?? null,
    actorApiTokenId: params.quemPublicou?.actorApiTokenId ?? null,
    organizationId: params.orgId,
    resourceType: "ai_agent",
    resourceId: params.agentId,
    requestId: params.quemPublicou?.requestId ?? null,
    metadata: {
      version_id: params.versionId,
      previous_version_id: params.previousVersionId,
      enabled: params.enabled,
    },
  });
}
