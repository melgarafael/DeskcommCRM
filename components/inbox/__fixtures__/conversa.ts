/**
 * Conversa mínima VÁLIDA para testar `ConversationListItem`.
 *
 * As props exigidas vêm do próprio componente (`components/inbox/ConversationListItem.tsx`),
 * não de suposição: `conversation` é `ConversationWithContact` (Conversation + contatos/canal
 * opcionais), e o resto são as props obrigatórias `isSelected` e `onSelect`. `props` carrega as
 * duas para quem só espalha `{...conversaDeExemplo.props}` no teste (ver a brief da Task 10).
 */
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

const conversation: ConversationWithContact = {
  id: "conv-1",
  organization_id: "org-1",
  contact_id: "contact-1",
  channel_session_id: "channel-1",
  channel: "whatsapp",
  status: "open",
  status_changed_at: "2026-09-08T12:00:00.000Z",
  service_revision: 1,
  service_closed_at: null,
  service_started_at: null,
  current_demanda_id: null,
  assigned_to_user_id: null,
  assigned_to_user_name: null,
  assignee_kind: null,
  assigned_at: null,
  last_inbound_at: "2026-09-08T12:00:00.000Z",
  awaiting_since: null,
  last_outbound_at: null,
  last_message_at: "2026-09-08T12:00:00.000Z",
  last_message_preview: "bom dia",
  unread_count_for_assignee: 0,
  is_group: false,
  group_chat_id: null,
  tags: [],
  metadata: {},
  snooze_until: null,
  created_at: "2026-09-08T12:00:00.000Z",
  updated_at: "2026-09-08T12:00:00.000Z",
  bot_silenced_until: null,
  last_handoff_at: null,
  comando_da_conversa: "aguardando",
  contacts: {
    id: "contact-1",
    display_name: "Maria",
    name: "Maria",
    phone_number: "+5521999990000",
    tags: [],
    is_blocked: false,
    is_anonymized: false,
  },
  channel_sessions: {
    phone_number: "+5521988880000",
    display_name: "WhatsApp",
    // Sem nomear o provider (doutrina restrição-de-canal) — o teste não
    // pergunta pela capacidade dele, um rótulo neutro basta.
    provider: "canal-de-teste",
  },
};

export const conversaDeExemplo = {
  conversation,
  props: {
    isSelected: false,
    onSelect: () => {},
  },
};
