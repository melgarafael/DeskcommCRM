import { serviceFromMessage } from "@/lib/atendimento/origem-mensagem";
/**
 * Handler: ai-handoff-from-sentiment.v1
 *
 * Consume `ai.sentiment_alert` (emitido por `ai-sentiment-worker` quando
 * sentiment_score < threshold) e dispara handoff via orquestrador central
 * com reason='low_sentiment' (gate G2 do EPIC-06).
 *
 * Service-role bypassa RLS → toda query filtra `organization_id` programático.
 */

import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { triggerHandoff } from "@/lib/ai/handoff/orchestrator";
import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";

export const AI_HANDOFF_FROM_SENTIMENT_KEY = "ai-handoff-from-sentiment.v1";

export const aiHandoffFromSentimentHandler: EventHandler = {
  key: AI_HANDOFF_FROM_SENTIMENT_KEY,
  events: ["ai.sentiment_alert"],
  async handle(row): Promise<HandlerResult> {
    const messageId =
      (row.payload?.["message_id"] as string | undefined) ?? row.entity_id ?? null;
    const conversationIdHint =
      (row.payload?.["conversation_id"] as string | undefined) ?? null;
    const sentimentScore =
      (row.payload?.["sentiment_score"] as number | undefined) ?? null;

    if (!messageId && !conversationIdHint) {
      return {
        consumer_key: AI_HANDOFF_FROM_SENTIMENT_KEY,
        status: "skipped",
        detail: "missing_ids",
      };
    }

    const admin = createAdminClient();

    const boundary = messageId ? await serviceFromMessage(admin, row.organization_id, messageId) : null;
    if (!boundary || (conversationIdHint && boundary.conversation_id !== conversationIdHint)) {
      return { consumer_key: AI_HANDOFF_FROM_SENTIMENT_KEY, status: "skipped", detail: "service_boundary_stale" };
    }
    const conversationId = boundary.conversation_id;
    const contactId = boundary.contact_id;

    // Best-effort: resolve the most recent open lead for this contact so the
    // orchestrator can write a timeline activity. If unavailable we still
    // proceed — handoff itself doesn't depend on having a lead.
    let leadId: string | null = null;
    if (contactId) {
      const { data: lead } = await admin
        .from("crm_leads")
        .select("id, organization_id, status, created_at")
        .eq("organization_id", row.organization_id)
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lead) leadId = (lead as { id: string }).id;
    }

    const result = await triggerHandoff({
      serviceBoundary: boundary,
      conversationId,
      organizationId: row.organization_id,
      reason: "low_sentiment",
      leadId,
      metadata: {
        sentiment_score: sentimentScore,
        message_id: messageId,
        source: "ai.sentiment_alert",
      },
    });

    if (!result.triggered) {
      logger.info("[ai-handoff-from-sentiment] handoff not triggered", {
        conversation_id: conversationId,
        reason: result.reason,
      });
      return {
        consumer_key: AI_HANDOFF_FROM_SENTIMENT_KEY,
        status: "skipped",
        detail: result.reason,
      };
    }

    return {
      consumer_key: AI_HANDOFF_FROM_SENTIMENT_KEY,
      status: "ok",
      detail: result.reason,
    };
  },
};
