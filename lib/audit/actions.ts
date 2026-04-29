/**
 * Canonical audit action codes. Append new codes at the end; never rename.
 * Each code maps 1:1 with a row in api_audit_log.action.
 */
export type AuditAction =
  | "auth.login_success"
  | "auth.login_failed"
  | "auth.logout"
  | "auth.mfa_enrolled"
  | "auth.mfa_success"
  | "auth.mfa_failed"
  | "auth.recovery_code_used"
  | "nuvemshop.connected"
  | "nuvemshop.disconnected"
  | "nuvemshop.oauth_failed"
  | "nuvemshop.webhook_received"
  | "nuvemshop.webhook_invalid_signature"
  | "lead.created"
  | "lead.updated"
  | "lead.deleted"
  | "lead.moved"
  | "lead.won"
  | "lead.lost"
  | "lead.bulk_action"
  | "contact.created"
  | "contact.updated"
  | "contact.anonymized"
  | "contact.merge_pending"
  | "contact.merged"
  | "lgpd.anonymize_executed";
