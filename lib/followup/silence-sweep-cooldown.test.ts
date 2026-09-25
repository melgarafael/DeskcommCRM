import { describe, expect, it, vi } from "vitest";

import { runSilenceSweep, type SilenceSweepDb } from "./silence-sweep";

/**
 * O cooldown pós-conclusão (issue de produção, 2026-09-25) — versão RÁPIDA,
 * com `SilenceSweepDb` fake em memória (sem Postgres). A prova completa contra
 * banco real está em `tests/invariants/followup-silence-sweep.test.ts`
 * ("cooldown pós-conclusão"); este arquivo é o feedback rápido de CI/local.
 *
 * Sem o filtro de `emCooldown` em `runSilenceSweep`, o cron reinscreveria o
 * MESMO contato a cada tick (1×/min) assim que o enrollment anterior saísse de
 * `active`/`waiting_reply` — medido em produção: 32 disparos em ~9h para um
 * pointer com `threshold_minutes: 120`, quando o esperado era 1 a cada 2h.
 */
function fakeDb(opts: {
  contatosEmCooldown: Set<string>;
  insert?: SilenceSweepDb["insertEnrollment"];
}): SilenceSweepDb {
  return {
    loadActiveSilencePointers: async () => [
      {
        id: "p-1",
        organization_id: "org-1",
        active_version_id: "v-1",
        threshold_minutes: 120,
        segments: [],
      },
    ],
    loadSilentContactIds: async () => ["contato-a", "contato-b"],
    loadTriggerNode: async () => ({ id: "t-1", pedeAgente: false }),
    loadContactIdsEmCooldown: async () => opts.contatosEmCooldown,
    insertEnrollment: opts.insert ?? (async () => ({ inserted: true })),
  };
}

const DEPS_BASE = {
  gateDb: { loadEnabledPublishedFollowupAgents: async () => [] },
  clock: () => new Date("2026-09-25T12:00:00Z"),
};

describe("runSilenceSweep — cooldown pós-conclusão", () => {
  it("contato em cooldown não é reinscrito; o outro, silencioso e livre, é", async () => {
    const insert = vi.fn(async () => ({ inserted: true }));
    const db = fakeDb({ contatosEmCooldown: new Set(["contato-a"]), insert });

    const summary = await runSilenceSweep({ db, ...DEPS_BASE });

    expect(summary.skipped_cooldown).toBe(1);
    expect(summary.enrolled).toBe(1);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ contact_id: "contato-b" }));
  });

  it("nenhum contato em cooldown → todos passam para insertEnrollment normalmente", async () => {
    const insert = vi.fn(async () => ({ inserted: true }));
    const db = fakeDb({ contatosEmCooldown: new Set(), insert });

    const summary = await runSilenceSweep({ db, ...DEPS_BASE });

    expect(summary.skipped_cooldown).toBe(0);
    expect(summary.enrolled).toBe(2);
    expect(insert).toHaveBeenCalledTimes(2);
  });

  it("todos os contatos silenciosos em cooldown → nenhuma chamada a insertEnrollment (sem gasto)", async () => {
    const insert = vi.fn(async () => ({ inserted: true }));
    const db = fakeDb({ contatosEmCooldown: new Set(["contato-a", "contato-b"]), insert });

    const summary = await runSilenceSweep({ db, ...DEPS_BASE });

    expect(summary.skipped_cooldown).toBe(2);
    expect(summary.enrolled).toBe(0);
    expect(insert).not.toHaveBeenCalled();
  });
});
