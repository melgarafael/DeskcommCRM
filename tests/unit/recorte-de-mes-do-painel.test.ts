import { describe, expect, it } from "vitest";

import {
  distanciaEmMeses,
  mesDaChave,
  mesDoGrid,
  mesSeguinte,
} from "../e2e/helpers/agenda-mes-com-vaga";

/**
 * O mês do painel é LIDO da grade desenhada — e essa leitura é aritmética pura,
 * então é aqui que ela se prova, sem navegador.
 *
 * O caso que importa é o do trace de 2026-10-30 (job 124255171221): a grade de
 * outubro começa em 27 DE SETEMBRO, e o cabeçalho dizia "outubro de 2026". Quem
 * lesse a primeira célula como "o mês em tela" acharia setembro e avançaria o
 * mês errado — que é o defeito, um passo ao lado.
 */
describe("mês que o mini-calendário está desenhando", () => {
  it("outubro de 2026 começa na grade em 27/09, e o mês em tela é OUTUBRO", () => {
    expect(mesDoGrid("2026-09-27")).toBe("2026-10");
  });

  it("quando o dia 1º cai no domingo, a primeira célula já é o mês em tela", () => {
    // 01/11/2026 é domingo — o caso do dia seguinte ao da falha medida.
    expect(mesDoGrid("2026-11-01")).toBe("2026-11");
  });

  it("caminha até sete dias: agosto de 2026 começa na grade em 26/07", () => {
    expect(mesDoGrid("2026-07-26")).toBe("2026-08");
  });

  it("atravessa o ano sem perder o mês", () => {
    // Janeiro de 2027 começa numa sexta: a grade abre em 27/12/2026.
    expect(mesDoGrid("2026-12-27")).toBe("2027-01");
  });

  it("não confunde a ponta do mês seguinte com o mês em tela", () => {
    // O calendário desenha 01/12 em novembro; o mês em tela continua novembro.
    expect(mesDaChave("2026-12-01")).toBe("2026-12");
    expect(mesDoGrid("2026-11-01")).toBe("2026-11");
  });
});

describe("navegação entre meses", () => {
  it("conta meses inteiros nos dois sentidos", () => {
    expect(distanciaEmMeses("2026-10", "2026-11")).toBe(1);
    expect(distanciaEmMeses("2026-10", "2026-08")).toBe(-2);
    expect(distanciaEmMeses("2026-10", "2026-10")).toBe(0);
  });

  it("atravessa a virada do ano", () => {
    expect(distanciaEmMeses("2026-12", "2027-01")).toBe(1);
    expect(mesSeguinte("2026-12")).toBe("2027-01");
    expect(mesSeguinte("2026-10")).toBe("2026-11");
  });
});
