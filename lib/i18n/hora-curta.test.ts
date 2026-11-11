import { describe, expect, it } from "vitest";

import { dataEHoraCompletas, horaCurta } from "./hora-curta";
import { localeDeData } from "./datas";

/**
 * A régua do "quando" curto — a MESMA da linha da Inbox e da última mensagem do
 * card do funil (fatia 1 do #3945).
 *
 * O relógio é passado por parâmetro e as datas são escritas SEM fuso (`Z`):
 * assim o caso mede a régua, não o fuso da máquina que roda a suíte. As três
 * faixas são as do produto — hoje vira HORA, a semana vira DISTÂNCIA, o resto
 * vira DATA — e cada uma tem um caso que a distingue da vizinha.
 */
const PT = localeDeData("pt-BR");
const ES = localeDeData("es");
const AGORA = new Date("2026-11-07T15:00:00");

describe("horaCurta — o quando de uma linha de conversa", () => {
  it("no mesmo dia, a HORA (é o que decide se a pessoa respondeu agora)", () => {
    expect(horaCurta("2026-11-07T09:41:00", PT, AGORA)).toBe("09:41");
  });

  it("dentro da semana, a DISTÂNCIA — não a hora de um dia que já passou", () => {
    const rotulo = horaCurta("2026-11-04T09:41:00", PT, AGORA);
    expect(rotulo).toMatch(/3/);
    expect(rotulo).not.toMatch(/:/);
  });

  it("fora da semana, a DATA curta", () => {
    expect(horaCurta("2026-10-28T09:41:00", PT, AGORA)).toBe("28/10");
  });

  it("em espanhol a distância sai no idioma de quem lê, não em português", () => {
    const emEs = horaCurta("2026-11-04T09:41:00", ES, AGORA);
    expect(emEs).not.toBe(horaCurta("2026-11-04T09:41:00", PT, AGORA));
  });

  it("sem data (ou data inválida) a linha não ganha texto inventado", () => {
    expect(horaCurta(null, PT, AGORA)).toBe("");
    expect(horaCurta(undefined, PT, AGORA)).toBe("");
    expect(horaCurta("não é data", PT, AGORA)).toBe("");
  });
});

describe("dataEHoraCompletas — o detalhe a um hover", () => {
  it("traz o dia que o rótulo curto omite", () => {
    expect(dataEHoraCompletas("2026-10-28T09:41:00", PT)).toBe("28/10/2026 09:41");
  });

  it("sem data, vazio — nunca 'Invalid Date' na tela", () => {
    expect(dataEHoraCompletas(null, PT)).toBe("");
    expect(dataEHoraCompletas("x", PT)).toBe("");
  });
});
