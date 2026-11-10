import { describe, expect, it, vi } from "vitest";

import { runSilenceSweep, type SilenceSweepDb } from "./silence-sweep";

/**
 * #3852 — o gatilho de SILÊNCIO com dois números.
 *
 * Relato: com dois WhatsApp, cada um com seu agente, o fluxo de silêncio do
 * agente A pegava lead que conversou no número do agente B e escrevia com a
 * persona errada — a varredura escolhia o agente só pelo ponteiro.
 *
 * O caso montado aqui é o mais cruel: DOIS fluxos de silêncio (um por número),
 * dois silenciosos (um por número). Antes do conserto cada fluxo alcançava os
 * dois contatos (4 inscrições, 2 com persona errada); agora cada fluxo alcança
 * só o silencioso do seu número (2 inscrições) e o outro é CONTADO.
 */

const ORG = "org-1";
const NUMERO_A = "numero-a";
const NUMERO_B = "numero-b";
const AGENTE_A = "agente-a";
const AGENTE_B = "agente-b";

interface FakeOpts {
  comCanal: boolean;
}

function fakeDb({ comCanal }: FakeOpts): { db: SilenceSweepDb; insert: ReturnType<typeof vi.fn> } {
  const insert = vi.fn(async () => ({ inserted: true }));
  const db: SilenceSweepDb = {
    loadActiveSilencePointers: async () => [
      { id: "fluxo-a", organization_id: ORG, active_version_id: "versao-a", threshold_minutes: 120, segments: [] },
      { id: "fluxo-b", organization_id: ORG, active_version_id: "versao-b", threshold_minutes: 120, segments: [] },
    ],
    loadSilentContactIds: async () => ["contato-a", "contato-b"],
    loadContatosComRetornoVivo: async () => new Set<string>(),
    loadEncerramentosDoFluxo: async () => new Map(),
    loadContatosComPessoaNoComando: async () => new Set<string>(),
    loadContatosComInscricaoViva: async () => new Set<string>(),
    loadTriggerNode: async (_orgId, versionId) => ({ id: `trigger-${versionId}`, pedeAgente: true }),
    loadContactIdsEmCooldown: async () => new Set<string>(),
    insertEnrollment: insert,
  };
  if (comCanal) {
    // A conversa de cada silencioso — é o que o adapter de produção tira da
    // MESMA leitura do silêncio.
    db.loadCanalDoSilencioso = async () => new Map([
      ["contato-a", NUMERO_A],
      ["contato-b", NUMERO_B],
    ]);
  }
  return { db, insert };
}

/** Cada fluxo é armado só pelo agente do SEU número. */
const GATE = {
  loadEnabledPublishedFollowupAgents: async () => [
    { agentId: AGENTE_A, pointerIds: ["fluxo-a"], channelSessionIds: [NUMERO_A] },
    { agentId: AGENTE_B, pointerIds: ["fluxo-b"], channelSessionIds: [NUMERO_B] },
  ],
};

const CLOCK = () => new Date("2026-11-03T12:00:00Z");

describe("#3852 — varredura de silêncio escolhe o agente pelo canal da conversa", () => {
  it("cada fluxo inscreve SÓ o silencioso do seu número, com o agente dele", async () => {
    const { db, insert } = fakeDb({ comCanal: true });

    const summary = await runSilenceSweep({ db, gateDb: GATE, clock: CLOCK });

    const inscricoes = insert.mock.calls.map(([entrada]) => entrada as {
      pointer_id: string;
      contact_id: string;
      agent_id: string | null;
    });
    // Sem o canal, este conjunto tem QUATRO linhas: `fluxo-a` alcança também
    // `contato-b` (silencioso do número B) e escreve com o agente de A.
    expect(
      inscricoes
        .map((i) => `${i.pointer_id}:${i.contact_id}:${i.agent_id}`)
        .sort(),
    ).toEqual(["fluxo-a:contato-a:agente-a", "fluxo-b:contato-b:agente-b"]);
    expect(summary.enrolled).toBe(2);
    // O silencioso do número do outro agente não é inscrito — e aparece contado.
    expect(summary.skipped_sem_agente_no_canal).toBe(2);
  });

  it("sem o canal disponível (adapter antigo), o comportamento é o de HOJE: os dois fluxos alcançam os dois contatos", async () => {
    const { db, insert } = fakeDb({ comCanal: false });

    const summary = await runSilenceSweep({ db, gateDb: GATE, clock: CLOCK });

    expect(insert).toHaveBeenCalledTimes(4);
    expect(summary.enrolled).toBe(4);
    expect(summary.skipped_sem_agente_no_canal).toBe(0);
    // E o agente pinado é o do fluxo — a decisão por organização, byte a byte.
    const porFluxo = new Map<string, Set<string | null>>();
    for (const [entrada] of insert.mock.calls) {
      const e = entrada as { pointer_id: string; agent_id: string | null };
      const set = porFluxo.get(e.pointer_id) ?? new Set();
      set.add(e.agent_id);
      porFluxo.set(e.pointer_id, set);
    }
    expect(porFluxo.get("fluxo-a")).toEqual(new Set([AGENTE_A]));
    expect(porFluxo.get("fluxo-b")).toEqual(new Set([AGENTE_B]));
  });

  it("canal conhecido e sem agente nele: o silencioso do número B nunca é inscrito", async () => {
    const { db, insert } = fakeDb({ comCanal: true });
    // O único agente armando os DOIS fluxos está publicado no número A.
    const gateSoNoA = {
      loadEnabledPublishedFollowupAgents: async () => [
        { agentId: AGENTE_A, pointerIds: ["fluxo-a", "fluxo-b"], channelSessionIds: [NUMERO_A] },
      ],
    };

    const summary = await runSilenceSweep({ db, gateDb: gateSoNoA, clock: CLOCK });

    // `fluxo-a` inscreve `contato-a` (número A); `fluxo-b` também alcança
    // `contato-a` — o agente arma esse fluxo. Nenhum dos dois alcança
    // `contato-b`, que é do número B: sem agente publicado lá, o contato é
    // pulado em vez de receber a persona do outro número.
    const alvos = insert.mock.calls.map(([entrada]) => (entrada as { contact_id: string }).contact_id);
    expect(alvos).toEqual(["contato-a", "contato-a"]);
    expect(summary.skipped_sem_agente_no_canal).toBe(2);
  });
});
