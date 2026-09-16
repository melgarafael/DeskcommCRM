/**
 * Vocabulário e tipos do dado coletado por um fluxo de atendimento
 * (`public.contact_flow_data`, migration 0236).
 *
 * O par `CONTACT_FLOW_DATA_SOURCES` ↔ CHECK `contact_flow_data_source_conhecido`
 * é cobrado por `tests/invariants/vocabulario-banco-x-typescript.test.ts`: a
 * coluna tem CHECK de conjunto, então a lista nasce aqui no MESMO commit da
 * migration — a lição daquela lista é que todo par que divergiu nasceu sozinho.
 */

/** Procedência de um valor coletado. Espelha o CHECK de `contact_flow_data.source`. */
export const CONTACT_FLOW_DATA_SOURCES = ["client", "agent", "deterministic"] as const;
export type ContactFlowDataSource = (typeof CONTACT_FLOW_DATA_SOURCES)[number];

/**
 * O que aconteceu num turno do fluxo (`contact_flow_events.kind`). Espelha o
 * CHECK de `contact_flow_events_kind_conhecido` — par cobrado por
 * `tests/invariants/vocabulario-banco-x-typescript.test.ts`.
 */
export const CONTACT_FLOW_EVENT_KINDS = [
  "iniciado",
  "resposta",
  "fora_do_fluxo",
  "pergunta_feita",
  "concluido",
  "esgotado",
  "encadeou",
] as const;
export type ContactFlowEventKind = (typeof CONTACT_FLOW_EVENT_KINDS)[number];
