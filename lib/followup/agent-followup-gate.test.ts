import { describe, it, expect } from "vitest";

import {
  agenteDoGatilhoAutomatico,
  fluxoPedeAgente,
  isPointerEnabledForAutomaticTrigger,
  noDeGatilhoDoGrafo,
  resolveAgentForAutomaticTrigger,
  type EnabledFollowupAgent,
  type FollowupGateDb,
} from "./agent-followup-gate";

/** db a partir de `{orgId: [{agentId, pointerIds}]}`. */
function fakeDb(byOrg: Record<string, EnabledFollowupAgent[]>): FollowupGateDb {
  return {
    async loadEnabledPublishedFollowupAgents(orgId) {
      return byOrg[orgId] ?? [];
    },
  };
}

const ORG = "11111111-1111-1111-1111-111111111111";
const POINTER_A = "22222222-2222-2222-2222-222222222222";
const POINTER_B = "33333333-3333-3333-3333-333333333333";
const AGENT_LOW = "a0000000-0000-0000-0000-000000000000";
const AGENT_HIGH = "f0000000-0000-0000-0000-000000000000";

describe("isPointerEnabledForAutomaticTrigger", () => {
  it("true quando algum agente publicado da org arma o pointer", async () => {
    const db = fakeDb({ [ORG]: [{ agentId: AGENT_LOW, pointerIds: [POINTER_A, POINTER_B] }] });
    await expect(isPointerEnabledForAutomaticTrigger(db, ORG, POINTER_A)).resolves.toBe(true);
  });

  it("false quando nenhum agente arma o pointer", async () => {
    const db = fakeDb({ [ORG]: [{ agentId: AGENT_LOW, pointerIds: [POINTER_B] }] });
    await expect(isPointerEnabledForAutomaticTrigger(db, ORG, POINTER_A)).resolves.toBe(false);
  });

  it("false quando a org não tem nenhum agente com followup habilitado", async () => {
    const db = fakeDb({});
    await expect(isPointerEnabledForAutomaticTrigger(db, ORG, POINTER_A)).resolves.toBe(false);
  });

  it("não vaza pointer habilitado de OUTRA org", async () => {
    const otherOrg = "44444444-4444-4444-4444-444444444444";
    const db = fakeDb({ [otherOrg]: [{ agentId: AGENT_LOW, pointerIds: [POINTER_A] }] });
    await expect(isPointerEnabledForAutomaticTrigger(db, ORG, POINTER_A)).resolves.toBe(false);
  });
});

describe("resolveAgentForAutomaticTrigger (pick determinístico)", () => {
  it("devolve o agent_id que arma o pointer", async () => {
    const db = fakeDb({ [ORG]: [{ agentId: AGENT_LOW, pointerIds: [POINTER_A] }] });
    await expect(resolveAgentForAutomaticTrigger(db, ORG, POINTER_A)).resolves.toBe(AGENT_LOW);
  });

  it("com >1 agente armando o MESMO pointer → menor agent_id (uuid asc), independente da ordem de retorno do db", async () => {
    const db = fakeDb({
      [ORG]: [
        { agentId: AGENT_HIGH, pointerIds: [POINTER_A] },
        { agentId: AGENT_LOW, pointerIds: [POINTER_A] },
      ],
    });
    await expect(resolveAgentForAutomaticTrigger(db, ORG, POINTER_A)).resolves.toBe(AGENT_LOW);
  });

  it("null quando nenhum agente arma o pointer (gate-out)", async () => {
    const db = fakeDb({ [ORG]: [{ agentId: AGENT_LOW, pointerIds: [POINTER_B] }] });
    await expect(resolveAgentForAutomaticTrigger(db, ORG, POINTER_A)).resolves.toBeNull();
  });
});

describe("fluxoPedeAgente", () => {
  it("texto fixo, template, match_reply e espera fixa não pedem agente", () => {
    expect(
      fluxoPedeAgente({
        nodes: [
          { id: "t", type: "trigger" },
          { id: "a", type: "action", config: { mode: "text" } },
          { id: "m", type: "match_reply" },
          { id: "w", type: "wait", config: { mode: "fixed" } },
          { id: "e", type: "end" },
        ],
      }),
    ).toBe(false);
  });

  it("ai_classify, espera smart e ai_message pedem agente", () => {
    expect(fluxoPedeAgente({ nodes: [{ id: "c", type: "ai_classify" }] })).toBe(true);
    expect(fluxoPedeAgente({ nodes: [{ id: "w", type: "wait", config: { mode: "smart" } }] })).toBe(true);
    expect(fluxoPedeAgente({ nodes: [{ id: "a", type: "action", config: { mode: "ai_message" } }] })).toBe(true);
  });
});

describe("agenteDoGatilhoAutomatico", () => {
  it("sem agente, texto fixo enrolla com agent_id nulo", () => {
    expect(agenteDoGatilhoAutomatico(null, false)).toEqual({ agentId: null, barrado: false });
  });

  it("sem agente, grafo que pede IA é barrado", () => {
    expect(agenteDoGatilhoAutomatico(null, true)).toEqual({ agentId: null, barrado: true });
  });

  it("com agente, pina o id mesmo em fluxo de texto", () => {
    expect(agenteDoGatilhoAutomatico(AGENT_LOW, false)).toEqual({ agentId: AGENT_LOW, barrado: false });
  });
});

describe("noDeGatilhoDoGrafo", () => {
  it("devolve o trigger e se o grafo pede agente", () => {
    expect(
      noDeGatilhoDoGrafo({
        nodes: [
          { id: "t1", type: "trigger" },
          { id: "a1", type: "action", config: { mode: "text" } },
        ],
      }),
    ).toEqual({ id: "t1", pedeAgente: false });
  });

  it("sem trigger devolve null", () => {
    expect(noDeGatilhoDoGrafo({ nodes: [{ id: "e1", type: "end" }] })).toBeNull();
  });
});
