/**
 * Domain types for Contacts (EPIC-05).
 * Mirror the verified `contacts` schema (see CLAUDE.md / Spec 05).
 */
export interface Contact {
  id: string;
  organization_id: string;
  name: string | null;
  display_name: string | null;
  email: string | null;
  email_normalized: string | null;
  phone_number: string | null;
  cpf_hash: string | null;
  birthdate: string | null;
  is_blocked: boolean;
  blocked_reason: string | null;
  is_anonymized: boolean;
  anonymized_at: string | null;
  is_merged_into: string | null;
  merged_at: string | null;
  consent: Record<string, unknown>;
  tags: string[];
  source: string;
  source_metadata: Record<string, unknown>;
  custom_fields: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  last_activity_at: string | null;
  /**
   * Derivado (não é coluna): a conversa mais recente deste contato — atalho para o inbox.
   * Ausente é normal: contato criado à mão pode nunca ter conversado.
   */
  conversa?: {
    id: string;
    preview: string | null;
    last_message_at: string | null;
    unread: number;
  };
}

/**
 * Polymorphic timeline item — surface from `crm_lead_activities`.
 * `source_module` is text (whatsapp | crm | nuvemshop | ai | system | ...).
 */
export interface TimelineItem {
  id: string;
  /**
   * Declarado porque a rota SEMPRE pediu esta coluna. O tipo é que omitia — e
   * omissão em contrato de borda não é neutra: some do portão de exaustividade
   * e vira campo que ninguém sabe que existe.
   */
  organization_id: string;
  lead_id: string;
  contact_id: string | null;
  source_module: string;
  source_id: string | null;
  type: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  performed_at: string;
  performed_by_user_id: string | null;
  /** 0071 — quem agiu, por quê e com base em quê. */
  actor_kind?: string | null;
  actor_agent_id?: string | null;
  reason?: string | null;
  evidence?: Record<string, unknown> | null;
}

/**
 * A linha COM o ator resolvido para exibição.
 *
 * Tipo separado de propósito: `actor_agent_name` e `actor_user_name` NÃO são
 * colunas — são join feito na rota. Se morassem em `TimelineItem`, o portão de
 * exaustividade (TIMELINE_COL_LIST) exigiria pedi-los no SELECT e reprovaria
 * com razão. Coluna e derivado são coisas diferentes e o tipo diz qual é qual.
 */
export interface TimelineItemView extends TimelineItem {
  actor_agent_name?: string | null;
  actor_user_name?: string | null;
}
