import { describe, expect, it, vi } from "vitest";

import { runSilenceSweep, type SilencePointer, type SilenceSweepDb } from "./silence-sweep";

/**
 * `exige_resposta_da_equipe` — a dívida da equipe não é silêncio do cliente.
 *
 * O limiar mede há quanto tempo o CLIENTE não escreve, e mensagem nossa não
 * zera esse relógio. Sem este knob, o contato que escreveu e NÃO FOI ATENDIDO é
 * o silencioso mais perfeito que existe: na instalação do relato eram 147
 * conversas sem dono, média de 5 dias de espera, que receberiam "ainda tem
 * interesse?" de um fluxo de 180 min.
 *
 * O que estes casos prendem, nas duas direções:
 *  - LIGADO barra quem não foi respondido e deixa passar quem foi;
 *  - DESLIGADO (o default) não consulta nada e mantém o comportamento de antes
 *    byte a byte — é o que preserva fluxo publicado de outras instalações;
 *  - LIGADO com adapter sem o método falha FECHADA (não inscreve ninguém), em
 *    vez de ler a ausência como "todos respondidos".
 */
function fakeDb(opts: {
  semResposta?: Set<string>;
  exige?: boolean;
  omitirMetodo?: boolean;
  insert?: SilenceSweepDb["insertEnrollment"];
}): SilenceSweepDb {
  const pointer: SilencePointer = {
    id: "p-1",
    organization_id: "org-1",
    active_version_id: "v-1",
    threshold_minutes: 180,
    segments: [],
    ...(opts.exige ? { exige_resposta_da_equipe: true } : {}),
  };
  const db: SilenceSweepDb = {
    loadActiveSilencePointers: async () => [pointer],
    loadSilentContactIds: async () => ["respondido", "no-vacuo"],
    loadContatosComRetornoVivo: async () => new Set<string>(),
    loadEncerramentosDoFluxo: async () => new Map(),
    loadContatosComPessoaNoComando: async () => new Set<string>(),
    loadContatosComInscricaoViva: async () => new Set<string>(),
    loadTriggerNode: async () => ({ id: "t-1", pedeAgente: false }),
    loadContactIdsEmCooldown: async () => new Set<string>(),
    insertEnrollment: opts.insert ?? (async () => ({ inserted: true })),
  };
  if (!opts.omitirMetodo) {
    db.loadContatosSemRespostaDaEquipe = async (_org, ids) =>
      new Set(ids.filter((id) => (opts.semResposta ?? new Set()).has(id)));
  }
  return db;
}

const DEPS_BASE = {
  gateDb: { loadEnabledPublishedFollowupAgents: async () => [] },
  clock: () => new Date("2026-10-15T12:00:00Z"),
};

describe("runSilenceSweep — exige_resposta_da_equipe", () => {
  it("LIGADO: quem a equipe não respondeu fica de fora; quem foi respondido entra", async () => {
    const insert = vi.fn(async () => ({ inserted: true }));
    const db = fakeDb({ exige: true, semResposta: new Set(["no-vacuo"]), insert });

    const summary = await runSilenceSweep({ db, ...DEPS_BASE });

    expect(summary.skipped_sem_resposta_da_equipe).toBe(1);
    expect(summary.enrolled).toBe(1);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ contact_id: "respondido" }));
  });

  it("DESLIGADO (default): o conjunto não é nem consultado, e os dois entram", async () => {
    const insert = vi.fn(async () => ({ inserted: true }));
    const db = fakeDb({ semResposta: new Set(["no-vacuo"]), insert });
    const espia = vi.fn(db.loadContatosSemRespostaDaEquipe!);
    db.loadContatosSemRespostaDaEquipe = espia;

    const summary = await runSilenceSweep({ db, ...DEPS_BASE });

    expect(espia).not.toHaveBeenCalled();
    expect(summary.skipped_sem_resposta_da_equipe).toBe(0);
    expect(summary.enrolled).toBe(2);
  });

  it("LIGADO sem o método no adapter: falha FECHADA — ninguém é inscrito", async () => {
    const insert = vi.fn(async () => ({ inserted: true }));
    const db = fakeDb({ exige: true, omitirMetodo: true, insert });

    const summary = await runSilenceSweep({ db, ...DEPS_BASE });

    expect(summary.enrolled).toBe(0);
    expect(summary.skipped_sem_resposta_da_equipe).toBe(2);
    expect(insert).not.toHaveBeenCalled();
  });

  it("LIGADO com todos respondidos: ninguém é barrado por este motivo", async () => {
    const db = fakeDb({ exige: true, semResposta: new Set<string>() });

    const summary = await runSilenceSweep({ db, ...DEPS_BASE });

    expect(summary.skipped_sem_resposta_da_equipe).toBe(0);
    expect(summary.enrolled).toBe(2);
  });
});
