/**
 * Shapes canônicos das tabelas conversations e messages (Spec 03).
 * Espelha o schema do Postgres — atualizar aqui quando a migration mudar.
 */

export interface Conversation {
  id: string;
  organization_id: string;
  contact_id: string;
  channel_session_id: string;
  channel: string;
  status: string;
  status_changed_at: string;
  assigned_to_user_id: string | null;
  assignee_kind: string | null;
  assigned_at: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  unread_count_for_assignee: number;
  is_group: boolean;
  group_chat_id: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  snooze_until: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  organization_id: string;
  conversation_id: string;
  channel_session_id: string;
  contact_id: string;
  external_id: string | null;
  type: string;
  direction: "inbound" | "outbound";
  status: string;
  ack: number | null;
  error_code: string | null;
  error_message: string | null;
  body: string | null;
  media_url: string | null;
  media_mime: string | null;
  media_size_bytes: number | null;
  media_storage_path: string | null;
  sent_via: "user" | "ai" | "system";
  sent_by_user_id: string | null;
  sent_at: string;
  delivered_at: string | null;
  read_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

/**
 * Mapeia ack do WAHA (0..3) para o status canônico em messages.status.
 * 0=pending/sent server-side, 1=server-confirmed, 2=delivered (device), 3=read.
 */
export function ackToStatus(ack: number | null | undefined): Message["status"] {
  if (ack == null) return "sent";
  if (ack >= 3) return "read";
  if (ack >= 2) return "delivered";
  if (ack >= 1) return "sent";
  return "sending";
}
