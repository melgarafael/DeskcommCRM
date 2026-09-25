import type { SupabaseClient } from "@supabase/supabase-js";
import {
  deriveLgpdFromContact,
  isLegalBasisValid,
} from "@/lib/agent-engine/guardrails/lgpd/legal-basis";
import { ProspectingError } from "./provider";

export interface ProspectingDelivery {
  organizationId: string;
  candidateId: string;
  conversationId: string;
}
export function contactMayBeProspected(contact: {
  is_blocked?: boolean;
  force_human?: boolean;
  is_anonymized: boolean;
  source: string | null;
  consent: Record<string, unknown> | null;
}) {
  const marketing = contact.consent?.marketing as { declined_at?: unknown } | undefined;
  return (
    !contact.is_blocked &&
    !contact.force_human &&
    !contact.is_anonymized &&
    !marketing?.declined_at &&
    isLegalBasisValid(deriveLgpdFromContact(contact, true).legalBasis)
  );
}
/** Rechecked after model generation and immediately before the provider effect. */
export async function assertProspectingDelivery(db: SupabaseClient, ctx: ProspectingDelivery) {
  const { data: candidate, error } = await db
    .from("prospecting_candidates")
    .select("campaign_id,contact_id,status,conversation_id")
    .eq("organization_id", ctx.organizationId)
    .eq("id", ctx.candidateId)
    .maybeSingle();
  if (
    error ||
    !candidate ||
    candidate.status !== "sending" ||
    candidate.conversation_id !== ctx.conversationId
  )
    // DO CANDIDATO: esta abordagem específica foi cancelada ou já não vale.
    throw new ProspectingError("Abordagem cancelada ou indisponível.", 409, "candidato");
  const [campaign, contact, conversation] = await Promise.all([
    db
      .from("prospecting_campaigns")
      .select("status")
      .eq("organization_id", ctx.organizationId)
      .eq("id", candidate.campaign_id)
      .maybeSingle(),
    db
      .from("contacts")
      .select("is_blocked,force_human,is_anonymized,source,consent")
      .eq("organization_id", ctx.organizationId)
      .eq("id", candidate.contact_id)
      .maybeSingle(),
    db
      .from("conversations")
      .select("status,last_inbound_at,last_outbound_at,assigned_to_user_id,bot_silenced_until")
      .eq("organization_id", ctx.organizationId)
      .eq("id", ctx.conversationId)
      .eq("contact_id", candidate.contact_id)
      .maybeSingle(),
  ]);
  if (
    campaign.error ||
    contact.error ||
    conversation.error ||
    campaign.data?.status !== "running" ||
    !contact.data ||
    !conversation.data
  )
    throw new ProspectingError("Campanha pausada ou dados indisponíveis.", 409);
  const c = conversation.data;
  if (
    !contactMayBeProspected(contact.data) ||
    c.last_inbound_at ||
    c.last_outbound_at ||
    c.assigned_to_user_id ||
    ["closed", "resolved", "archived", "claimed"].includes(c.status) ||
    c.bot_silenced_until === "infinity" ||
    (c.bot_silenced_until && Date.parse(c.bot_silenced_until) > Date.now())
  )
    throw new ProspectingError(
      "Contato já atendido, assumido por humano ou sem autorização para esta abordagem.",
      409,
    );
}
