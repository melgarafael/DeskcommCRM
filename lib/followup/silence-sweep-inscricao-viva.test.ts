import { describe, expect, it, vi } from "vitest";

import { runSilenceSweep, type SilenceSweepDb } from "./silence-sweep";

/**
 * Quem JÁ tem follow-up vivo não é tentado de novo a cada minuto.
 *
 * Medido numa instalação real (02/10/2026): 86 contatos parados na espera
 * longa de um remarketing eram tentados a cada tick, em dois fluxos, e cada
 * tentativa ia até o INSERT que o índice único `idx_followup_enrollments_one_live`
 * recusa — ~124 mil recusas por dia, 100.854 erros 23505 no log de 24 h e um
 * 409 por tentativa no gateway, num banco já sem folga de CPU. O contador não
 * muda (`skipped_existing`); some a tentativa.
 */
function fakeDb(opts: { vivos: Set<string>; insert: SilenceSweepDb["insertEnrollment"] }): SilenceSweepDb {
  return {
    loadActiveSilencePointers: async () => [
      { id: "p-1", organization_id: "org-1", active_version_id: "v-1", threshold_minutes: 60, segments: [] },
    ],
    loadSilentContactIds: async () => ["vivo", "livre"],
    loadContatosComRetornoVivo: async () => new Set<string>(),
    loadEncerramentosDoFluxo: async () => new Map(),
    loadContatosComPessoaNoComando: async () => new Set<string>(),
    loadContatosComInscricaoViva: async () => opts.vivos,
    loadTriggerNode: async () => ({ id: "t-1", pedeAgente: false }),
    loadContactIdsEmCooldown: async () => new Set<string>(),
    insertEnrollment: opts.insert,
  };
}

const DEPS = {
  gateDb: { loadEnabledPublishedFollowupAgents: async () => [] },
  clock: () => new Date("2026-10-02T12:00:00Z"),
};

describe("runSilenceSweep — inscrição viva", () => {
  it("contato já vivo em algum fluxo é pulado SEM tentar o insert; o livre é inscrito", async () => {
    const insert = vi.fn(async () => ({ inserted: true }));
    const summary = await runSilenceSweep({ db: fakeDb({ vivos: new Set(["vivo"]), insert }), ...DEPS });

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ contact_id: "livre" }));
    expect(summary.skipped_existing).toBe(1);
    expect(summary.enrolled).toBe(1);
  });

  it("a corrida segue coberta: se o insert bater no índice mesmo assim, conta como skipped_existing", async () => {
    const insert = vi.fn(async () => ({ inserted: false }));
    const summary = await runSilenceSweep({ db: fakeDb({ vivos: new Set(), insert }), ...DEPS });

    expect(insert).toHaveBeenCalledTimes(2);
    expect(summary.skipped_existing).toBe(2);
    expect(summary.enrolled).toBe(0);
  });
});
