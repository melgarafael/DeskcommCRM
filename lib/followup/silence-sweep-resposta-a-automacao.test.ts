import { describe, expect, it, vi } from "vitest";

import { runSilenceSweep, type SilencePointer, type SilenceSweepDb } from "./silence-sweep";

/**
 * #3720 — o fluxo de silêncio não inscreve quem só respondeu a uma automática.
 *
 * O caso da instalação do relato: 09h07 a automação manda parabéns, 09h11 o
 * cliente responde um coração, e o fluxo "Lead novo sem retorno" (silêncio,
 * 60–180 min) passa a mandar até 6 mensagens de venda em 7 dias. Aqui o `db` é
 * falso e o que se prende é a DECISÃO do sweep: quem o adapter marcou como
 * "respondeu a automática" não é inscrito, os demais seguem, e um adapter sem o
 * método não muda nada (o comportamento de antes).
 *
 * A régua em si (a ordem das mensagens da conversa) é do outro arquivo,
 * `resposta-a-automacao.test.ts`, contra a query real.
 */
function fakeDb(opts: {
  soAutomacao?: Set<string>;
  omitirMetodo?: boolean;
  insert?: SilenceSweepDb["insertEnrollment"];
}): SilenceSweepDb {
  const pointer: SilencePointer = {
    id: "p-1",
    organization_id: "org-1",
    active_version_id: "v-1",
    threshold_minutes: 180,
    segments: [],
  };
  const db: SilenceSweepDb = {
    loadActiveSilencePointers: async () => [pointer],
    loadSilentContactIds: async () => ["so-agradeceu", "lead-frio"],
    loadContatosComRetornoVivo: async () => new Set<string>(),
    loadEncerramentosDoFluxo: async () => new Map(),
    loadContatosComPessoaNoComando: async () => new Set<string>(),
    loadContatosComInscricaoViva: async () => new Set<string>(),
    loadTriggerNode: async () => ({ id: "t-1", pedeAgente: false }),
    loadContactIdsEmCooldown: async () => new Set<string>(),
    insertEnrollment: opts.insert ?? (async () => ({ inserted: true })),
  };
  if (!opts.omitirMetodo) {
    db.loadContatosQueSoResponderamAAutomacao = async (_org, ids) =>
      new Set(ids.filter((id) => (opts.soAutomacao ?? new Set()).has(id)));
  }
  return db;
}

const DEPS_BASE = {
  gateDb: { loadEnabledPublishedFollowupAgents: async () => [] },
  clock: () => new Date("2026-10-28T13:00:00Z"),
};

describe("runSilenceSweep — resposta a mensagem automática (#3720)", () => {
  it("quem só agradeceu o parabéns NÃO é inscrito; o lead frio de verdade entra", async () => {
    const insert = vi.fn(async () => ({ inserted: true }));
    const db = fakeDb({ soAutomacao: new Set(["so-agradeceu"]), insert });

    const summary = await runSilenceSweep({ db, ...DEPS_BASE });

    expect(summary.skipped_resposta_a_automacao).toBe(1);
    expect(summary.enrolled).toBe(1);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ contact_id: "lead-frio" }));
    expect(insert).not.toHaveBeenCalledWith(expect.objectContaining({ contact_id: "so-agradeceu" }));
  });

  it("a guarda é perguntada ANTES do cooldown: o contador conta o motivo certo", async () => {
    // Quem respondeu ao parabéns e já passou pelo fluxo bateria nos dois
    // motivos; o primeiro que decide é o que diz a verdade — não é throttle de
    // tempo, é "este contato nunca devia ter sido considerado".
    const db = fakeDb({ soAutomacao: new Set(["so-agradeceu"]) });
    db.loadContactIdsEmCooldown = async (_org, _pointer, ids) => new Set(ids);

    const summary = await runSilenceSweep({ db, ...DEPS_BASE });

    expect(summary.skipped_resposta_a_automacao).toBe(1);
    expect(summary.skipped_cooldown).toBe(1); // o outro contato
    expect(summary.enrolled).toBe(0);
  });

  it("adapter sem o método: ninguém é barrado por este motivo (comportamento de antes)", async () => {
    const insert = vi.fn(async () => ({ inserted: true }));
    const db = fakeDb({ omitirMetodo: true, insert });

    const summary = await runSilenceSweep({ db, ...DEPS_BASE });

    expect(summary.skipped_resposta_a_automacao).toBe(0);
    expect(summary.enrolled).toBe(2);
    expect(insert).toHaveBeenCalledTimes(2);
  });

  it("ninguém respondeu a automação: o fluxo segue idêntico", async () => {
    const db = fakeDb({ soAutomacao: new Set<string>() });

    const summary = await runSilenceSweep({ db, ...DEPS_BASE });

    expect(summary.skipped_resposta_a_automacao).toBe(0);
    expect(summary.enrolled).toBe(2);
  });
});
