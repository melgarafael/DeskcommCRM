/**
 * Conversations RAG ingestion (S-06.07, LGPD-critical L-08).
 *
 * Pipeline (per org, per batch run):
 *   1. List conversations where usable_for_rag=true AND status='resolved'
 *      AND usable_for_rag_marked_at > sinceTs
 *   2. For each conversation:
 *      a. Load messages (filtered by org_id), build "Cliente: ...\nAtendente: ..."
 *      b. Run anonymize() (CPF / email / phone / CEP / PT-BR first names)
 *      c. Validador false-negative: if msgs >= 10 and hits == 0 -> mark
 *         rag_review_status='pending_review' and SKIP ingest
 *      d. Chunk anonymized text
 *      e. Final PII leak guard on each chunk -> skip conversation if any hit
 *      f. Embed each chunk; insert into ai_chunks under a fresh
 *         ai_knowledge_versions row (one per batch run, status -> ready)
 *      g. Activate version when at least one chunk made it through
 *
 * Tenant isolation: every query filters organization_id from a trusted source
 * (function arg). Service role bypasses RLS so this MUST be explicit.
 */

import { embedText } from "@/lib/ai/embed";
import { aguardarVezDeEmbedding } from "@/lib/ai/embeddings/throttle";
import { resolverChaveDeEmbedding } from "@/lib/ai/embeddings/chave";
import { anonymize, detectResidualPii } from "@/lib/ai/anonymize";
import { chunkText, computeContentHash } from "@/lib/ai/rag/chunker";
import {
  activateVersion,
  createKnowledgeVersion,
  markVersionFailed,
  markVersionReady,
} from "@/lib/ai/rag/version";
import { createAdminClient } from "@/lib/supabase/admin";

const CONV_MAX_CHARS = 1600;
const CONV_OVERLAP_CHARS = 200;
const VALIDATOR_MIN_MSGS = 10;

export interface IngestConversationsArgs {
  organizationId: string;
  agentId: string;
  /** Only conversations marked after this timestamp are considered. */
  sinceTs: Date;
  /** Max conversations processed per call. Default 50. */
  cap?: number;
}

export interface IngestConversationsResult {
  processed: number;
  flaggedReview: number;
  skipped: number;
  embeddingSkipped: boolean;
}

/**
 * A fonte de conversas da ORGANIZAÇÃO, criada no primeiro lote.
 *
 * Era por AGENTE, e com o índice único `(agent_id, source_type)` isso dava uma
 * fonte de conversas por assistente — o mesmo acervo anonimizado indexado e pago
 * N vezes. Desde a 0181 o acervo é da organização e quem lê o quê é escolha da
 * versão publicada de cada agente.
 *
 * `maybeSingle` sobre a busca antiga estourava quando havia mais de uma linha
 * (duas ficavam ativas ao mesmo tempo se dois agentes rodassem o lote). Agora a
 * busca é ordenada e pega a primeira.
 */
async function ensureConversationsSource(
  organizationId: string,
  agentId: string,
): Promise<string | null> {
  const admin = createAdminClient();

  const { data: existentes } = await admin
    .from("ai_knowledge_sources")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("source_type", "conversas")
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1);

  const primeira = (existentes ?? [])[0] as { id: string } | undefined;
  if (primeira) return primeira.id;

  const { data: inserted, error } = await admin
    .from("ai_knowledge_sources")
    .insert({
      organization_id: organizationId,
      // Histórico: de qual assistente partiu o primeiro lote. Não é dono.
      agent_id: agentId,
      source_type: "conversas",
      name: "Conversas anteriores",
      status: "ready",
      source_metadata: { criada_automaticamente: true, origem: "conversas_anonimizadas" },
      is_active: true,
      ingested_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error || !inserted) {
    console.error(
      "[kb-conversations] não consegui criar a fonte de conversas",
      error?.message,
    );
    return null;
  }
  return (inserted as { id: string }).id;
}

interface ConvRow {
  id: string;
  organization_id: string;
}

interface MsgRow {
  body: string | null;
  direction: string;
  sent_at: string;
}

