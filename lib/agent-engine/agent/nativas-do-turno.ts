/**
 * Quais nativas o turno oferece — capacidade do AGENTE, não default de env.
 *
 * `turnKnobsFromEnv` sempre preenche `followup` (janela de execução). Isso não
 * liga a ferramenta: o interruptor real é `ai_agent_versions.followup.enabled`.
 * Sem essa separação, a FAQ pagava o schema de follow-up, notas e funil mesmo
 * com tudo desligado na tela.
 */
export interface CapacidadeDoTurno {
  /** O ritual de abertura já serializou o contexto curado do lead. */
  contextoJaNaAbertura: boolean;
  /** Compaction rodou: o transcript integral saiu; reler o contexto é necessidade comprovada. */
  compactacaoRodou: boolean;
  /** `ai_agent_versions.followup.enabled === true` — nunca o knob de janela. */
  followupHabilitadoNoAgente: boolean;
  /** Janela de execução do follow-up (knob de env) está configurada. */
  janelaDeFollowupConfigurada: boolean;
  /** `handoff_tool_enabled` da versão. Detecção determinística de humano não depende disto. */
  handoffHabilitado: boolean;
  /** Há funil gravável (`pipeline_ids` não vazio) e a capacidade não foi entregue ao Operador. */
  funilGravavel: boolean;
  /** Notas duráveis utilizáveis neste turno (lead real, ou sandbox após compaction). */
  notasUtilizaveis: boolean;
  /** Há material de conhecimento para consultar. */
  conhecimentoDisponivel: boolean;
  /** `cases_enabled` da versão. */
  casosHabilitados: boolean;
}

/** Nativas cuja presença no request é decisão deste módulo. */
export const NATIVAS_CONDICIONAIS = [
  "get_lead_context",
  "schedule_followup",
  "request_human_handoff",
  "update_lead_state",
  "save_lead_note",
  "get_lead_note",
  "search_knowledge",
  "open_human_case",
  "provide_case_update",
] as const;

export type NativaCondicional = (typeof NATIVAS_CONDICIONAIS)[number];

/**
 * Lista determinística das nativas a montar. `send_message` entra sempre:
 * é o único jeito de responder. Template, skill reference e MCP ficam
 * nos filtros que já existiam no handler.
 */
export function nativasDoTurno(c: CapacidadeDoTurno): string[] {
  const nomes: string[] = ["send_message"];
  if (c.compactacaoRodou || !c.contextoJaNaAbertura) {
    nomes.push("get_lead_context");
  }
  if (c.followupHabilitadoNoAgente && c.janelaDeFollowupConfigurada) {
    nomes.push("schedule_followup");
  }
  if (c.handoffHabilitado) nomes.push("request_human_handoff");
  if (c.funilGravavel) nomes.push("update_lead_state");
  if (c.notasUtilizaveis) {
    nomes.push("save_lead_note", "get_lead_note");
  }
  if (c.conhecimentoDisponivel) nomes.push("search_knowledge");
  if (c.casosHabilitados) {
    nomes.push("open_human_case", "provide_case_update");
  }
  return nomes;
}

export function followupHabilitadoNaVersao(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object") return false;
  return (raw as { enabled?: unknown }).enabled === true;
}
