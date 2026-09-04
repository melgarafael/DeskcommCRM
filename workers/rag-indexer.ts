/**
 * RAG indexer worker — consumes domain events and indexes content into
 * `ai_chunks` + `ai_knowledge_versions` for semantic retrieval.
 *
 * Events handled:
 *   - knowledge_source.updated  → reconstructs the tenant's active KB version
 *
 * Service-role caveat (CLAUDE.md §multi-tenancy): every query filters
 * `organization_id` from the trusted event row, never from user input.
 */

import { isEmbeddingProviderConfigured } from "@/lib/ai/gateway";
import { embedText } from "@/lib/ai/embed";
import { acquireDebounce } from "@/lib/ai/rag/debounce";
import { chunkText, computeContentHash } from "@/lib/ai/rag/chunker";
import { estimateTokens } from "@/lib/ai/runtime/history";
import {
  createKnowledgeVersion,
  markVersionReady,
  markVersionFailed,
  activateVersion,
} from "@/lib/ai/rag/version";
import type { EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";

const DEBOUNCE_TTL_SEC = 30;
const LAG_WARN_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SkipResult = { type: "skip"; reason: string };
type ErrorResult = { type: "error"; detail: string };
type OkResult = { type: "ok"; versionId: string; chunkCount: number };
type ProcessResult = SkipResult | ErrorResult | OkResult;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function skip(reason: string): SkipResult {
  return { type: "skip", reason };
}

/**
 * Loads the default active agent for the org.
 * Returns null when no agent is configured.
 */
async function resolveAgent(
  organizationId: string,
): Promise<{ id: string; active_kb_version_id: string | null } | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("ai_agents")
    .select("id, organization_id, active_kb_version_id, is_active, is_default")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!data) return null;
  return {
    id: (data as { id: string }).id,
    active_kb_version_id:
      (data as { active_kb_version_id: string | null }).active_kb_version_id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

/**
 * Reindexa a base de conhecimento do tenant (FAQ, política) — S-06.05/06/07.
 *
 * Decisão de arquitetura: **reconstrói UMA versão com TODAS as fontes**, em vez
 * de uma versão por fonte. A busca (`retrieve_top_k_chunks`) recebe um único
 * `kb_version_id`, e o agente aponta para uma única versão ativa
 * (`ai_agents.active_kb_version_id`). Se cada fonte criasse a própria versão,
 * ativar o FAQ desativaria o catálogo e vice-versa — o RAG degradaria em
 * silêncio, que é pior que não ter.
 *
 * Custo: re-embeddar tudo a cada mudança. Para a base de um tenant (dezenas de
 * itens) são centavos, e a alternativa incremental exigiria diferenciar chunk a
 * chunk. Caminho de evolução, quando a base crescer: reaproveitar os chunks
 * cujo `content_hash` não mudou da versão anterior.
 *
 * A versão só é ATIVADA depois de todos os chunks entrarem: se algo falhar no
 * meio, a versão anterior continua valendo e o agente segue respondendo com a
 * base antiga em vez de ficar sem base nenhuma.
 */
async function handleKnowledgeSourceUpdated(
  row: EventRow,
  agentId: string,
): Promise<ProcessResult> {
  const admin = createAdminClient();

  const { data: sourceRows, error: srcErr } = await admin
    .from("ai_knowledge_sources")
    .select("id, source_type, name")
    .eq("organization_id", row.organization_id)
    .eq("agent_id", agentId)
    .eq("status", "ready");
  if (srcErr) return { type: "error", detail: `sources_query_failed: ${srcErr.message}` };

  const sources = (sourceRows ?? []) as { id: string; source_type: string; name: string }[];
  if (sources.length === 0) return skip("no_sources");

  const { data: itemRows, error: itemErr } = await admin
    .from("ai_faq_items")
    .select("knowledge_source_id, question, answer, position")
    .eq("organization_id", row.organization_id)
    .in("knowledge_source_id", sources.map((s) => s.id))
    .order("position", { ascending: true });
  if (itemErr) return { type: "error", detail: `items_query_failed: ${itemErr.message}` };

  const items = (itemRows ?? []) as {
    knowledge_source_id: string;
    question: string;
    answer: string;
  }[];
  if (items.length === 0) return skip("no_content_to_index");

  // Um chunk por par pergunta/resposta: a unidade de recuperação é a resposta
  // inteira. `chunkText` só entra quando a resposta é longa demais para um
  // chunk — assim uma FAQ curta nunca é picada no meio.
  const porFonte = new Map(sources.map((s) => [s.id, s]));
  const pedacos: { content: string; sourceId: string; sourceType: string }[] = [];
  for (const it of items) {
    const fonte = porFonte.get(it.knowledge_source_id);
    if (!fonte) continue;
    const texto = `Pergunta: ${it.question}\nResposta: ${it.answer}`;
    for (const c of chunkText(texto)) {
      pedacos.push({ content: c, sourceId: fonte.id, sourceType: fonte.source_type });
    }
  }
  if (pedacos.length === 0) return skip("no_chunks_generated");

  const { versionId, versionNumber } = await createKnowledgeVersion({
    agentId,
    organizationId: row.organization_id,
    sourceType: "knowledge_source",
  });
  console.warn(
    `[rag-indexer] reconstruindo base: versão ${versionNumber} (${versionId}), ` +
      `${sources.length} fonte(s), ${pedacos.length} chunk(s)`,
  );

  let gravados = 0;
  const gravadosPorFonte = new Map<string, number>();
  for (let i = 0; i < pedacos.length; i++) {
    const p = pedacos[i]!;
    const contentHash = computeContentHash(p.content);
    let embedding: number[];
    try {
      const r = await embedText(p.content, { organizationId: row.organization_id });
      embedding = r.embedding;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await markVersionFailed(versionId, row.organization_id, `embed_failed@${i}: ${detail}`);
      return { type: "error", detail: `embed_failed at chunk ${i}: ${detail}` };
    }
    const { error: upErr } = await admin.from("ai_chunks").upsert(
      {
        organization_id: row.organization_id,
        kb_version_id: versionId,
        knowledge_source_id: p.sourceId,
        position: i,
        content: p.content,
        content_hash: contentHash,
        token_count: estimateTokens(p.content),
        embedding: embedding as unknown as string,
        metadata: { source_type: p.sourceType },
      },
      // Ver comentario no caminho de produto: esta e a constraint que existe.
      { onConflict: "knowledge_source_id,kb_version_id,position", ignoreDuplicates: true },
    );
    if (upErr) {
      console.warn(`[rag-indexer] chunk upsert error at ${i}:`, upErr.message);
    } else {
      gravados++;
      gravadosPorFonte.set(p.sourceId, (gravadosPorFonte.get(p.sourceId) ?? 0) + 1);
    }
  }

  // NUNCA ativar versão vazia. Se todos os chunks falharem, marcar 'ready' com
  // zero e ativar troca uma base que funcionava por uma base VAZIA — o agente
  // perde o RAG em silêncio, que é pior que a indexação ter falhado. Falhando
  // aqui, a versão anterior continua ativa.
  if (gravados === 0) {
    await markVersionFailed(versionId, row.organization_id, "nenhum chunk gravado");
    return { type: "error", detail: "no_chunks_written" };
  }

  await markVersionReady(versionId, row.organization_id, gravados);
  await activateVersion({ agentId, versionId, organizationId: row.organization_id });

  // Estado por fonte: a tela mostra "Chunks indexados" e a última indexação.
  const agora = new Date().toISOString();
  for (const s of sources) {
    // O que REALMENTE entrou, nao o que eu pretendia gravar: contar o planejado
    // fazia a tela anunciar "4 chunks indexados" com zero chunks no banco.
    const doFonte = gravadosPorFonte.get(s.id) ?? 0;
    await admin
      .from("ai_knowledge_sources")
      .update({
        last_index_status: doFonte > 0 ? "success" : "failed",
        last_index_error: doFonte > 0 ? null : "nenhum chunk foi gravado nesta indexação",
        last_indexed_at: agora,
        chunks_count: doFonte,
      })
      .eq("id", s.id)
      .eq("organization_id", row.organization_id);
  }

  return { type: "ok", versionId, chunkCount: gravados };
}

// ---------------------------------------------------------------------------
// Main processor — exported for handler adapter + unit tests
// ---------------------------------------------------------------------------

export async function processRagIndexer(row: EventRow): Promise<HandlerResult> {
  const consumerKey = "rag-indexer.v1";

  // Lag monitor (IA-11)
  const lagMs = Date.now() - new Date(row.payload["created_at"] as string ?? row.id).getTime();
  if (lagMs > LAG_WARN_MS) {
    console.warn(
      `[rag-indexer] lag exceeded 5min: ${Math.round(lagMs / 1000)}s for event ${row.id} (${row.event_type})`,
    );
  }

  // Guard: embedding provider must be configured.
  if (!isEmbeddingProviderConfigured()) {
    return { consumer_key: consumerKey, status: "skipped", detail: "openai_key_missing" };
  }

  // Resolve the active agent for this org.
  let agentId: string;
  try {
    const agent = await resolveAgent(row.organization_id);
    if (!agent) {
      return { consumer_key: consumerKey, status: "skipped", detail: "agent_inactive_or_missing" };
    }
    agentId = agent.id;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[rag-indexer] resolveAgent failed:", detail);
    return { consumer_key: consumerKey, status: "error", detail };
  }

  // Debounce key scoped to (org, agent, event_type) to coalesce bursts.
  const debounceKey = `rag:debounce:${row.organization_id}:${agentId}:${row.event_type}`;
  const acquired = await acquireDebounce(debounceKey, DEBOUNCE_TTL_SEC);
  if (!acquired) {
    return { consumer_key: consumerKey, status: "skipped", detail: "debounced" };
  }

  let versionId: string | undefined;

  try {
    let result: ProcessResult;

    switch (row.event_type) {
      case "knowledge_source.updated":
        result = await handleKnowledgeSourceUpdated(row, agentId);
        break;

      default:
        return { consumer_key: consumerKey, status: "skipped", detail: `unhandled_event:${row.event_type}` };
    }

    if (result.type === "skip") {
      return { consumer_key: consumerKey, status: "skipped", detail: result.reason };
    }

    if (result.type === "error") {
      if (versionId) {
        await markVersionFailed(versionId, row.organization_id, result.detail).catch(() => {
          // best-effort
        });
      }
      return { consumer_key: consumerKey, status: "error", detail: result.detail };
    }

    // type === "ok"
    versionId = result.versionId;
    return {
      consumer_key: consumerKey,
      status: "ok",
      detail: `version=${result.versionId} chunks=${result.chunkCount}`,
    };
  } catch (err) {
    // Global catch — worker must NOT throw.
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[rag-indexer] unhandled error:", detail);

    if (versionId) {
      await markVersionFailed(versionId, row.organization_id, detail).catch(() => {
        // best-effort
      });
    }

    return { consumer_key: consumerKey, status: "error", detail };
  }
}
