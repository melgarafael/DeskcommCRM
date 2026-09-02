/**
 * Conversations RAG ingestion (S-06.07, LGPD-critical L-08).
 *
 * Pipeline (per org, per batch run):
 *   1. List conversations where usable_for_rag=true AND status='resolved'
 *      AND usable_for_rag_marked_at > sinceTs
 *   2. For each conversation:
 *      a. Load messages (filtered by org_id), build "Cliente: ...\nAtendente: ..."
 *      b. Run anonymize() (NUIT / email / phone / CEP / PT-BR first names)
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
import { isEmbeddingProviderConfigured } from "@/lib/ai/gateway";
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
 * Returns the per-agent `conversations` knowledge source id, creating it on
 * first use. Required because ai_chunks.knowledge_source_id is NOT NULL.
 */
async function ensureConversationsSource(
  organizationId: string,
  agentId: string,
): Promise<string | null> {
  const admin = createAdminClient();

  const { data: existing } = await admin
    .from("ai_knowledge_sources")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("agent_id", agentId)
    .eq("source_type", "conversations")
    .maybeSingle();

  if (existing) return (existing as { id: string }).id;

  const { data: inserted, error } = await admin
    .from("ai_knowledge_sources")
    .insert({
      organization_id: organizationId,
      agent_id: agentId,
      source_type: "conversations",
      source_metadata: { auto_created: true, purpose: "conversation_history_rag" },
      is_active: true,
    })
    .select("id")
    .single();

  if (error || !inserted) {
    console.error(
      "[kb-conversations] failed to ensure conversations source",
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

  if (!isEmbeddingProviderConfigured()) {
    console.warn(
      "[kb-conversations] embedding provider missing; skipping batch for org",
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
      agentId,
      organizationId,
      sourceType: "conversations",
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
        const embedded = await embedText(content, { organizationId });
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
            source_type: "conversations",
            conversation_id: conv.id,
            anonymizer_hits: hits.length,
          },
        },
        {
          onConflict: "organization_id,kb_version_id,content_hash",
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
      await activateVersion({ agentId, versionId, organizationId });
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
