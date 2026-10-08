/**
 * A função pura do #2545 — os casos que o quadro não alcança sozinho.
 *
 * O teste de integração (tests/unit/arrastar-le-o-updated-at-do-cache.test.tsx)
 * mede o `position_in_stage` que sai no POST /move. Aqui ficam as bordas da
 * conta em si, que na tela só aparecem numa combinação difícil de montar:
 * topo da coluna, empate JÁ gravado no banco, empate entre dois visíveis, cache
 * frio e `before` fora do cache.
 *
 * A régua de todas elas é uma só: o valor devolvido, passado ao `midpoint`, não
 * pode ser a posição que outro card da etapa já tem.
 */
import { describe, expect, it } from "vitest";

import { midpoint } from "./fractional-indexing";
import { proximoNaEtapaInteira } from "./vizinho-na-etapa";

type Card = { id: string; position_in_stage: number };

const card = (id: string, pos: number): Card => ({ id, position_in_stage: pos });

const ARRASTADO = "d";

describe("proximoNaEtapaInteira", () => {
  it("sem cache do quadro devolve o vizinho visível de baixo (o after de antes)", () => {
    const abaixo = card("b", 2000);
    expect(proximoNaEtapaInteira(card("a", 1000), abaixo, null, ARRASTADO)).toBe(abaixo);
  });

  it("com o de cima fora do cache devolve o visível de baixo, nunca uma posição nova", () => {
    const abaixo = card("b", 2000);
    // `acima` não está na etapa inteira: cache velho, card recém-criado fora do
    // quadro. A degradação é o comportamento de sempre, não um chute.
    expect(proximoNaEtapaInteira(card("sumiu", 1000), abaixo, [abaixo], ARRASTADO)).toBe(abaixo);
  });

  it("solto no topo devolve o primeiro card da etapa inteira, escondido ou não", () => {
    const primeiro = card("oculto", 500);
    const visivel = card("a", 1000);
    expect(proximoNaEtapaInteira(null, visivel, [primeiro, visivel], ARRASTADO)).toBe(primeiro);
  });

  it("no fim devolve o próximo da etapa inteira depois do de cima", () => {
    const acima = card("a", 1000);
    const oculto = card("b", 2000);
    expect(proximoNaEtapaInteira(acima, null, [acima, oculto], ARRASTADO)).toBe(oculto);
    expect(midpoint(acima.position_in_stage, oculto.position_in_stage)).toBe(1500);
  });

  it("entre dois visíveis devolve o escondido do MEIO, não o visível de baixo", () => {
    // A variante da #2545: A (1000) e C (3000) visíveis, B (2000) escondido.
    // Com o `after` visível, `midpoint(1000, 3000)` = 2000 — a posição de B.
    const acima = card("a", 1000);
    const oculto = card("b", 2000);
    const visivel = card("c", 3000);
    const devolvido = proximoNaEtapaInteira(acima, visivel, [acima, oculto, visivel], ARRASTADO);
    expect(devolvido).toBe(oculto);
    expect(midpoint(acima.position_in_stage, oculto.position_in_stage)).toBe(1500);
  });

  it("card escondido EMPATADO com o de cima é pulado (empate já gravado não vira NaN)", () => {
    const acima = card("a", 1000);
    const empatado = card("empatado", 1000);
    const visivel = card("b", 2000);
    const devolvido = proximoNaEtapaInteira(acima, visivel, [acima, empatado, visivel], ARRASTADO);
    expect(devolvido).toBe(visivel);
    expect(midpoint(acima.position_in_stage, visivel.position_in_stage)).toBe(1500);
  });

  it("empate entre dois VISÍVEIS continua cancelando: devolve o de baixo e o midpoint dá NaN", () => {
    const acima = card("a", 1000);
    const visivelEmpatado = card("b", 1000);
    const devolvido = proximoNaEtapaInteira(
      acima,
      visivelEmpatado,
      [acima, visivelEmpatado],
      ARRASTADO,
    );
    expect(devolvido).toBe(visivelEmpatado);
    expect(midpoint(acima.position_in_stage, visivelEmpatado.position_in_stage)).toBeNaN();
  });

  it("o card arrastado sai da conta (senão o vizinho dele mesmo seria o destino)", () => {
    const acima = card("a", 1000);
    const arrastado = card(ARRASTADO, 1500);
    expect(proximoNaEtapaInteira(acima, null, [acima, arrastado], ARRASTADO)).toBeNull();
  });

  it("etapa sem nenhum outro card devolve null (midpoint(null, null) = 1000, como sempre)", () => {
    expect(proximoNaEtapaInteira(null, null, [card(ARRASTADO, 1000)], ARRASTADO)).toBeNull();
    expect(midpoint(null, null)).toBe(1000);
  });

  it("não reordena a lista do cache: a etapa inteira entra e sai na mesma ordem", () => {
    const etapa = [card("b", 2000), card("a", 1000), card("c", 3000)];
    const antes = etapa.map((l) => l.id);
    proximoNaEtapaInteira(card("a", 1000), null, etapa, ARRASTADO);
    expect(etapa.map((l) => l.id)).toEqual(antes);
  });
});
