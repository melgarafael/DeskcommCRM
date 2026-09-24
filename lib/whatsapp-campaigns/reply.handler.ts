/**
 * message.received → processCampaignInboundReply (stop-on-reply + lead).
 * Não toca lib/waha/ingest.ts.
 */
import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";
import { processCampaignInboundReply } from "@/lib/whatsapp-campaigns/reply";

export const CAMPAIGN_REPLY_HANDLER_KEY = "whatsapp-campaign-reply.v1";

export const campaignReplyHandler: EventHandler = {
  key: CAMPAIGN_REPLY_HANDLER_KEY,
  events: ["message.received"],
  async handle(row): Promise<HandlerResult> {
    try {
      const admin = createAdminClient();
      const result = await processCampaignInboundReply(
        admin,
        row.organization_id,
        row.payload as {
          contact_id?: unknown;
          conversation_id?: unknown;
          message_id?: unknown;
          channel_session_id?: unknown;
        },
      );
      return {
        consumer_key: CAMPAIGN_REPLY_HANDLER_KEY,
        status: result.matched ? "ok" : "skipped",
        detail: result.detail,
      };
    } catch (err) {
      return {
        consumer_key: CAMPAIGN_REPLY_HANDLER_KEY,
        status: "error",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
