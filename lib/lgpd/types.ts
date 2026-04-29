/**
 * LGPD domain types for DeskcommCRM.
 * Mapped from docs/specs/01-spec-platform-base.md §8.1 and Spec 06 §5.6.
 */

export type LgpdRequestType = "customer_redact" | "customer_data_request" | "store_redact";

export type LgpdScope = "contact" | "tenant";

export type LgpdRequestStatus =
  | "received"
  | "processing"
  | "completed"
  | "failed"
  | "pending_review";

export interface LgpdRequest {
  id: string;
  organization_id: string;
  request_type: LgpdRequestType;
  /** Origin channel that triggered the request. */
  source: "nuvemshop" | "admin_panel" | "api";
  /** Internal contact id (may be null if contact not yet in CRM — L-03). */
  contact_id: string | null;
  /** Nuvemshop customer id or other external platform identifier. */
  external_customer_id: string | null;
  status: LgpdRequestStatus;
  attempts: number;
  received_at: string; // ISO 8601 UTC
  due_at: string; // ISO 8601 UTC
  completed_at: string | null;
  /** Raw webhook payload + context. PII stored here, never in audit log. */
  request_payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error_message: string | null;
  cascaded_to: Record<string, unknown> | null;
  /** Whether this request is high-priority (drives early SLA alarms). */
  emergency: boolean;
  /** Scope of the request: 'contact' (single customer) or 'tenant' (full store uninstall). */
  scope: LgpdScope;
  created_at: string;
  updated_at: string;
}
