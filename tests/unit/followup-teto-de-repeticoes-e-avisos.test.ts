import { describe, expect, it, vi } from "vitest";

import {
  runSilenceSweep,
  type SilencePointer,
  type SilenceSweepDb,
} from "../../lib/followup/silence-sweep";
import { triggerConfigSchema } from "../../lib/followup/api-schemas";
import {
  avisosDoGatilho,
  validateFlowForPublish,
  PUBLISH_WARNING_CODES,
} from "../../lib/followup/validate-publish";

/**
 * Item 16 — teto de repetições, e avisos na publicação.
 *
 * A pausa de reentrada só ESPAÇA os reinícios. Quem nunca responde segue
 * elegível para sempre, porque nada atualiza a última mensagem dele: o fluxo
 * recomeça a cada pausa — 24 h, 48 h, 72 h — indefinidamente. O teto é o único
 * mecanismo que ENCERRA o laço.
 *
 * Os avisos não reprovam de propósito: as três situações são escolhas legítimas
 * em algum fluxo, e virar erro duro reprovaria o re-publish de fluxos de
 * silêncio que já existem em outras instalações.
 */

const DEPS_BASE = {
  gateDb: { loadEnabledPublishedFollowupAgents: async () => [] },
  clock: () => new Date("2026-10-15T12:00:00Z"),
};

function fakeDb(opts: {
  teto?: number;
  contagem?: Map<string, number>;
  omitirMetodo?: boolean;
  insert?: SilenceSweepDb["insertEnrollment"];
}): SilenceSweepDb {
  const pointer: SilencePointer = {
    id: "p-1",
    organization_id: "org-1",
    active_version_id: "v-1",
    threshold_minutes: 1440,
    segments: [],
    ...(opts.teto ? { max_enrollments_por_contato: opts.teto } : {}),
  };
  const db: SilenceSweepDb = {
    loadActiveSilencePointers: async () => [pointer],
    loadSilentContactIds: async () => ["novato", "veterano"],
    loadContatosComRetornoVivo: async () => new Set<string>(),
    loadEncerramentosDoFluxo: async () => new Map(),
    loadContatosComPessoaNoComando: async () => new Set<string>(),
    loadContatosComInscricaoViva: async () => new Set<string>(),
    loadTriggerNode: async () => ({ id: "t-1", pedeAgente: false }),
    loadContactIdsEmCooldown: async () => new Set<string>(),
    insertEnrollment: opts.insert ?? (async () => ({ inserted: true })),
  };
  if (!opts.omitirMetodo) {
    db.loadContagemDeInscricoes = async () => opts.contagem ?? new Map();
  }
  return db;
}

describe("teto de repeticoes no sweep", () => {
  it("quem bateu o teto fica de fora; quem ainda tem vez entra", async () => {
    const insert = vi.fn(async () => ({ inserted: true }));
    const db = fakeDb({
      teto: 3,
      contagem: new Map([
        ["novato", 1],
        ["veterano", 3],
      ]),
      insert,
    });

    const summary = await runSilenceSweep({ db, ...DEPS_BASE });

    expect(summary.skipped_teto_de_repeticoes).toBe(1);
    expect(summary.enrolled).toBe(1);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ contact_id: "novato" }));
  });

  it("contagem ACIMA do teto tambem barra (nao e igualdade)", async () => {
    const db = fakeDb({ teto: 2, contagem: new Map([["veterano", 9]]) });

    const summary = await runSilenceSweep({ db, ...DEPS_BASE });

    expect(summary.skipped_teto_de_repeticoes).toBe(1);
    expect(summary.enrolled).toBe(1);
  });

  it("SEM teto configurado: a contagem nao e nem consultada", async () => {
    const db = fakeDb({ contagem: new Map([["veterano", 99]]) });
    const espia = vi.fn(db.loadContagemDeInscricoes!);
    db.loadContagemDeInscricoes = espia;

    const summary = await runSilenceSweep({ db, ...DEPS_BASE });

    expect(espia).not.toHaveBeenCalled();
    expect(summary.skipped_teto_de_repeticoes).toBe(0);
    expect(summary.enrolled).toBe(2);
  });

  it("teto configurado e adaptador sem o metodo: falha FECHADA", async () => {
    const insert = vi.fn(async () => ({ inserted: true }));
    const db = fakeDb({ teto: 3, omitirMetodo: true, insert });

    const summary = await runSilenceSweep({ db, ...DEPS_BASE });

    expect(summary.enrolled).toBe(0);
    expect(summary.skipped_teto_de_repeticoes).toBe(2);
    expect(insert).not.toHaveBeenCalled();
  });

  it("contato ausente da contagem conta como zero e entra", async () => {
    const db = fakeDb({ teto: 1, contagem: new Map([["veterano", 1]]) });

    const summary = await runSilenceSweep({ db, ...DEPS_BASE });

    expect(summary.enrolled).toBe(1);
    expect(summary.skipped_teto_de_repeticoes).toBe(1);
  });
});

