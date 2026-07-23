/**
 * Task 8.6 — a fila mostra o agente PINADO no enrollment. Prova a função pura
 * de mapeamento `enrollmentToQueueRow` (o join `ai_agents:agent_id(name)` da
 * rota vira `agent_name`), cobrindo o embed do PostgREST nos dois formatos
 * (objeto único e array de 1) + ausência de agente pinado → null.
 */
import { describe, it, expect, vi } from "vitest";

// A rota importa server-only helpers no topo; mocka-se pra o import não puxar
// next/headers em ambiente jsdom. Só a função PURA é exercida.
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));

import { enrollmentToQueueRow } from "@/app/api/v1/ai/followups/queue/route";

const base = {
  id: "e1",
  contact_id: "c1",
  current_node_id: "n1",
  next_eval_at: "2026-07-23T00:00:00Z",
  status: "active",
  outcome: null,
  contacts: { id: "c1", name: "Ana", display_name: null, phone_number: null },
  followup_flow_pointers: { name: "Reativação" },
};

describe("enrollmentToQueueRow — agent_name", () => {
  it("agente pinado (embed objeto) → agent_name", () => {
    const row = enrollmentToQueueRow({ ...base, ai_agents: { name: "Vendedor IA" } });
    expect(row.agent_name).toBe("Vendedor IA");
    expect(row.flow_name).toBe("Reativação");
    expect(row.contact.name).toBe("Ana");
  });

  it("agente pinado (embed array de 1, como o PostgREST às vezes devolve) → agent_name", () => {
    const row = enrollmentToQueueRow({ ...base, ai_agents: [{ name: "Vendedor IA" }] });
    expect(row.agent_name).toBe("Vendedor IA");
  });

  it("sem agente pinado (agent_id null) → agent_name null", () => {
    const row = enrollmentToQueueRow({ ...base, ai_agents: null });
    expect(row.agent_name).toBeNull();
  });
});
