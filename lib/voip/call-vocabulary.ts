/**
 * Vocabulário de voice_calls (provider='sip') / phone_numbers — fonte da
 * verdade em TypeScript pro invariante
 * tests/invariants/vocabulario-banco-x-typescript.test.ts, que compara estes
 * unions contra os CHECK constraints reais do banco (migrations 0347/0337).
 * Mudar um valor aqui sem migration correspondente falha o teste; mudar o
 * CHECK sem atualizar aqui, idem.
 *
 * `voice_calls` é compartilhada com a chamada de voz por WhatsApp (WaCalls,
 * #628/#697) — só `direction`/`handled_by` são vocabulário nosso, 1:1 com o
 * banco. `status` NÃO é: o CHECK de `voice_calls.status`
 * (starting/ringing/connected/ended) é do binário WaCalls upstream, e não
 * está no invariante de vocabulário por isso. `CallStatus` abaixo é o
 * contrato da API (derivado de status+end_reason em
 * app/api/v1/calls/route.ts, função mapStatusParaApi), não uma coluna.
 */

export type CallDirection = "outbound" | "inbound";

/** Vocabulário da API (GET /api/v1/calls) — derivado, não é 1:1 com uma coluna. Ver mapStatusParaApi. */
export type CallStatus =
  | "ringing"
  | "in_progress"
  | "completed"
  | "no_answer"
  | "busy"
  | "failed"
  | "canceled";

export type CallHandledBy = "human" | "ai" | "ai_then_human";

export type PhoneNumberRoutingMode = "ai" | "human" | "ai_then_human";

export type AiAgentChannel = "whatsapp" | "voice";
