/**
 * Abre (ou reabre) a conversa 1:1 com um contato compartilhado no cartão do inbox.
 * Usa a mesma sessão de canal da mensagem onde o cartão apareceu.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ensureConversation, sessaoProntaParaEnvio } from "@/lib/automation/start-conversation";
import { encontrarContatoPorTelefone } from "@/lib/channels/contato-por-telefone";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { parseDialablePhone } from "@/lib/messaging/contact-card";

type Admin = SupabaseClient;

export interface OpenSharedContactInput {
  channel_session_id?: string;
  contact_id?: string;
  phone_number?: string;
  name?: string;
}

export interface OpenSharedContactResult {
  conversation_id: string;
  contact_id: string;
}

/**
 * Delega para `encontrarContatoPorTelefone` — ver o cabeçalho de
 * `escolherContatoCanonico`. Era cópia local com `.limit(1)` e sem `order by`.
 */
async function findContactByPhoneVariants(
  admin: Admin,
  orgId: string,
  rawPhone: string,
): Promise<{ id: string; phone_number: string } | null> {
  return encontrarContatoPorTelefone(admin as never, orgId, rawPhone);
}

async function resolveContactId(
  admin: Admin,
  orgId: string,
  input: OpenSharedContactInput,
): Promise<string> {
  if (input.contact_id) {
    const { data, error } = await admin
      .from("contacts")
      .select("id")
      .eq("organization_id", orgId)
      .eq("id", input.contact_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("contact_not_found");
    return (data as { id: string }).id;
  }

  const phone = input.phone_number ? parseDialablePhone(input.phone_number) : null;
  if (!phone) throw new Error("invalid_phone");
  const canonico = canonicalPhoneBR(phone);

  const existente = await findContactByPhoneVariants(admin, orgId, canonico);
  if (existente) return existente.id;

  const waid = canonico.replace(/\D/g, "");
  const { data: contactId, error: upsertErr } = await admin.rpc(
    "fn_upsert_wa_contact" as never,
    {
      p_org: orgId,
      p_kind: "phone",
      p_phone: canonico,
      p_lid: null,
      p_chat_id: waid,
      p_notify: input.name?.trim() || null,
    } as never,
  );
  if (upsertErr || !contactId) {
    throw new Error(upsertErr?.message ?? "contact_upsert_failed");
  }
  return contactId as string;
}

/** Garante contato + conversa na sessão indicada; reabre conversa fechada se existir. */
export async function openSharedContactConversation(
  admin: Admin,
  organizationId: string,
  input: OpenSharedContactInput,
  operator?: { client: SupabaseClient; userId: string },
): Promise<OpenSharedContactResult> {
  if (operator) {
    const { data: scoped, error } = await operator.client.rpc("fn_acl_scoped", { p_org: organizationId });
    if (error) throw new Error("access_scope_unavailable");
    if (scoped === true) return openManualContactConversation(admin, operator, organizationId, input);
  }
  const sessionId = input.channel_session_id ?? (await sessaoProntaParaEnvio(admin, organizationId));
  if (!sessionId) throw new Error("session_not_found");
  const { data: session, error: sessErr } = await admin
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("id", sessionId)
    .maybeSingle();
  if (sessErr) throw new Error(sessErr.message);
  if (!session) throw new Error("session_not_found");

  const contactId = await resolveContactId(admin, organizationId, input);
  // Abrir conversa com pessoal é escrita para fora da operação (spec 21, etapa
  // 12): o ponto único recusa — vale para a rota `open-with-contact` e para a
  // tool MCP, que passam por aqui. O `send` recusaria depois, mas a conversa
  // vazia já teria nascido.
  const { data: alvo, error: alvoErr } = await admin
    .from("contacts")
    .select("is_personal")
    .eq("organization_id", organizationId)
    .eq("id", contactId)
    .maybeSingle();
  if (alvoErr) throw new Error(alvoErr.message);
  if ((alvo as { is_personal?: boolean } | null)?.is_personal === true) {
    throw new Error("contact_personal");
  }
  const conversationId = await ensureConversation(
    admin,
    organizationId,
    contactId,
    sessionId,
  );
  return { conversation_id: conversationId, contact_id: contactId };
}

/** Human-only preflight: the session client enforces access; the RPC owns the atomic open. */
async function openManualContactConversation(
  admin: Admin,
  operator: { client: SupabaseClient; userId: string },
  org: string,
  input: OpenSharedContactInput,
): Promise<OpenSharedContactResult> {
  let channels = operator.client.from("channel_sessions").select("id")
    .eq("organization_id", org).eq("status", "WORKING").is("archived_at", null);
  if (input.channel_session_id) channels = channels.eq("id", input.channel_session_id);
  const { data: available, error: channelError } = await channels.limit(2);
  if (channelError) throw new Error("channel_lookup_failed");
  if (!available?.length) throw new Error("channel_forbidden");
  if (available.length !== 1) throw new Error("channel_selection_required");
  let contactId = input.contact_id;
  if (!contactId) {
    const phone = input.phone_number ? parseDialablePhone(input.phone_number) : null;
    if (!phone) throw new Error("invalid_phone");
    const canonical = canonicalPhoneBR(phone);
    // Existing hidden contact must be refused rather than duplicated/claimed.
    const existing = await findContactByPhoneVariants(admin, org, canonical);
    if (existing) contactId = existing.id;
    else {
      const { data, error } = await operator.client.from("contacts").insert({
        organization_id: org, phone_number: canonical, name: input.name?.trim() || null,
        created_by_user_id: operator.userId, source: "manual",
      }).select("id").single();
      if (error || !data) throw new Error("contact_create_failed");
      contactId = data.id as string;
    }
  }
  const { data: visible, error: contactError } = await operator.client.from("contacts").select("id")
    .eq("organization_id", org).eq("id", contactId).maybeSingle();
  if (contactError || !visible) throw new Error("contact_not_found");
  const { data, error } = await operator.client.rpc("fn_open_conversation_manual", {
    p_org: org, p_contact: contactId, p_channel: available[0]!.id,
  });
  if (error) {
    if (error.code === "42501") throw new Error("manual_open_forbidden");
    throw new Error("manual_open_failed");
  }
  return data as OpenSharedContactResult;
}
