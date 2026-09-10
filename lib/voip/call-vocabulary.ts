/**
 * Vocabulário de crm_calls / phone_numbers — fonte da verdade em TypeScript
 * pro invariante tests/invariants/vocabulario-banco-x-typescript.test.ts,
 * que compara estes unions contra os CHECK constraints reais do banco
 * (migration 0232). Mudar um valor aqui sem migration correspondente falha
 * o teste; mudar o CHECK sem atualizar aqui, idem.
 */

export type CallDirection = "outbound" | "inbound";

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
