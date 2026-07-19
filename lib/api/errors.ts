/**
 * Códigos de erro canônicos da API DeskcommCRM.
 *
 * Adicionar novo código:
 *  1. Adicionar à enum/constante abaixo
 *  2. Documentar em docs/specs/<spec>.md
 *  3. Sem renomear código existente — versionar em /api/v2/ se precisar quebrar
 */

export const ApiErrorCodes = {
  // 400 — body / params
  invalid_request: "invalid_request",
  validation_failed: "validation_failed", // Zod retornou erros de schema (422 também aceita)
  invalid_cursor: "invalid_cursor",

  // 401 — auth
  unauthenticated: "unauthenticated",
  token_expired: "token_expired",
  token_revoked: "token_revoked",
  invalid_credentials: "invalid_credentials",
  mfa_required: "mfa_required",
  auth_in_query_forbidden: "auth_in_query_forbidden",

  // 403 — authz
  forbidden: "forbidden",
  forbidden_role: "forbidden_role",
  forbidden_tenant: "forbidden_tenant",
  lgpd_anonymization_irreversible: "lgpd_anonymization_irreversible",

  // 404
  not_found: "not_found",

  // 409 — conflito
  idempotency_conflict: "idempotency_conflict",
  state_conflict: "state_conflict",
  tenant_already_exists: "tenant_already_exists",
  duplicate_external_id: "duplicate_external_id",
  event_gone: "event_gone", // resend de run cujo event_log original foi apagado (on delete set null)

  // 422 — semântica
  unprocessable_entity: "unprocessable_entity",
  invalid_state_transition: "invalid_state_transition",
  invalid_owner: "invalid_owner", // novo dono não é membro ativo agent+ da org (bulk assign, G3-04)

  // 429
  rate_limited: "rate_limited",

  // 500 / upstream
  internal_error: "internal_error",
  upstream_unavailable: "upstream_unavailable",
  waha_error: "waha_error",
  ai_provider_error: "ai_provider_error",
  nuvemshop_error: "nuvemshop_error",
} as const;

export type ApiErrorCode = (typeof ApiErrorCodes)[keyof typeof ApiErrorCodes];
