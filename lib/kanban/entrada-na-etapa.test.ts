import { describe, expect, it } from "vitest";

import { compararNaEtapa, posicaoDeEntradaNaEtapa, posicaoNoTopoDaEtapa } from "./entrada-na-etapa";

/**
 * #3461, item 1 — o card recém-chegado entra no TOPO da coluna, e a ordem é
 * ESTÁVEL.
 *
 * A régua da coluna é `position_in_stage` crescente (menor primeiro). Estes
 * testes medem a CONTA, não a tela: a tela lê a mesma coluna e ordena com o
 * mesmo comparador.
 */
describe("posicaoDeEntradaNaEtapa", () => {
  it("etapa vazia mantém o miolo de sempre: 1000 (o DEFAULT da coluna)", () => {
    expect(posicaoDeEntradaNaEtapa(null)).toBe(1000);
  });

  it("entra ACIMA do primeiro card, um passo inteiro", () => {
    expect(posicaoDeEntradaNaEtapa(1000)).toBe(0);
    expect(posicaoDeEntradaNaEtapa(0)).toBe(-1000);
    expect(posicaoDeEntradaNaEtapa(500)).toBe(-500);
  });

  it("dois cards que chegam em sequência nunca empatam, e o segundo fica acima", () => {
    // A coluna: três cards antigos.
    const etapa = [
      { id: "a", position_in_stage: 1000 },
      { id: "b", position_in_stage: 2000 },
      { id: "c", position_in_stage: 3000 },
    ];
    const primeira = () => Math.min(...etapa.map((l) => l.position_in_stage));

    const recemChegado1 = { id: "novo-1", position_in_stage: posicaoDeEntradaNaEtapa(primeira()) };
    etapa.push(recemChegado1);
    const recemChegado2 = { id: "novo-2", position_in_stage: posicaoDeEntradaNaEtapa(primeira()) };
    etapa.push(recemChegado2);

    expect(new Set(etapa.map((l) => l.position_in_stage)).size).toBe(etapa.length);
    expect(etapa.sort(compararNaEtapa).map((l) => l.id)).toEqual([
      "novo-2",
      "novo-1",
      "a",
      "b",
      "c",
    ]);
  });
});

describe("compararNaEtapa", () => {
  it("ordena pela posição", () => {
    const cartas = [
      { id: "c", position_in_stage: 3000 },
      { id: "a", position_in_stage: 1000 },
      { id: "b", position_in_stage: 2000 },
    ];
    expect(cartas.sort(compararNaEtapa).map((l) => l.id)).toEqual(["a", "b", "c"]);
  });

  it("no EMPATE o desempate é o id — a ordem não muda com a ordem de chegada", () => {
    // Dois cards com a MESMA `position_in_stage` (herança do lote antigo): sem
    // desempate eles trocavam de lugar a cada render, porque a ordem devolvida
    // pelo banco não é garantida.
    const um = [
      { id: "zzz", position_in_stage: 1000 },
      { id: "aaa", position_in_stage: 1000 },
      { id: "mmm", position_in_stage: 2000 },
    ];
    const outro = [
      { id: "mmm", position_in_stage: 2000 },
      { id: "aaa", position_in_stage: 1000 },
      { id: "zzz", position_in_stage: 1000 },
    ];
    const esperado = ["aaa", "zzz", "mmm"];
    expect(um.sort(compararNaEtapa).map((l) => l.id)).toEqual(esperado);
    expect(outro.sort(compararNaEtapa).map((l) => l.id)).toEqual(esperado);
  });
});

describe("posicaoNoTopoDaEtapa", () => {
  const card = (id: string, position_in_stage: number) => ({ id, position_in_stage });

  it("etapa vazia: 1000", () => {
    expect(posicaoNoTopoDaEtapa([], "movido")).toBe(1000);
  });

  it("entra acima do MENOR da etapa inteira, fora de ordem na lista", () => {
    expect(posicaoNoTopoDaEtapa([card("c", 3000), card("a", 1000), card("b", 5000)], "movido")).toBe(0);
  });

  it("ignora o próprio card", () => {
    expect(posicaoNoTopoDaEtapa([card("movido", -9000), card("a", 1000)], "movido")).toBe(0);
  });
});
