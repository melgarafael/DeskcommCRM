/**
 * A fonte honesta do tempo nos relatórios (issue #2032).
 *
 * O card já foi provado em `lib/kanban/card-state.test.ts` (PR #1908); aqui é a
 * MESMA escolha na camada de relatório, e os três casos que a issue cobra estão
 * nos três primeiros testes:
 *
 *   (a) com carimbo → `stage_changed_at`;
 *   (b) sem carimbo → `created_at` (a reserva, nunca a atividade);
 *   (c) `last_activity_at` é ignorado mesmo sendo mais recente que tudo.
 *
 * O caso (c) é o que separa regressão de acaso: se a medição voltar a ler a
 * última atividade, o teste cai — é o break deliberado que o PR relata.
 *
 * `agora` é injetado em toda chamada: teste que mede a data do relógio de quem
 * roda passa hoje e falha amanhã, que é o oposto de regressão.
 */
import { describe, expect, it } from "vitest";

import {
  agregarPorEtapa,
  entradaNaEtapa,
  fonteDaAncora,
  horasNaEtapa,
  type EtapaMedida,
  type LeadEmMedicao,
} from "./tempo-da-etapa";

const AGORA = new Date("2026-10-03T12:00:00.000Z");

/** Criação: 10 dias antes de `AGORA` → 240h de reserva. */
const CRIADO_EM = "2026-09-23T12:00:00.000Z";
/** Entrada na etapa: 9 dias antes de `AGORA` → 216h de etapa. */
const MOVIDO_EM = "2026-09-24T12:00:00.000Z";

function linha(over: Partial<LeadEmMedicao> = {}): LeadEmMedicao {
  return {
    stage_id: "et-2",
    stage_changed_at: MOVIDO_EM,
    created_at: CRIADO_EM,
    ...over,
  };
}

/**
 * `noUncheckedIndexedAccess` faz `etapas[0]` ser `EtapaMedida | undefined`, e
 * uma asserção sobre `undefined` reprovaria o teste com uma mensagem que não
 * diz o que faltou. Procurar pela etapa dá o erro que o teste quer dizer.
 */
function etapa(etapas: readonly EtapaMedida[], stageId: string): EtapaMedida {
  const achada = etapas.find((e) => e.stageId === stageId);
  if (!achada) throw new Error(`a etapa ${stageId} não apareceu no relatório`);
  return achada;
}

describe("tempo-da-etapa · de qual coluna vem o relógio", () => {
  // CASO (a) — o carimbo do trigger da 0071 manda, e a criação não entra.
  it("com carimbo: a âncora é stage_changed_at e a etapa tem 216h, não 240h", () => {
    const lead = linha();

    expect(fonteDaAncora(lead)).toBe("stage_changed_at");
    expect(entradaNaEtapa(lead)).toBe(MOVIDO_EM);
    expect(horasNaEtapa(lead, AGORA)).toBeCloseTo(216, 5);
  });

  // CASO (b) — dado legado sem carimbo: a reserva é o NASCIMENTO do negócio.
  it("sem carimbo: a reserva é created_at (240h), nunca uma data de atividade", () => {
    const lead = linha({ stage_changed_at: null });

    expect(fonteDaAncora(lead)).toBe("created_at");
    expect(entradaNaEtapa(lead)).toBe(CRIADO_EM);
    expect(horasNaEtapa(lead, AGORA)).toBeCloseTo(240, 5);
  });

  // CASO (c) — o defeito que esta issue existe para não repetir. Dois relógios
  // discordam, o relatório tem de escolher o da ETAPA.
  it("last_activity_at mais recente não zera o relógio, com carimbo e sem ele", () => {
    const comCarimbo = linha({ last_activity_at: AGORA.toISOString() });
    expect(horasNaEtapa(comCarimbo, AGORA)).toBeCloseTo(216, 5);

    const semCarimbo = linha({
      stage_changed_at: null,
      last_activity_at: AGORA.toISOString(),
    });
    expect(horasNaEtapa(semCarimbo, AGORA)).toBeCloseTo(240, 5);

    // E a atividade VELHA também não muda nada: só a coluna da etapa decide.
    const atividadeAntiga = linha({
      last_activity_at: "2026-06-01T12:00:00.000Z",
    });
    expect(horasNaEtapa(atividadeAntiga, AGORA)).toBeCloseTo(216, 5);
  });

  it("carimbo no futuro não vira idade negativa", () => {
    const lead = linha({ stage_changed_at: "2026-10-05T12:00:00.000Z" });

    expect(horasNaEtapa(lead, AGORA)).toBe(0);
  });
});

describe("tempo-da-etapa · agregarPorEtapa — quantidade e tempo por etapa", () => {
  // et-2: dois negócios, um medido por carimbo (216h) e um por reserva (240h).
  // et-1: três de carimbo — 24h, 96h e 336h — para a mediana (96) divergir da
  // média (152) e o teste pegar quem escrever média no lugar da mediana.
  const leads: LeadEmMedicao[] = [
    linha(),
    linha({ stage_changed_at: null }),
    linha({ stage_id: "et-1", stage_changed_at: "2026-10-02T12:00:00.000Z" }),
    linha({ stage_id: "et-1", stage_changed_at: "2026-09-29T12:00:00.000Z" }),
    linha({ stage_id: "et-1", stage_changed_at: "2026-09-19T12:00:00.000Z" }),
  ];

  it("conta quantos há em cada etapa e mede o tempo de cada uma", () => {
    const etapas = agregarPorEtapa(leads, AGORA);

    // A ordem é a de primeira aparição — posicionar as etapas é trabalho de
    // quem tem `crm_stages.position`, não deste módulo.
    expect(etapas.map((e) => e.stageId)).toEqual(["et-2", "et-1"]);

    const et2 = etapa(etapas, "et-2");
    expect(et2.quantidade).toBe(2);
    expect(et2.horasMedia).toBeCloseTo(228, 5);
    expect(et2.horasMediana).toBeCloseTo(228, 5);
    // A amostra à vista: quantos medem por carimbo e quantos por reserva.
    expect(et2.comCarimbo).toBe(1);
    expect(et2.semCarimbo).toBe(1);

    const et1 = etapa(etapas, "et-1");
    expect(et1.quantidade).toBe(3);
    expect(et1.horasMedia).toBeCloseTo(152, 5);
    expect(et1.horasMediana).toBeCloseTo(96, 5);
    expect(et1.comCarimbo).toBe(3);
    expect(et1.semCarimbo).toBe(0);
  });

  it("o agregado também ignora last_activity_at: mesma lista, resultado idêntico", () => {
    const comAtividade = leads.map((l, i) => ({
      ...l,
      // A mais recente possível no caso, e a mais antiga no outro: se a
      // agregação lesse a coluna, os dois relatórios não seriam iguais.
      last_activity_at:
        i % 2 === 0 ? AGORA.toISOString() : "2026-01-01T00:00:00.000Z",
    }));

    expect(agregarPorEtapa(comAtividade, AGORA)).toEqual(
      agregarPorEtapa(leads, AGORA),
    );
  });

  it("sem ninguém na etapa não há linha — e não há média zero", () => {
    expect(agregarPorEtapa([], AGORA)).toEqual([]);
  });
});
