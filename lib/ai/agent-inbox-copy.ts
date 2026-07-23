/**
 * Tradução leiga (pt-br) dos itens da inbox do runtime do agente (Operação
 * Visível F1). `kind` é contrato do engine (agent_inbox_items.kind, migration
 * 0050) — a central de avisos mostra o que aconteceu sem jargão.
 */

export type AgentInboxSeverity = "info" | "warn" | "critical";

export const KIND_LABEL: Record<string, string> = {
  qr_rescan: "Conexão do WhatsApp caiu — precisa escanear o QR de novo",
  job_dead: "Uma tarefa do assistente falhou e parou de tentar",
  event_dead: "Um evento recebido não pôde ser processado",
  budget_exceeded: "O orçamento de IA foi atingido",
  handoff: "O assistente passou um atendimento para um humano",
  promotion_review: "Proposta de melhoria do assistente aguardando sua revisão",
  judge_unaligned: "O avaliador de qualidade precisa de recalibragem",
  followup_dead: "Um fluxo de follow-up parou de tentar",
  snooze_expired: "O lead não respondeu no prazo que você definiu",
  other: "Aviso do assistente",
};

export const SEVERITY_LABEL: Record<AgentInboxSeverity, string> = {
  info: "informativo",
  warn: "atenção",
  critical: "crítico",
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? "Aviso do assistente";
}
