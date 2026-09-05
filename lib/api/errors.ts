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

  // ⚠️ AGENDA — declarados AQUI, e não no `fail()`, porque `fail()` NÃO protege.
  //
  // A assinatura é `code: ApiErrorCode | (string & {})`, e o segundo ramo aceita
  // qualquer string: um `"slot_taken"` inventado no call site vira contrato de
  // wire sem passar por lista nenhuma, e o consumidor do outro lado nunca sabe
  // que ele existe. Quem confia que a união protege está lendo o arquivo errado.
  agenda_horario_indisponivel: "agenda_horario_indisponivel",
  agenda_fora_da_jornada: "agenda_fora_da_jornada",
  agenda_tipo_desativado: "agenda_tipo_desativado",
  agenda_sem_responsavel: "agenda_sem_responsavel",
  agenda_disponibilidade_invalida: "agenda_disponibilidade_invalida",
  agenda_ja_cancelado: "agenda_ja_cancelado",
  agenda_listagem_sem_recorte: "agenda_listagem_sem_recorte",

  // 409 — conflito
  idempotency_conflict: "idempotency_conflict",
  state_conflict: "state_conflict",
  invalid_state: "invalid_state", // resposta a um agent_case que saiu de awaiting_human (spec 15 §7)
  tenant_already_exists: "tenant_already_exists",
  duplicate_external_id: "duplicate_external_id",
  event_gone: "event_gone", // resend de run cujo event_log original foi apagado (on delete set null)
  no_actions_to_resend: "no_actions_to_resend", // resend de regra que não tem mais nenhuma ação de webhook — reenviar nada não é sucesso
  next_action_absent: "next_action_absent", // decisão sobre proposta que não existe (mais) [wave 4]
  next_action_changed: "next_action_changed", // o agente reescreveu a proposta entre o render e o clique
  channel_archived: "channel_archived", // ação sobre canal que o usuário excluiu (a linha só sobrevive como âncora das FKs)
  knowledge_source_type_in_use: "knowledge_source_type_in_use", // já existe fonte ATIVA daquele tipo para o agente (índice ai_knowledge_sources_unique_per_agent)

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

  // ─── ANÚNCIOS, eixo de LEITURA (0214) ───
  //
  // Declarados aqui pelo mesmo motivo que os da Agenda: `fail()` aceita
  // `(string & {})`, então um código inventado no call site vira contrato de
  // wire sem passar por lista nenhuma. E estes precisam ser distinguíveis pelo
  // cliente — a tela mostra uma frase DIFERENTE para cada um, porque cada um
  // pede uma ação diferente de quem lê (colar token novo, refazer o token com
  // `ads_read`, esperar a cota, ou avisar quem mantém o sistema).
  ads_sem_conexao: "ads_sem_conexao",
  ads_token_invalido: "ads_token_invalido",
  ads_permissao_insuficiente: "ads_permissao_insuficiente",
  ads_limite_de_chamadas: "ads_limite_de_chamadas",
  ads_campo_invalido: "ads_campo_invalido",
  ads_cifra_indisponivel: "ads_cifra_indisponivel",

  // 500 / upstream
  internal_error: "internal_error",
  upstream_unavailable: "upstream_unavailable",
  unavailable: "unavailable", // 503: dependência de config ausente (ex.: pool do engine sem SUPABASE_DB_URL)
  waha_error: "waha_error",
  ai_provider_error: "ai_provider_error",
  nuvemshop_error: "nuvemshop_error",
} as const;

export type ApiErrorCode = (typeof ApiErrorCodes)[keyof typeof ApiErrorCodes];
