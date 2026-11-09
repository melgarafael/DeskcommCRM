/**
 * A geometria do QUADRO POR PROFISSIONAL (#4186), sem DOM.
 *
 * O componente só desenha o que sai daqui; se a conta errar, a tela erra em
 * silêncio — um compromisso começa uma coluna antes, dois carros no mesmo
 * horário viram um, um horário livre aparece na coluna errada. Cada caso abaixo
 * é um desses defeitos possíveis, medido pela saída da função.
 *
 * Fuso fixo de São Paulo (UTC-3, sem horário de verão desde 2019): os instantes
 * dos casos são escritos com o offset explícito para a conta ser legível.
 */
import { describe, expect, it } from "vitest";

import {
  colunasDoQuadro,
  livresPorColuna,
  minutoNoDia,
  posicionarNaLinha,
} from "./quadro-por-profissional";

const FUSO = "America/Sao_Paulo";
const DIA = "2026-09-16";

describe("colunasDoQuadro", () => {
  it("cobre da primeira hora até o FIM da última, no passo pedido", () => {
    const colunas = colunasDoQuadro(8, 9, 30);
    expect(colunas.map((c) => c.rotulo)).toEqual(["08:00", "08:30", "09:00", "09:30"]);
    expect(colunas.map((c) => c.cheia)).toEqual([true, false, true, false]);
  });

  it("muda de largura com o passo — 15 min dá o dobro de colunas de 30", () => {
    expect(colunasDoQuadro(7, 21, 15)).toHaveLength(colunasDoQuadro(7, 21, 30).length * 2);
    expect(colunasDoQuadro(7, 21, 60)).toHaveLength(15);
  });
});

describe("minutoNoDia", () => {
  it("lê a hora de parede no fuso da agenda, não em UTC", () => {
    expect(minutoNoDia(new Date("2026-09-16T08:30:00-03:00"), DIA, FUSO)).toBe(8 * 60 + 30);
  });

  it("prende antes do dia em 0 e depois do dia em 1440", () => {
    expect(minutoNoDia(new Date("2026-09-15T23:00:00-03:00"), DIA, FUSO)).toBe(0);
    expect(minutoNoDia(new Date("2026-09-17T01:00:00-03:00"), DIA, FUSO)).toBe(24 * 60);
  });
});

describe("posicionarNaLinha", () => {
  const colunas = colunasDoQuadro(8, 11, 30); // 08:00 … 11:30, 8 colunas

  const pedaco = (item: string, de: string, ate: string) => ({
    item,
    comeca: `${DIA}T${de}:00-03:00`,
    termina: `${DIA}T${ate}:00-03:00`,
  });

  it("começa na coluna do horário e ocupa as colunas da duração", () => {
    const { posicoes, faixas } = posicionarNaLinha(
      [pedaco("revisao", "09:00", "10:30")],
      colunas,
      30,
      DIA,
      FUSO,
    );
    expect(faixas).toBe(1);
    expect(posicoes).toEqual([{ item: "revisao", coluna: 2, colunas: 3, faixa: 0 }]);
  });

  it("empilha em faixas diferentes os que se encavalam — dois carros às 8h aparecem os dois", () => {
    const { posicoes, faixas } = posicionarNaLinha(
      [pedaco("carro-1", "08:00", "08:30"), pedaco("carro-2", "08:00", "09:00"), pedaco("carro-3", "09:00", "09:30")],
      colunas,
      30,
      DIA,
      FUSO,
    );
    expect(faixas).toBe(2);
    const porItem = Object.fromEntries(posicoes.map((p) => [p.item, p]));
    expect(porItem["carro-1"]!.faixa).not.toBe(porItem["carro-2"]!.faixa);
    // O terceiro começa quando os dois acabaram: volta para a primeira faixa livre.
    expect(porItem["carro-3"]!.faixa).toBe(0);
  });

  it("recorta nas bordas da janela e descarta o que fica inteiro fora dela", () => {
    const { posicoes } = posicionarNaLinha(
      [pedaco("cedo", "07:00", "08:30"), pedaco("noite", "19:00", "20:00")],
      colunas,
      30,
      DIA,
      FUSO,
    );
    expect(posicoes).toEqual([{ item: "cedo", coluna: 0, colunas: 1, faixa: 0 }]);
  });

  it("um compromisso de 10 minutos não some: ocupa ao menos uma coluna", () => {
    const { posicoes } = posicionarNaLinha([pedaco("rapido", "10:10", "10:20")], colunas, 30, DIA, FUSO);
    expect(posicoes).toEqual([{ item: "rapido", coluna: 4, colunas: 1, faixa: 0 }]);
  });

  it("de outro dia não entra na linha deste dia", () => {
    const { posicoes } = posicionarNaLinha(
      [{ item: "ontem", comeca: "2026-09-15T09:00:00-03:00", termina: "2026-09-15T10:00:00-03:00" }],
      colunas,
      30,
      DIA,
      FUSO,
    );
    expect(posicoes).toEqual([]);
  });
});

describe("livresPorColuna", () => {
  const colunas = colunasDoQuadro(8, 9, 30); // 08:00 08:30 09:00 09:30

  it("põe cada horário do motor na coluna em que ele começa, com o rótulo do horário", () => {
    const oferta = livresPorColuna(
      [
        { instante: "2026-09-16T08:45:00-03:00", rotulo: "08:45" },
        { instante: "2026-09-16T09:30:00-03:00", rotulo: "09:30" },
      ],
      colunas,
      30,
      DIA,
      FUSO,
    );
    expect(oferta.map((o) => o?.rotulo ?? null)).toEqual([null, "08:45", null, "09:30"]);
  });

  it("com dois na mesma coluna, a coluna oferece o mais cedo", () => {
    const oferta = livresPorColuna(
      [
        { instante: "2026-09-16T08:15:00-03:00", rotulo: "08:15" },
        { instante: "2026-09-16T08:00:00-03:00", rotulo: "08:00" },
      ],
      colunas,
      30,
      DIA,
      FUSO,
    );
    expect(oferta[0]?.rotulo).toBe("08:00");
  });

  it("ignora horário de outro dia e fora da janela — o quadro não oferece o que não desenha", () => {
    const oferta = livresPorColuna(
      [
        { instante: "2026-09-17T08:00:00-03:00", rotulo: "08:00" },
        { instante: "2026-09-16T14:00:00-03:00", rotulo: "14:00" },
      ],
      colunas,
      30,
      DIA,
      FUSO,
    );
    expect(oferta.every((o) => o === null)).toBe(true);
  });
});
