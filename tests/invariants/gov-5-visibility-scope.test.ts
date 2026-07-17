import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_CONV_AGENT_B,
  countAs,
  seedGov,
} from "./gov-helpers";

/**
 * Eixo 5 — Escopo de visualização (spec 13 §1; fase que fecha: G4).
 * docs/specs/13-spec-governanca-atendimento.md — dor: '"select sem where":
 * atendente vê tudo; métricas sem filtro por responsável'. Matriz alvo na
 * spec 13 §4 (agent = own*; visibility_mode em §3).
 */

beforeAll(() => {
  seedGov();
});

describe("eixo 5 — escopo de visualização", () => {
  it("agent vê conversa atribuída a si mesmo (controle positivo — vale hoje e pós-G4)", () => {
    const own = countAs(
      GOV_AGENT_B,
      `select count(*) from public.conversations where id = '${GOV_CONV_AGENT_B}';`,
    );
    expect(own).toBe(1);
  });

  // GAP(G4): a RLS de conversations é org-flat — agent A enxerga a conversa
  // atribuída ao agent B da mesma org. Spec 13 §4: agent = own*:read+write.
  it.fails("agent NÃO vê conversa atribuída a outro agent (spec 13 §4: agent = own*)", () => {
    const crossAgent = countAs(
      GOV_AGENT_A,
      `select count(*) from public.conversations where id = '${GOV_CONV_AGENT_B}';`,
    );
    expect(crossAgent).toBe(0);
  });
});
