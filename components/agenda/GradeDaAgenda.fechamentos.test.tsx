/**
 * A FAIXA FECHADA NA GRADE — "Dias fora da rotina" desenhado onde se olha.
 *
 * Pedido real numa instalação em 02/11/2026: o dono fechou 14h–15h numa tarde e
 * perguntou se aquilo apareceria marcado com alguma cor na Agenda. Não aparecia: o
 * fechamento só existia na lista das configurações e na AUSÊNCIA de horários, e
 * a grade mostrava o mesmo vazio de sempre.
 *
 * O que estes casos fixam:
 *   1. a faixa cai na hora certa (posição e altura na régua de 48px/h);
 *   2. dia inteiro cobre a janela desenhada (07h–22h), recortado nela;
 *   3. um fechamento noutro fuso é RECORTADO pelas bordas do dia da grade, e um
 *      "dia todo" em Tóquio vira dois pedaços em São Paulo;
 *   4. a faixa não intercepta o ponteiro e fica ABAIXO dos cards;
 *   5. com duas pessoas, ela diz de quem é;
 *   6. a visão de mês também diz que o dia (ou a faixa) está fechado.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { FechamentoDaGrade } from "@/lib/agenda/fechamentos-na-grade";

import { GradeDaAgenda } from "./GradeDaAgenda";
import type { Agendamento, Pessoa } from "./tipos";

const SP = "America/Sao_Paulo";
const QUARTA = new Date("2026-11-04T12:00:00-03:00");
const ANA: Pessoa = { id: "ana", nome: "Ana", trilha: 1 };
const BRUNO: Pessoa = { id: "bruno", nome: "Bruno", trilha: 2 };

/** 14:00–15:30 de São Paulo na terça, 03/11. */
const PARCIAL: FechamentoDaGrade = {
  id: "parcial",
  responsavelId: "ana",
  comeca: "2026-11-03T17:00:00.000Z",
  termina: "2026-11-03T18:30:00.000Z",
  motivo: "Banco",
};
/** A quinta, 05/11, inteira em São Paulo. */
const DIA_TODO: FechamentoDaGrade = {
  id: "dia-todo",
  responsavelId: "ana",
  comeca: "2026-11-05T03:00:00.000Z",
  termina: "2026-11-06T03:00:00.000Z",
  motivo: null,
};

function grade(
  fechamentos: FechamentoDaGrade[],
  opcoes: { pessoas?: Pessoa[]; agendamentos?: Agendamento[]; visao?: "semana" | "mes" } = {},
) {
  return render(
    <GradeDaAgenda
      visao={opcoes.visao ?? "semana"}
      ancora={QUARTA}
      agora={new Date("2026-11-01T12:00:00-03:00")}
      fuso={SP}
      agendamentos={opcoes.agendamentos ?? []}
      fechamentos={fechamentos}
      pessoas={opcoes.pessoas ?? [ANA]}
    />,
  );
}

const coluna = (dia: string) => within(screen.getByTestId(`coluna-dia-${dia}`));

describe("a faixa fechada na semana", () => {
  it("cai na hora certa, com o motivo, só na coluna do dia", () => {
    grade([PARCIAL]);
    const faixa = coluna("2026-11-03").getByTestId("fechamento-parcial");
    // 48px por hora, a grade começa às 07h: 14:00 → 7h × 48 = 336px; 1h30 → 72px.
    expect(faixa.style.top).toBe("336px");
    expect(faixa.style.height).toBe("72px");
    expect(faixa).toHaveTextContent("Fechado · Banco");
    expect(faixa).toHaveTextContent("14:00–15:30");
    expect(screen.getAllByTestId("fechamento-parcial")).toHaveLength(1);
  });

  it("o dia inteiro cobre a janela desenhada, recortado nas 07h–22h", () => {
    grade([DIA_TODO]);
    const faixa = coluna("2026-11-05").getByTestId("fechamento-dia-todo");
    expect(faixa.style.top).toBe("0px");
    // 07h às 22h = 15 horas × 48px.
    expect(faixa.style.height).toBe("720px");
    expect(faixa).toHaveTextContent("Fechado");
    expect(faixa).toHaveTextContent("o dia todo");
  });

  it("um 'dia todo' de outro fuso vira dois pedaços, um em cada dia da grade", () => {
    // 03/11 inteiro em Tóquio = 02/11 12:00 → 03/11 12:00 em São Paulo.
    grade([{ ...DIA_TODO, id: "toquio", comeca: "2026-11-02T15:00:00.000Z", termina: "2026-11-03T15:00:00.000Z" }]);
    const segunda = coluna("2026-11-02").getByTestId("fechamento-toquio");
    const terca = coluna("2026-11-03").getByTestId("fechamento-toquio");
    // Segunda: das 12h ao fim da janela (22h) — 5h × 48 = 240px de topo, 10h de altura.
    expect([segunda.style.top, segunda.style.height]).toEqual(["240px", "480px"]);
    // Terça: do começo da janela (07h) às 12h.
    expect([terca.style.top, terca.style.height]).toEqual(["0px", "240px"]);
  });

  it("fechamento todo fora da janela desenhada não vira faixa de altura zero", () => {
    // 22:30–23:30 em São Paulo: depois da última hora da grade.
    grade([{ ...PARCIAL, comeca: "2026-11-04T01:30:00.000Z", termina: "2026-11-04T02:30:00.000Z" }]);
    expect(screen.queryByTestId("fechamento-parcial")).toBeNull();
  });

  it("não intercepta o ponteiro e fica ABAIXO do card que já estava marcado ali", () => {
    const card: Agendamento = {
      id: "c1",
      titulo: "Consulta",
      responsavelId: "ana",
      comeca: "2026-11-03T17:00:00.000Z",
      termina: "2026-11-03T17:45:00.000Z",
      origem: "ui",
      situacao: "confirmed",
    };
    grade([PARCIAL], { agendamentos: [card] });
    const faixa = coluna("2026-11-03").getByTestId("fechamento-parcial");
    const bloco = coluna("2026-11-03").getByTestId("agendamento-c1");
    expect(faixa.className).toContain("pointer-events-none");
    // Mesmo contexto, sem z-index: quem vem DEPOIS no DOM pinta por cima.
    expect(faixa.compareDocumentPosition(bloco) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("com duas pessoas na grade, a faixa diz de quem é o fechamento", () => {
    grade([PARCIAL], { pessoas: [ANA, BRUNO] });
    expect(coluna("2026-11-03").getByTestId("fechamento-parcial")).toHaveTextContent("Fechado · Ana · Banco");
  });

  it("com uma pessoa só, o nome não aparece (todo fechamento é dela)", () => {
    grade([PARCIAL]);
    expect(coluna("2026-11-03").getByTestId("fechamento-parcial")).not.toHaveTextContent("Ana");
  });
});

describe("a faixa fechada no mês", () => {
  it("a célula do dia diz que está fechado, com a faixa quando é só uma parte", () => {
    grade([PARCIAL, DIA_TODO], { visao: "mes" });
    expect(within(screen.getByTestId("celula-mes-2026-11-03")).getByTestId("fechamento-mes-parcial")).toHaveTextContent(
      "14:00–15:30 Fechado",
    );
    expect(within(screen.getByTestId("celula-mes-2026-11-05")).getByTestId("fechamento-mes-dia-todo")).toHaveTextContent(
      /^Fechado$/,
    );
    expect(within(screen.getByTestId("celula-mes-2026-11-04")).queryByTestId(/^fechamento-mes-/)).toBeNull();
  });
});
