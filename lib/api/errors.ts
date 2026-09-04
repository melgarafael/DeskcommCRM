/**
 * Códigos de erro canônicos da API SonghaiCRM.
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
  unauthorized: "unauthorized", // segredo interno inválido/ausente (rotas host↔app, ex. system/agent)
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
  invalid_state: "invalid_state", // resposta a um agent_case que saiu de awaiting_human (spec 15 §7)
  tenant_already_exists: "tenant_already_exists",
  duplicate_external_id: "duplicate_external_id",
  event_gone: "event_gone", // resend de run cujo event_log original foi apagado (on delete set null)
  next_action_absent: "next_action_absent", // decisão sobre proposta que não existe (mais) [wave 4]
  next_action_changed: "next_action_changed", // o agente reescreveu a proposta entre o render e o clique
  channel_archived: "channel_archived", // ação sobre canal que o usuário excluiu (a linha só sobrevive como âncora das FKs)

  // 422 — semântica
  unprocessable_entity: "unprocessable_entity",
  channel_without_session: "channel_without_session", // operação de sessão (reiniciar, parear) pedida a canal que não tem sessão no transporte — o oficial
  invalid_state_transition: "invalid_state_transition",
  invalid_owner: "invalid_owner", // novo dono não é membro ativo agent+ da org (bulk assign, G3-04)
  trigger_kind_not_implemented: "trigger_kind_not_implemented", // publish de followup-flow com kind sem motor de enrollment (stage_change/conversation_end)

  // 415 — tipo de mídia
  unsupported_media_type: "unsupported_media_type",
  // SVG recusado como logo. Código PRÓPRIO e não o genérico acima porque a pessoa
  // que sobe um SVG fez a coisa mais natural do mundo (é o formato em que um
  // designer entrega logo) e precisa ler "mande PNG ou JPG", não "tipo de mídia
  // não suportado". A razão da recusa está em lib/branding/logo-arquivo.ts.
  logo_svg_recusado: "logo_svg_recusado",

  // 413
  payload_too_large: "payload_too_large",

  // 429
  rate_limited: "rate_limited",

  // 500 / upstream
  internal_error: "internal_error",
  upstream_unavailable: "upstream_unavailable",
  unavailable: "unavailable", // 503: dependência de config ausente (ex.: pool do engine sem SUPABASE_DB_URL)
  waha_error: "waha_error",
  ai_provider_error: "ai_provider_error",
} as const;

export type ApiErrorCode = (typeof ApiErrorCodes)[keyof typeof ApiErrorCodes];
