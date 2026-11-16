import { describe, it, expect } from "vitest";

import {
  decidirAgenteDoEnrollmentAutomatico,
  resolveAgentForAutomaticTrigger,
  type EnabledFollowupAgent,
  type FollowupGateDb,
} from "./agent-followup-gate";

/**
 * #3852 — com DOIS número de WhatsApp, cada um com seu agente, o gatilho
 * automático escolhia o agente só pelo ponteiro do fluxo. O fluxo do agente A
 * pegava lead que conversou no número do agente B e escrevia com a persona
 * errada.
 *
 * Aqui o defeito aparece no caso mais cru: os dois agentes armam o MESMO
 * ponteiro (é o que a decisão antiga olhava), e o menor uuid — `AGENT_B` —
 * ganhava a conversa do número A. Com o canal, o candidato é só quem está
 * publicado NAQUELE número.
 */

const ORG = "11111111-1111-1111-1111-111111111111";
const POINTER = "22222222-2222-2222-2222-222222222222";
const NUMERO_A = "aaaa1111-0000-4000-8000-00000000000a";
const NUMERO_B = "bbbb2222-0000-4000-8000-00000000000b";

/** `AGENT_B` é o MENOR uuid de propósito: é ele que a regra antiga escolhia. */
const AGENT_A = "f0000000-0000-0000-0000-00000000000a";
const AGENT_B = "a0000000-0000-0000-0000-00000000000b";

function fakeDb(agentes: EnabledFollowupAgent[]): FollowupGateDb {
  return {
    async loadEnabledPublishedFollowupAgents(orgId) {
      return orgId === ORG ? agentes : [];
    },
  };
}

const DOIS_NUMEROS = fakeDb([
  { agentId: AGENT_A, pointerIds: [POINTER], channelSessionIds: [NUMERO_A] },
  { agentId: AGENT_B, pointerIds: [POINTER], channelSessionIds: [NUMERO_B] },
]);

describe("#3852 — o agente do canal B não pode atender a conversa do canal A", () => {
  it("com o canal, escolhe o agente publicado NAQUELE número (e não o menor uuid)", async () => {
    // Sem o parâmetro a escolha é `AGENT_B` (menor uuid) — o defeito de hoje.
    await expect(resolveAgentForAutomaticTrigger(DOIS_NUMEROS, ORG, POINTER)).resolves.toBe(AGENT_B);
    // Com o canal, quem atende a conversa do número A é o agente publicado nele.
    await expect(resolveAgentForAutomaticTrigger(DOIS_NUMEROS, ORG, POINTER, NUMERO_A)).resolves.toBe(AGENT_A);
    await expect(resolveAgentForAutomaticTrigger(DOIS_NUMEROS, ORG, POINTER, NUMERO_B)).resolves.toBe(AGENT_B);
  });

  it("fluxo que pede IA: canal A recebe o agente de A, não o de B", async () => {
    await expect(decidirAgenteDoEnrollmentAutomatico(DOIS_NUMEROS, ORG, POINTER, true, NUMERO_A)).resolves.toEqual({
      agentId: AGENT_A,
      barrado: false,
    });
  });
});

describe("#3852 — o default continua sendo o de antes", () => {
  it("sem o parâmetro novo, o resultado é o MESMO de hoje (menor uuid, ainda que de outro número)", async () => {
    await expect(decidirAgenteDoEnrollmentAutomatico(DOIS_NUMEROS, ORG, POINTER, true)).resolves.toEqual({
      agentId: AGENT_B,
      barrado: false,
    });
  });

  it("com `null` explícito também é o default (canal desconhecido não filtra)", async () => {
    await expect(decidirAgenteDoEnrollmentAutomatico(DOIS_NUMEROS, ORG, POINTER, true, null)).resolves.toEqual({
      agentId: AGENT_B,
      barrado: false,
    });
  });

  it("agente sem canal declarado (dublê/instalação antiga) continua competindo quando não há canal", async () => {
    const semCanal = fakeDb([{ agentId: AGENT_A, pointerIds: [POINTER] }]);
    await expect(decidirAgenteDoEnrollmentAutomatico(semCanal, ORG, POINTER, true)).resolves.toEqual({
      agentId: AGENT_A,
      barrado: false,
    });
  });
});

describe("#3852 — canal conhecido sem nenhum agente publicado nele", () => {
  const soAB = fakeDb([{ agentId: AGENT_B, pointerIds: [POINTER], channelSessionIds: [NUMERO_B] }]);

  it("fluxo que pede IA é BARRADO — não cai no agente do outro número", async () => {
    await expect(decidirAgenteDoEnrollmentAutomatico(soAB, ORG, POINTER, true, NUMERO_A)).resolves.toEqual({
      agentId: null,
      barrado: true,
    });
  });

  it("fluxo de texto fixo segue, nascendo sem agente (nunca com a persona de outro número)", async () => {
    await expect(decidirAgenteDoEnrollmentAutomatico(soAB, ORG, POINTER, false, NUMERO_A)).resolves.toEqual({
      agentId: null,
      barrado: false,
    });
  });

  it("agente de canal DESCONHECIDO não é candidato a um canal concreto", async () => {
    const desconhecido = fakeDb([{ agentId: AGENT_A, pointerIds: [POINTER], channelSessionIds: [] }]);
    await expect(resolveAgentForAutomaticTrigger(desconhecido, ORG, POINTER, NUMERO_A)).resolves.toBeNull();
    // e continua concorrendo quando a chamada não pede canal
    await expect(resolveAgentForAutomaticTrigger(desconhecido, ORG, POINTER)).resolves.toBe(AGENT_A);
  });
});
