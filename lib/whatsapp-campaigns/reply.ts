/**
 * Stop-on-reply + atribuição de campanha + lead on reply.
 *
 * Regra de atribuição (qual campanha recebe o reply):
 * 1. Se payload.message_id casa com recipient.message_id / outbound_message_id → essa.
 * 2. Senão, se conversation_id casa com conversation da mensagem outbound → essa.
 * 3. Senão, recipient mais recente do contact com status enviado/incerto/assumido
 *    (sent|delivered|read|assumed_sent|send_uncertain) nos últimos WINDOW_DAYS,
 *    ordenado por sent_at DESC NULLS LAST, created_at DESC.
 * Uma única campanha por inbound. Idempotente: se já replied, só aplica stop/lead se faltou.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { garantirLeadDaConversa } from "@/lib/leads/nascimento-do-lead";
import { logger } from "@/lib/logger";

export const REPLY_WINDOW_DAYS = 30;

export type ReplyStopMode = "none" | "person" | "company";

export interface InboundReplyPayload {
  contact_id?: unknown;
  conversation_id?: unknown;
  message_id?: unknown;
  channel_session_id?: unknown;
}

export interface ReplyProcessResult {
  matched: boolean;
  recipient_id: string | null;
  campaign_id: string | null;
  already_replied: boolean;
  skipped_others: number;
  lead_created: boolean;
  detail: string;
}

type RecipientRow = {
  id: string;
  campaign_id: string;
  contact_id: string;
  person_id: string | null;
  company_id: string | null;
  status: string;
  message_id: string | null;
  outbound_message_id: string | null;
  conversation_id?: string | null;
  sent_at: string | null;
  replied_at: string | null;
};

const REPLYABLE = [
  "sent",
  "delivered",
  "read",
  "assumed_sent",
  "send_uncertain",
  "replied",
] as const;

export function pickReplyStopReason(mode: ReplyStopMode): string {
  if (mode === "company") return "company_already_replied";
  return "person_already_replied";
}

export async function processCampaignInboundReply(
  admin: SupabaseClient,
  organizationId: string,
  payload: InboundReplyPayload,
): Promise<ReplyProcessResult> {
  const contactId = typeof payload.contact_id === "string" ? payload.contact_id : null;
  if (!contactId) {
    return empty("no_contact");
  }

  const messageId = typeof payload.message_id === "string" ? payload.message_id : null;
  const conversationId =
    typeof payload.conversation_id === "string" ? payload.conversation_id : null;

  const since = new Date(Date.now() - REPLY_WINDOW_DAYS * 86400_000).toISOString();

  let target = await findRecipientByOutboundMessage(admin, organizationId, contactId, messageId);
  if (!target && conversationId) {
    target = await findRecipientByConversation(
      admin,
      organizationId,
      contactId,
      conversationId,
      since,
    );
  }
  if (!target) {
    target = await findMostRecentReplyable(admin, organizationId, contactId, since);
  }
  if (!target) {
    return empty("no_recipient");
  }

  const { data: campaign } = await admin
    .from("whatsapp_campaigns")
    .select("id, reply_stop_mode, create_lead_on_reply, status")
    .eq("organization_id", organizationId)
    .eq("id", target.campaign_id)
    .maybeSingle();

  if (!campaign) {
    return empty("campaign_missing");
  }

  const already = target.status === "replied";
  if (!already) {
    const { data: updated, error } = await admin
      .from("whatsapp_campaign_recipients")
      .update({
        status: "replied",
        replied_at: new Date().toISOString(),
      })
      .eq("organization_id", organizationId)
      .eq("id", target.id)
      .in("status", [...REPLYABLE].filter((s) => s !== "replied"))
      .select("id")
      .maybeSingle();

    if (error) {
      return {
        matched: false,
        recipient_id: target.id,
        campaign_id: target.campaign_id,
        already_replied: false,
        skipped_others: 0,
        lead_created: false,
        detail: error.message,
      };
    }
    // Corrida: outro worker já marcou replied
    if (!updated && target.status !== "replied") {
      const { data: again } = await admin
        .from("whatsapp_campaign_recipients")
        .select("id, status")
        .eq("id", target.id)
        .eq("organization_id", organizationId)
        .maybeSingle();
      if (again?.status !== "replied") {
        return empty("update_race");
      }
    }
  }

  const mode = (campaign.reply_stop_mode as ReplyStopMode) || "person";
  let skipped = 0;
  if (mode !== "none") {
    skipped = await applyReplyStop(admin, {
      organizationId,
      campaignId: target.campaign_id,
      excludeRecipientId: target.id,
      personId: target.person_id,
      companyId: target.company_id,
      mode,
    });
  }

  // Opt-out: contact bloqueado → também skip pendentes do contact (sempre)
  skipped += await skipPendingForBlockedContact(admin, organizationId, contactId, target.campaign_id);

  let leadCreated = false;
  if (campaign.create_lead_on_reply) {
    leadCreated = await maybeCreateLeadOnReply(admin, {
      organizationId,
      contactId,
      conversationId,
      campaignId: target.campaign_id,
      recipientId: target.id,
    });
  }

  return {
    matched: true,
    recipient_id: target.id,
    campaign_id: target.campaign_id,
    already_replied: already,
    skipped_others: skipped,
    lead_created: leadCreated,
    detail: already ? "already_replied" : `replied mode=${mode} skipped=${skipped}`,
  };
}

function empty(detail: string): ReplyProcessResult {
  return {
    matched: false,
    recipient_id: null,
    campaign_id: null,
    already_replied: false,
    skipped_others: 0,
    lead_created: false,
    detail,
  };
}

async function findRecipientByOutboundMessage(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
  messageId: string | null,
): Promise<RecipientRow | null> {
  if (!messageId) return null;
  const { data } = await admin
    .from("whatsapp_campaign_recipients")
    .select(
      "id, campaign_id, contact_id, person_id, company_id, status, message_id, outbound_message_id, sent_at, replied_at",
    )
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .or(`message_id.eq.${messageId},outbound_message_id.eq.${messageId}`)
    .in("status", [...REPLYABLE])
    .order("sent_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  return (data as RecipientRow | null) ?? null;
}

async function findRecipientByConversation(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
  conversationId: string,
  since: string,
): Promise<RecipientRow | null> {
  // Liga via messages.conversation_id = inbound conversation
  const { data: msgs } = await admin
    .from("messages")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("conversation_id", conversationId)
    .eq("direction", "outbound")
    .order("created_at", { ascending: false })
    .limit(20);
  const ids = (msgs ?? []).map((m) => m.id as string);
  if (ids.length === 0) return null;

  const { data } = await admin
    .from("whatsapp_campaign_recipients")
    .select(
      "id, campaign_id, contact_id, person_id, company_id, status, message_id, outbound_message_id, sent_at, replied_at",
    )
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .in("message_id", ids)
    .in("status", [...REPLYABLE])
    .or(`sent_at.gte.${since},sent_at.is.null`)
    .order("sent_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  return (data as RecipientRow | null) ?? null;
}

async function findMostRecentReplyable(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
  since: string,
): Promise<RecipientRow | null> {
  const { data } = await admin
    .from("whatsapp_campaign_recipients")
    .select(
      "id, campaign_id, contact_id, person_id, company_id, status, message_id, outbound_message_id, sent_at, replied_at",
    )
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .in("status", [...REPLYABLE])
    .gte("sent_at", since)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as RecipientRow | null) ?? null;
}

export async function applyReplyStop(
  admin: SupabaseClient,
  opts: {
    organizationId: string;
    campaignId: string;
    excludeRecipientId: string;
    personId: string | null;
    companyId: string | null;
    mode: ReplyStopMode;
  },
): Promise<number> {
  if (opts.mode === "none") return 0;
  if (opts.mode === "person" && !opts.personId) return 0;
  if (opts.mode === "company" && !opts.companyId) return 0;

  let q = admin
    .from("whatsapp_campaign_recipients")
    .update({
      status: "skipped",
      skipped_reason: pickReplyStopReason(opts.mode),
      claimed_at: null,
      claimed_by: null,
    })
    .eq("organization_id", opts.organizationId)
    .eq("campaign_id", opts.campaignId)
    .neq("id", opts.excludeRecipientId)
    .in("status", ["pending", "scheduled"]);

  if (opts.mode === "person") {
    q = q.eq("person_id", opts.personId!);
  } else if (opts.mode === "company") {
    q = q.eq("company_id", opts.companyId!);
  }

  const { data, error } = await q.select("id");
  if (error) {
    logger.warn("campaign-reply: stop falhou", { error: error.message });
    return 0;
  }
  return data?.length ?? 0;
}

async function skipPendingForBlockedContact(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
  campaignId: string,
): Promise<number> {
  const { data: contact } = await admin
    .from("contacts")
    .select("is_blocked")
    .eq("organization_id", organizationId)
    .eq("id", contactId)
    .maybeSingle();
  if (!contact?.is_blocked) return 0;

  const { data } = await admin
    .from("whatsapp_campaign_recipients")
    .update({
      status: "skipped",
      skipped_reason: "opt_out",
      claimed_at: null,
      claimed_by: null,
    })
    .eq("organization_id", organizationId)
    .eq("campaign_id", campaignId)
    .eq("contact_id", contactId)
    .in("status", ["pending", "scheduled"])
    .select("id");
  return data?.length ?? 0;
}

async function maybeCreateLeadOnReply(
  admin: SupabaseClient,
  opts: {
    organizationId: string;
    contactId: string;
    conversationId: string | null;
    campaignId: string;
    recipientId: string;
  },
): Promise<boolean> {
  // Idempotência: já existe vínculo campanha → lead?
  const { data: existingLink } = await admin
    .from("crm_lead_links")
    .select("id, lead_id")
    .eq("organization_id", opts.organizationId)
    .eq("target_kind", "whatsapp_campaign")
    .eq("target_id", opts.campaignId)
    .eq("link_kind", "campaign_reply")
    .contains("metadata", { contact_id: opts.contactId })
    .maybeSingle();

  if (existingLink) return false;

  // Também: lead já linkado a este recipient
  const { data: byRecipient } = await admin
    .from("crm_lead_links")
    .select("id")
    .eq("organization_id", opts.organizationId)
    .eq("target_kind", "whatsapp_campaign_recipient")
    .eq("target_id", opts.recipientId)
    .limit(1)
    .maybeSingle();
  if (byRecipient) return false;

  const conversationId = opts.conversationId ?? `campaign:${opts.campaignId}`;
  const nasc = await garantirLeadDaConversa(admin, {
    organizationId: opts.organizationId,
    contactId: opts.contactId,
    conversationId,
    nomeDoContato: null,
  });

  let leadId: string | null = null;
  if (nasc.criado) {
    leadId = nasc.leadId;
  } else if (nasc.motivo === "ja_existe") {
    const { data: open } = await admin
      .from("crm_leads")
      .select("id")
      .eq("organization_id", opts.organizationId)
      .eq("contact_id", opts.contactId)
      .eq("status", "open")
      .limit(1)
      .maybeSingle();
    leadId = open?.id ?? null;
  }

  if (!leadId) return false;

  await admin.from("crm_lead_links").insert({
    organization_id: opts.organizationId,
    lead_id: leadId,
    target_kind: "whatsapp_campaign",
    target_id: opts.campaignId,
    link_kind: "campaign_reply",
    metadata: {
      contact_id: opts.contactId,
      recipient_id: opts.recipientId,
      source: "whatsapp_campaign_reply",
    },
  });

  await admin.from("crm_lead_links").insert({
    organization_id: opts.organizationId,
    lead_id: leadId,
    target_kind: "whatsapp_campaign_recipient",
    target_id: opts.recipientId,
    link_kind: "campaign_reply",
    metadata: { campaign_id: opts.campaignId },
  });

  return nasc.criado;
}
