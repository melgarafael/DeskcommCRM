import { beforeAll, describe, expect, it } from "vitest";

import { indexExists, seedGov, tableExists } from "./gov-helpers";

/**
 * Eixo 4 — Roteamento/fila (spec 13 §1; fase que fecha: G5).
 * docs/specs/13-spec-governanca-atendimento.md — dor: "sem fila, sem horário
 * por atendente, sem modo configurável, sem painel". Modelo alvo na spec 13
 * §3/§5 (attendant_availability, organizations.settings.routing, worker via
 * event_log).
 */

beforeAll(() => {
  seedGov();
});

describe("eixo 4 — roteamento/fila", () => {
  it("base da fila de não-atribuídas existe: índice parcial idx_conversations_open_unassigned (spec 04 §8.3)", () => {
    expect(indexExists("idx_conversations_open_unassigned")).toBe(true);
  });

  // GAP(G5): sem disponibilidade/horário/capacidade por atendente — a tabela
  // attendant_availability (spec 13 §3: is_available, capacity, schedule
  // jsonb tz-aware) ainda não existe.
  it.fails("disponibilidade por atendente: tabela attendant_availability existe (spec 13 §3)", () => {
    expect(tableExists("attendant_availability")).toBe(true);
  });
});
