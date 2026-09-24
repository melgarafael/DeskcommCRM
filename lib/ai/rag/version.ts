/**
 * Ciclo de vida das versões de índice — agora POR FONTE (migration 0181).
 *
 * Antes, a versão era do AGENTE e havia uma ativa por agente. Duas rotinas
 * indexavam material diferente do mesmo agente e cada uma chamava
 * `activate_kb_version`, que DESATIVA as outras: a ingestão de conversas
 * derrubava a FAQ, o worker de FAQ derrubava as conversas, e quem indexou por
 * último apagava o acervo do outro em silêncio.
 *
 * Com a versão por fonte, a competição deixa de existir por construção. Ativar
 * o índice de um material não toca em nenhum outro.
 *
 * Todas as consultas usam o admin (service role) e filtram `organization_id`
 * explicitamente — service role bypassa RLS, então o isolamento é aqui.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { MODELO_DE_EMBEDDING, DIMENSOES_DO_EMBEDDING } from "@/lib/ai/embeddings/chave";

export interface CreateVersionParams {
  organizationId: string;
  /** A fonte que esta versão indexa. */
  knowledgeSourceId: string;
  /** Histórico: o agente a partir do qual a fonte nasceu (pode ser null). */
  agentId: string | null;
  sourceType: string;
  /**
   * Proveniência do embedding: o modelo/dimensão EFETIVAMENTE usados. A busca
   * casa por este valor (migration 0181) — gravar o default quando a indexação
   * usou outro provedor faria a busca recusar os próprios chunks. Ausente =
   * default OpenAI (compatível com quem não resolveu a chave antes).
   */
  embeddingModel?: string;
  embeddingDims?: number;
}

export interface CreateVersionResult {
  versionId: string;
  versionNumber: number;
}

/**
 * Cria uma `ai_knowledge_versions` em `status='building'` para UMA fonte.
 *
 * `version_number` é max+1 dentro da própria fonte — o número volta a significar
 * "a quantas indexações deste material" em vez de "quantas vezes esta
 * organização indexou qualquer coisa".
 */
export async function createKnowledgeVersion(
  params: CreateVersionParams,
): Promise<CreateVersionResult> {
  const admin = createAdminClient();

  const { data: maxRow, error: maxErr } = await admin
    .from("ai_knowledge_versions")
    .select("version_number")
    .eq("knowledge_source_id", params.knowledgeSourceId)
    .eq("organization_id", params.organizationId)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (maxErr) {
    throw new Error(`createKnowledgeVersion: query failed — ${maxErr.message}`);
  }

  const nextVersionNumber = ((maxRow?.version_number as number | null) ?? 0) + 1;

  const { data: inserted, error: insertErr } = await admin
    .from("ai_knowledge_versions")
    .insert({
      organization_id: params.organizationId,
      knowledge_source_id: params.knowledgeSourceId,
      agent_id: params.agentId,
      version_number: nextVersionNumber,
      description: `Indexação de ${params.sourceType}`,
      status: "building",
      is_active: false,
      // Proveniência: sem ela, "indexado com um modelo e consultado com outro"
      // é a falha que responde com trecho errado e nota alta.
      embedding_model: params.embeddingModel ?? MODELO_DE_EMBEDDING,
      embedding_dims: params.embeddingDims ?? DIMENSOES_DO_EMBEDDING,
    })
    .select("id, version_number")
    .single();

  if (insertErr || !inserted) {
    throw new Error(`createKnowledgeVersion: insert failed — ${insertErr?.message ?? "no row"}`);
  }

  return {
    versionId: (inserted as { id: string; version_number: number }).id,
    versionNumber: (inserted as { id: string; version_number: number }).version_number,
  };
}

/** Marca a versão como `ready` e grava `total_chunks` + `indexed_at`. */
export async function markVersionReady(
  versionId: string,
  organizationId: string,
  chunkCount: number,
): Promise<void> {
  const admin = createAdminClient();

  const { error } = await admin
    .from("ai_knowledge_versions")
    .update({
      status: "ready",
      total_chunks: chunkCount,
      indexed_at: new Date().toISOString(),
    })
    .eq("id", versionId)
    .eq("organization_id", organizationId);

  if (error) {
    throw new Error(`markVersionReady: update failed — ${error.message}`);
  }
}

/** Marca a versão como `failed` com o motivo por escrito. */
export async function markVersionFailed(
  versionId: string,
  organizationId: string,
  errorMessage: string,
): Promise<void> {
  const admin = createAdminClient();

  const { error } = await admin
    .from("ai_knowledge_versions")
    .update({ status: "failed", error_message: errorMessage })
    .eq("id", versionId)
    .eq("organization_id", organizationId);

  if (error) {
    throw new Error(`markVersionFailed: update failed — ${error.message}`);
  }
}

/**
 * Ativa a versão para a FONTE: aponta `ai_knowledge_sources.active_kb_version_id`
 * e desativa a anterior daquela fonte.
 *
 * Escrito em duas instruções e não numa RPC nova porque a única invariante que
 * o banco precisa garantir — uma ativa por fonte — já é o índice único
 * `ai_kbv_uma_ativa_por_fonte`. Desativar a anterior ANTES de ativar a nova é o
 * que impede o índice de recusar a troca.
 */
export async function activateVersion(params: {
  organizationId: string;
  knowledgeSourceId: string;
  versionId: string;
}): Promise<void> {
  const admin = createAdminClient();

  // Pré-checagem de tenant: o admin client bypassa RLS, então conferir aqui é
  // obrigatório e não paranoia.
  const { data: versionRow, error: checkErr } = await admin
    .from("ai_knowledge_versions")
    .select("id")
    .eq("id", params.versionId)
    .eq("knowledge_source_id", params.knowledgeSourceId)
    .eq("organization_id", params.organizationId)
    .maybeSingle();

  if (checkErr) {
    throw new Error(`activateVersion: pre-check failed — ${checkErr.message}`);
  }
  if (!versionRow) {
    throw new Error(
      `activateVersion: versão ${params.versionId} não pertence à fonte ${params.knowledgeSourceId}`,
    );
  }

  const { error: offErr } = await admin
    .from("ai_knowledge_versions")
    .update({ is_active: false })
    .eq("knowledge_source_id", params.knowledgeSourceId)
    .eq("organization_id", params.organizationId)
    .neq("id", params.versionId)
    .eq("is_active", true);

  if (offErr) {
    throw new Error(`activateVersion: desativar anterior falhou — ${offErr.message}`);
  }

  const { error: onErr } = await admin
    .from("ai_knowledge_versions")
    .update({ is_active: true, activated_at: new Date().toISOString() })
    .eq("id", params.versionId)
    .eq("organization_id", params.organizationId);

  if (onErr) {
    throw new Error(`activateVersion: ativar falhou — ${onErr.message}`);
  }

  const { error: ptrErr } = await admin
    .from("ai_knowledge_sources")
    .update({ active_kb_version_id: params.versionId })
    .eq("id", params.knowledgeSourceId)
    .eq("organization_id", params.organizationId);

  if (ptrErr) {
    throw new Error(`activateVersion: ponteiro da fonte falhou — ${ptrErr.message}`);
  }
}
