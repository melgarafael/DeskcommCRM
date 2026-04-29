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
  created_at: string;
  updated_at: string;
  last_activity_at: string | null;
}

/**
 * Polymorphic timeline item — surface from `crm_lead_activities`.
 * `source_module` is text (whatsapp | crm | nuvemshop | ai | system | ...).
 */
export interface TimelineItem {
  id: string;
  lead_id: string;
  contact_id: string | null;
  source_module: string;
  source_id: string | null;
  type: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  performed_at: string;
  performed_by_user_id: string | null;
}
