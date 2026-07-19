import { beforeAll, describe, expect, it } from "vitest";

import {
  columnExists,
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_MANAGER,
  GOV_ORG,
  indexExists,
  seedGov,
  tableExists,
  writeCountAs,
} from "./gov-helpers";

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

  // G5-01: disponibilidade/horário/capacidade por atendente.
  it("disponibilidade por atendente: tabela attendant_availability existe (spec 13 §3)", () => {
    expect(tableExists("attendant_availability")).toBe(true);
  });

  // Shape que a elegibilidade (§5: disponível ∧ horário ∧ capacidade) e o
  // heartbeat AT-08 consomem: is_available, capacity, schedule tz-aware,
  // last_heartbeat_at + índice parcial de varredura de online.
  it("attendant_availability tem as colunas de elegibilidade/heartbeat (spec 13 §3.4)", () => {
    expect(columnExists("attendant_availability", "is_available")).toBe(true);
    expect(columnExists("attendant_availability", "capacity")).toBe(true);
    expect(columnExists("attendant_availability", "schedule")).toBe(true);
    expect(columnExists("attendant_availability", "last_heartbeat_at")).toBe(true);
    expect(indexExists("idx_attendant_availability_available")).toBe(true);
  });

  // RLS write-scope (spec 13 §3.4): a própria linha OU manager+. É a superfície
  // de segurança nova (o SELECT é org-wide, igual às demais tabelas).
  const insertAvail = (userId: string) =>
    `insert into public.attendant_availability (organization_id, user_id, is_available)
       values ('${GOV_ORG}', '${userId}', true)`;

  it("agent grava a PRÓPRIA disponibilidade (user_id = auth.uid())", () => {
    expect(writeCountAs(GOV_AGENT_A, insertAvail(GOV_AGENT_A))).toBe(1);
  });

  it("agent NÃO grava a disponibilidade de OUTRO agent (own-scope)", () => {
    expect(writeCountAs(GOV_AGENT_A, insertAvail(GOV_AGENT_B))).toBe(0);
  });

  it("manager grava a disponibilidade de QUALQUER atendente da org", () => {
    expect(writeCountAs(GOV_MANAGER, insertAvail(GOV_AGENT_B))).toBe(1);
  });
});