function buildTranscript(messages: MsgRow[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const body = (m.body ?? "").trim();
    if (!body) continue;
    const speaker = m.direction === "inbound" ? "Cliente" : "Atendente";
    lines.push(`${speaker}: ${body}`);
  }
  return lines.join("\n");
}

export async function ingestConversationsBatch(
  args: IngestConversationsArgs,
): Promise<IngestConversationsResult> {
  const { organizationId, agentId, sinceTs } = args;
  const cap = args.cap ?? 50;
  const admin = createAdminClient();

  // A chave é resolvida UMA vez por lote, e POR ORGANIZAÇÃO: a versão anterior
  // perguntava ao `process.env`, então uma organização que tivesse cadastrado a
  // chave pela tela era tratada como se não tivesse nenhuma.
  const chave = await resolverChaveDeEmbedding(organizationId, "embedding_indexar");
  if (!chave) {
    console.warn(
      "[kb-conversations] organização sem chave de embedding; lote adiado",
      organizationId,
    );
    return { processed: 0, flaggedReview: 0, skipped: 0, embeddingSkipped: true };
  }

  const sourceId = await ensureConversationsSource(organizationId, agentId);
  if (!sourceId) {
    return { processed: 0, flaggedReview: 0, skipped: 0, embeddingSkipped: false };
  }

  // 1. Pull eligible conversations.
  const { data: convRows, error: convErr } = await admin
    .from("conversations")
    .select("id, organization_id")
    .eq("organization_id", organizationId)
    .eq("usable_for_rag", true)
    .eq("status", "resolved")
    .gt("usable_for_rag_marked_at", sinceTs.toISOString())
    .is("rag_review_status", null)
    .limit(cap);

  if (convErr) {
    console.error("[kb-conversations] list query failed", convErr.message);
    return { processed: 0, flaggedReview: 0, skipped: 0, embeddingSkipped: false };
  }

  const conversations = (convRows ?? []) as ConvRow[];
  if (conversations.length === 0) {
    return { processed: 0, flaggedReview: 0, skipped: 0, embeddingSkipped: false };
  }

  // 2. Single batch version per run.
  let versionId: string | null = null;
  try {
    const v = await createKnowledgeVersion({
      organizationId,
      knowledgeSourceId: sourceId,
      agentId,
      sourceType: "conversas",
      embeddingModel: chave.model,
      embeddingDims: chave.dims,
    });
    versionId = v.versionId;
  } catch (err) {
    console.error(
      "[kb-conversations] createKnowledgeVersion failed",
      err instanceof Error ? err.message : String(err),
    );
    return { processed: 0, flaggedReview: 0, skipped: 0, embeddingSkipped: false };
  }

  let processed = 0;
  let flaggedReview = 0;
  let skipped = 0;
  let totalChunkInserts = 0;

  for (const conv of conversations) {
    // Defense in depth: re-check org id.
    if (conv.organization_id !== organizationId) {
      console.error(
        "[kb-conversations] org_id mismatch on conv",
        conv.id,
        "expected",
        organizationId,
      );
      skipped++;
      continue;
    }

    // a. Load messages (filter org).
    const { data: msgRows, error: msgErr } = await admin
      .from("messages")
      .select("body, direction, sent_at")
      .eq("organization_id", organizationId)
      .eq("conversation_id", conv.id)
      .order("sent_at", { ascending: true });

    if (msgErr) {
      console.warn(
        "[kb-conversations] messages query failed for conv",
        conv.id,
        msgErr.message,
      );
      skipped++;
      continue;
    }

    const msgs = (msgRows ?? []) as MsgRow[];
    const transcript = buildTranscript(msgs);
    if (!transcript) {
      skipped++;
      continue;
    }

    // b. Anonymize.
    const { anonymized, hits } = anonymize(transcript);

    // c. False-negative guard: long conversation with zero PII signal is
    //    suspicious -> route to manual review, do NOT ingest.
    if (msgs.length >= VALIDATOR_MIN_MSGS && hits.length === 0) {
      await admin
        .from("conversations")
        .update({ rag_review_status: "pending_review" })
        .eq("id", conv.id)
        .eq("organization_id", organizationId);
      flaggedReview++;
      continue;
    }

    // d. Chunk anonymized output.
    const chunks = chunkText(anonymized, {
      maxChars: CONV_MAX_CHARS,
      overlapChars: CONV_OVERLAP_CHARS,
    });

    if (chunks.length === 0) {
      skipped++;
      continue;
    }

    // e. Final leak guard.
    let leaked = false;
    for (const chunk of chunks) {
      const residual = detectResidualPii(chunk);
      if (residual) {
        console.error(
          `[kb-conversations] PII LEAK detected (${residual}) -- skipping conversation`,
          { conv_id: conv.id, organization_id: organizationId },
        );
        leaked = true;
        break;
      }
    }
    if (leaked) {
      await admin
        .from("conversations")
        .update({ rag_review_status: "skipped" })
        .eq("id", conv.id)
        .eq("organization_id", organizationId);
      skipped++;
      continue;
    }

    // f. Embed + insert.
    let convChunkInserts = 0;
    let convFailed = false;
    for (let i = 0; i < chunks.length; i++) {
      const content = chunks[i] ?? "";
      if (!content) continue;
      const contentHash = computeContentHash(content);

      let embedding: number[];
      try {
        // Ritmo global (C-064): o teto do plano gratuito do Google é 100/min e
        // cada trecho é uma requisição.
        await aguardarVezDeEmbedding();
        const embedded = await embedText(content, { organizationId, chave });
        embedding = embedded.embedding;
      } catch (err) {
        console.error(
          "[kb-conversations] embed failed for conv",
          conv.id,
          "chunk",
          i,
          err instanceof Error ? err.message : String(err),
        );
        convFailed = true;
        break;
      }

      const { error: upsertErr } = await admin.from("ai_chunks").upsert(
        {
          organization_id: organizationId,
          kb_version_id: versionId,
          knowledge_source_id: sourceId,
          position: totalChunkInserts + i,
          content,
          content_hash: contentHash,
          token_count: Math.ceil(content.length / 4),
          embedding: embedding as unknown as string,
          metadata: {
            source_type: "conversas",
            conversation_id: conv.id,
            anonymizer_hits: hits.length,
          },
        },
        {
          // A constraint que EXISTE é `ai_chunks_position_unique`
          // (knowledge_source_id, kb_version_id, position). O alvo antigo
          // (organization_id, kb_version_id, content_hash) NUNCA existiu, e o
          // Postgres respondia "there is no unique or exclusion constraint
          // matching the ON CONFLICT specification" — TODO chunk de conversa
          // falhava ao gravar, e a conversa era marcada 'ingested' assim mesmo.
          onConflict: "knowledge_source_id,kb_version_id,position",
          ignoreDuplicates: true,
        },
      );

      if (upsertErr) {
        console.warn(
          "[kb-conversations] chunk upsert error conv",
          conv.id,
          "pos",
          i,
          upsertErr.message,
        );
      } else {
        convChunkInserts++;
      }
    }

    if (convFailed) {
      skipped++;
      continue;
    }

    // `ingested` é IRREVERSÍVEL: o filtro do lote é `rag_review_status is null`,
    // então marcar sem ter gravado nada tira a conversa da fila para sempre. Era
    // exatamente o que acontecia — o upsert falhava em todos os trechos e a
    // marcação vinha assim mesmo.
    if (convChunkInserts === 0) {
      skipped++;
      continue;
    }

    totalChunkInserts += convChunkInserts;
    await admin
      .from("conversations")
      .update({ rag_review_status: "ingested" })
      .eq("id", conv.id)
      .eq("organization_id", organizationId);

    processed++;
  }

  // g. Finalize version.
  try {
    if (totalChunkInserts > 0) {
      await markVersionReady(versionId, organizationId, totalChunkInserts);
      await activateVersion({ organizationId, knowledgeSourceId: sourceId, versionId });
    } else {
      await markVersionFailed(versionId, organizationId, "no_chunks_ingested");
    }
  } catch (err) {
    console.error(
      "[kb-conversations] version finalize failed",
      err instanceof Error ? err.message : String(err),
    );
  }

  return { processed, flaggedReview, skipped, embeddingSkipped: false };
}
