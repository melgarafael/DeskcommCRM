/**
 * Publish wrapper around fn_publish_rag_bot_version (migration 0168).
 *
 * O editor legado de `rag_bot` (`components/ai/AgentEditor.tsx`, "caminho
 * pré-EPIC-13") só grava o rascunho em `ai_agents` — o runtime lê
 * `system_prompt`/`provider`/`model` da versão publicada
 * (`ai_agents.published_version_id`), nunca do rascunho. Sem este wrapper (e a
 * rota que o chama), editar um `rag_bot` pela tela não tinha efeito nenhum.
 *
 * Não reusa `publishAgentVersion`/`fn_publish_ai_agent_version`: aquela função
 * exige `credential_id` não-nulo na versão e canal `WORKING` — nenhum dos dois
 * é como `rag_bot` opera.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const RAG_BOT_PUBLISH_ERROR_CODES = new Set([
  "agent_not_found",
  "agent_kind_invalid",
  "agent_archived",
  "no_existing_version",
  "version_not_found",
  "org_not_found",
  "model_not_found",
]);

export type RagBotPublishErrorCode =
  | "agent_not_found"
  | "agent_kind_invalid"
  | "agent_archived"
  | "no_existing_version"
  | "version_not_found"
  | "org_not_found"
  | "model_not_found";

export interface RagBotPublishOk {
  ok: true;
  agent_id: string;
  version_id: string;
  previous_version_id: string | null;
  published_at: string;
}

export interface RagBotPublishFail {
  ok: false;
  code: RagBotPublishErrorCode | "internal_error";
  message: string;
}

export type RagBotPublishResult = RagBotPublishOk | RagBotPublishFail;

interface PublishRow {
  agent_id: string;
  version_id: string;
  previous_version_id: string | null;
  published_at: string;
}

export async function publishRagBotVersion(
  admin: SupabaseClient,
  params: { orgId: string; agentId: string; createdBy: string | null },
): Promise<RagBotPublishResult> {
  const { data, error } = await admin.rpc("fn_publish_rag_bot_version", {
    p_org_id: params.orgId,
    p_agent_id: params.agentId,
    p_created_by: params.createdBy,
  });

  if (error) {
    // Postgres P0001 com a razão como mensagem — mesmo contrato de
    // fn_publish_ai_agent_version.
    const raw = (error.message ?? "").trim();
    if (RAG_BOT_PUBLISH_ERROR_CODES.has(raw)) {
      return { ok: false, code: raw as RagBotPublishErrorCode, message: raw };
    }
    // Erro não mapeado (constraint, FK, etc) — sem isto, o 500 chega ao
    // cliente sem nenhuma pista da causa nos logs do container.
    console.error("[publishRagBotVersion] fn_publish_rag_bot_version failed", {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });
    return { ok: false, code: "internal_error", message: raw || "publish_failed" };
  }

  const row = Array.isArray(data) ? (data[0] as PublishRow | undefined) : (data as PublishRow | null);
  if (!row) {
    console.error("[publishRagBotVersion] fn_publish_rag_bot_version returned no row");
    return { ok: false, code: "internal_error", message: "no_row_returned" };
  }
  return {
    ok: true,
    agent_id: row.agent_id,
    version_id: row.version_id,
    previous_version_id: row.previous_version_id,
    published_at: row.published_at,
  };
}