describe("o contrato do teto", () => {
  const base = { kind: "silence", params: { threshold_minutes: 1440 } };

  it("aceita de 1 a 50", () => {
    for (const n of [1, 3, 50]) {
      const cfg = { ...base, params: { ...base.params, max_enrollments_por_contato: n } };
      expect(triggerConfigSchema.safeParse(cfg).success).toBe(true);
    }
  });

  it("recusa 0, negativo e fracionario — 0 se diz OMITINDO o campo", () => {
    for (const n of [0, -1, 2.5, 51]) {
      const cfg = { ...base, params: { ...base.params, max_enrollments_por_contato: n } };
      expect(triggerConfigSchema.safeParse(cfg).success).toBe(false);
    }
  });

  it("o gatilho de sempre, sem o campo, continua valido", () => {
    expect(triggerConfigSchema.safeParse(base).success).toBe(true);
  });
});

describe("avisos do gatilho na publicacao", () => {
  const silencio = (params: Record<string, unknown>) =>
    triggerConfigSchema.parse({ kind: "silence", params: { threshold_minutes: 180, ...params } });

  it("fluxo de silencio cru rende os TRES avisos", () => {
    const avisos = avisosDoGatilho(silencio({}));
    expect(avisos.map((a) => a.code).sort()).toEqual([...PUBLISH_WARNING_CODES].sort());
  });

  it("cada knob preenchido cala o seu aviso, e so o seu", () => {
    expect(avisosDoGatilho(silencio({ max_silence_minutes: 360 })).map((a) => a.code)).toEqual([
      "silencio_sem_limite_de_repeticoes",
      "silencio_alcanca_nao_atendido",
    ]);
    expect(
      avisosDoGatilho(silencio({ max_enrollments_por_contato: 3 })).map((a) => a.code),
    ).toEqual(["silencio_sem_teto", "silencio_alcanca_nao_atendido"]);
    expect(
      avisosDoGatilho(silencio({ exige_resposta_da_equipe: true })).map((a) => a.code),
    ).toEqual(["silencio_sem_teto", "silencio_sem_limite_de_repeticoes"]);
  });

  it("com os tres preenchidos, nenhum aviso", () => {
    const avisos = avisosDoGatilho(
      silencio({
        max_silence_minutes: 360,
        max_enrollments_por_contato: 3,
        exige_resposta_da_equipe: true,
      }),
    );
    expect(avisos).toEqual([]);
  });

  it("gatilho que NAO e de silencio nao rende aviso nenhum", () => {
    expect(avisosDoGatilho(triggerConfigSchema.parse({ kind: "manual" }))).toEqual([]);
    expect(
      avisosDoGatilho(
        triggerConfigSchema.parse({
          kind: "stage_change",
          params: { stage_id: "44444444-4444-4444-8444-444444444444" },
        }),
      ),
    ).toEqual([]);
  });

  it("gatilho ausente nao rende aviso (nada a dizer sobre o que nao se sabe)", () => {
    expect(avisosDoGatilho(undefined)).toEqual([]);
  });

  it("toda mensagem de aviso diz o que FAZER, nao so que ha algo errado", () => {
    for (const aviso of avisosDoGatilho(silencio({}))) {
      expect(aviso.message.length).toBeGreaterThan(80);
    }
  });
});

describe("a compatibilidade do resultado da validacao", () => {
  const grafoValido = {
    nodes: [
      { id: "t", type: "trigger", label: "Começo", position: { x: 0, y: 0 }, config: {} },
      {
        id: "a",
        type: "action",
        label: "Manda",
        position: { x: 0, y: 0 },
        config: { mode: "text", body: "Oi" },
      },
      { id: "f", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "exhausted" } },
    ],
    edges: [
      { id: "e0", source: "t", target: "a", priority: 0, condition: { type: "always" } },
      { id: "e1", source: "a", target: "f", priority: 0, condition: { type: "always" } },
    ],
  };

  it("sem gatilho no contexto, o sucesso NAO ganha campo novo (consumidor antigo intacto)", () => {
    const r = validateFlowForPublish(grafoValido as never, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings).toBeUndefined();
  });

  it("com gatilho de silencio cru, o sucesso carrega os avisos", () => {
    const r = validateFlowForPublish(grafoValido as never, {
      trigger: triggerConfigSchema.parse({ kind: "silence", params: { threshold_minutes: 180 } }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings).toHaveLength(3);
  });

  it("grafo REPROVADO segue reprovado, e os avisos viajam ao lado dos erros", () => {
    const semGatilho = { nodes: [], edges: [] };
    const r = validateFlowForPublish(semGatilho as never, {
      trigger: triggerConfigSchema.parse({ kind: "silence", params: { threshold_minutes: 180 } }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // O que todo consumidor atual lê continua no lugar.
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.warnings).toHaveLength(3);
    }
  });
});
