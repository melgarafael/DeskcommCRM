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

export interface ProspectingContinuation {
  organizationId: string;
  candidateId: string;
  conversationId: string;
}
/**
 * A conferência LEVE das bolhas SEGUINTES da MESMA abordagem.
 *
 * Por que não `assertProspectingDelivery` de novo: ela recusa conversa com
 * `last_outbound_at` preenchido — e quem o preenche é o NOSSO PRÓPRIO envio da
 * primeira bolha (`app/api/v1/messages/_handler.ts`, o `conversationUpdate` do
 * fim do envio). Repetida na segunda bolha, ela recusa com 409 e, como o
 * `ProspectingError` é `campanha` por padrão, o tick PAUSA a campanha no
 * primeiro contato: a pessoa recebe só a primeira bolha — sem a saída — e o
 * `prospecting.approach_sent` não é auditado embora uma mensagem tenha saído.
 * Medido na revisão do PR #2680.
 *
 * O que continua valendo entre bolhas: se a pessoa RESPONDEU (inclusive
 * "PARAR"), se o contato virou bloqueado/sem base legal, ou se um humano
 * assumiu a conversa, a abordagem PARA. Mas para SÓ naquele candidato
 * (`escopo: "candidato"`): a campanha não tem defeito nenhum ali, e pausá-la
 * custaria a lista inteira por causa de uma pessoa que respondeu — que é,
 * aliás, o desfecho que a campanha procura.
 *
 * `last_outbound_at` fica DE FORA de propósito, e é a diferença inteira em
 * relação à guarda cheia: ele é a marca da nossa própria bolha anterior, não um
 * sinal de que a conversa deixou de ser fria.
 */
export async function assertProspectingContinuation(
  db: SupabaseClient,
  ctx: ProspectingContinuation,
) {
  const { data: candidate, error } = await db
    .from("prospecting_candidates")
    .select("contact_id,status,conversation_id")
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
  const [contact, conversation] = await Promise.all([
    db
      .from("contacts")
      .select("is_blocked,force_human,is_anonymized,source,consent")
      .eq("organization_id", ctx.organizationId)
      .eq("id", candidate.contact_id)
      .maybeSingle(),
    db
      .from("conversations")
      .select("status,last_inbound_at,assigned_to_user_id,bot_silenced_until")
      .eq("organization_id", ctx.organizationId)
      .eq("id", ctx.conversationId)
      .eq("contact_id", candidate.contact_id)
      .maybeSingle(),
  ]);
  if (contact.error || conversation.error || !contact.data || !conversation.data)
    // DO CANDIDATO: a guarda cheia já passou por este mesmo candidato instantes
    // antes da primeira bolha, então o que sobra aqui é a linha dele.
    throw new ProspectingError(
      "Contato indisponível para continuar a abordagem.",
      409,
      "candidato",
    );
  const c = conversation.data;
  if (
    !contactMayBeProspected(contact.data) ||
    c.last_inbound_at ||
    c.assigned_to_user_id ||
    ["closed", "resolved", "archived", "claimed"].includes(c.status) ||
    c.bot_silenced_until === "infinity" ||
    (c.bot_silenced_until && Date.parse(c.bot_silenced_until) > Date.now())
  )
    throw new ProspectingError(
      "A pessoa respondeu ou o atendimento foi assumido; a abordagem parou aqui.",
      409,
      "candidato",
    );
}
