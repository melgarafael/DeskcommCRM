/**
 * #4123 — a régua do aviso de "contexto caro" do painel de Uso de IA.
 *
 * O aviso só existe se o número medido justificar: nada de acusar um agente por
 * duas chamadas grandes (piso de amostra) nem por um pico isolado (limite de
 * 20% da fatia). E falha de medição não vira aviso — nem vira silêncio
 * disfarçado de "está tudo bem": `medido: false` é o que a tela recebe.
 */
import { describe, expect, it } from "vitest";

import {
  avaliarContextoCaro,
  FATIA_DE_CHAMADAS_QUE_AVISA,
  MINIMO_DE_CHAMADAS_MEDIDAS,
  PROPOSITOS_DE_TURNO,
} from "@/lib/ai/usage/agente-caro";

describe("avaliarContextoCaro", () => {
  it("sem medição não há aviso — e o resultado diz que não foi medido", () => {
    const aviso = avaliarContextoCaro(null);
    expect(aviso).toEqual({
      medido: false,
      chamadas: 0,
      acima_do_limite: 0,
      fatia: 0,
      percentual: 0,
      avisa: false,
    });
  });

  it("amostra pequena não avisa, mesmo com metade das chamadas acima do limite", () => {
    const aviso = avaliarContextoCaro({ chamadas: MINIMO_DE_CHAMADAS_MEDIDAS - 1, acima_do_limite: 9 });
    expect(aviso.medido).toBe(false);
    expect(aviso.avisa).toBe(false);
    expect(aviso.fatia).toBeCloseTo(9 / (MINIMO_DE_CHAMADAS_MEDIDAS - 1), 10);
  });

  it("fatia acima do limite, com amostra suficiente, avisa e traz o número medido", () => {
    const aviso = avaliarContextoCaro({ chamadas: 100, acima_do_limite: 34 });
    expect(aviso.medido).toBe(true);
    expect(aviso.avisa).toBe(true);
    expect(aviso.percentual).toBe(34);
    expect(aviso.chamadas).toBe(100);
    expect(aviso.acima_do_limite).toBe(34);
  });

  it("exatamente no limite não avisa — o corte é \"acima de\"", () => {
    const chamadas = 100;
    const acima = Math.round(chamadas * FATIA_DE_CHAMADAS_QUE_AVISA);
    const aviso = avaliarContextoCaro({ chamadas, acima_do_limite: acima });
    expect(aviso.fatia).toBe(FATIA_DE_CHAMADAS_QUE_AVISA);
    expect(aviso.avisa).toBe(false);
  });

  it("agente sem turno no período não avisa nem divide por zero", () => {
    const aviso = avaliarContextoCaro({ chamadas: 0, acima_do_limite: 0 });
    expect(aviso.fatia).toBe(0);
    expect(aviso.avisa).toBe(false);
  });

  it("contagem de cima nunca passa a de baixo (dado truncado não inventa fatia > 100%)", () => {
    const aviso = avaliarContextoCaro({ chamadas: 30, acima_do_limite: 45 });
    expect(aviso.acima_do_limite).toBe(30);
    expect(aviso.fatia).toBe(1);
  });
});

describe("os propósitos que contam como turno", () => {
  it("são os mesmos dois de `fn_uso_de_ia`", () => {
    // A migration 9097 conta o follow-up como turno; um aviso que só olhasse
    // `agent_turn` mediria um denominador diferente do cartão de turnos.
    expect([...PROPOSITOS_DE_TURNO]).toEqual(["agent_turn", "followup_turn"]);
  });
});
