/**
 * QUEM CONDUZ APARECE NO CARD DA GRADE (#3067).
 *
 * O responsável adicional ocupa a agenda: o bloco onde ele conduz também fica
 * marcado, com uma linha visível e o nome no rótulo acessível. Sem adicional,
 * nada muda.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { GradeDaAgenda } from "./GradeDaAgenda";
import type { Agendamento, Pessoa } from "./tipos";

const QUARTA = new Date("2026-09-16T12:00:00-03:00");
const CAIO = "11111111-1111-4111-8111-111111111111";
const ANA = "22222222-2222-4222-8222-222222222222";
const BRUNO = "33333333-3333-4333-8333-333333333333";
const DE_FORA = "44444444-4444-4444-8444-444444444444";

const pessoas: Pessoa[] = [
  { id: CAIO, nome: "Caio", trilha: 1 },
  { id: ANA, nome: "Ana", trilha: 2 },
  { id: BRUNO, nome: "Bruno", trilha: 3 },
];

function agendamento(over: Partial<Agendamento> = {}): Agendamento {
  return {
    id: "a1",
    titulo: "Reunião estratégica",
    responsavelId: CAIO,
    comeca: "2026-09-16T13:00:00-03:00",
    termina: "2026-09-16T14:00:00-03:00",
    origem: "ui",
    situacao: "confirmed",
    ...over,
  };
}

function grade(lista: Agendamento[]) {
  return render(
    <GradeDaAgenda
      visao="semana"
      ancora={QUARTA}
      agora={QUARTA}
      fuso="America/Sao_Paulo"
      agendamentos={lista}
      pessoas={pessoas}
    />,
  );
}

describe("responsáveis adicionais no card da grade", () => {
  it("card de 60 min com adicional mostra a linha com o nome", () => {
    grade([agendamento({ responsaveis: [ANA] })]);

    const linha = screen.getByTestId("responsaveis-do-compromisso-a1");
    expect(linha.textContent).toContain("Conduz com:");
    expect(linha.textContent).toContain("Ana");
  });

  it("sem adicional não há a linha", () => {
    grade([agendamento()]);

    expect(screen.queryByTestId("responsaveis-do-compromisso-a1")).toBeNull();
  });

  it("id fora da equipe não aparece", () => {
    grade([agendamento({ responsaveis: [ANA, DE_FORA] })]);

    const linha = screen.getByTestId("responsaveis-do-compromisso-a1");
    expect(linha.textContent).toContain("Ana");
    expect(linha.textContent).not.toContain(DE_FORA);
  });

  it("card de 30 min: sem linha, mas o aria-label leva o nome", () => {
    grade([
      agendamento({
        termina: "2026-09-16T13:30:00-03:00",
        responsaveis: [ANA],
      }),
    ]);

    expect(screen.queryByTestId("responsaveis-do-compromisso-a1")).toBeNull();
    const card = screen.getByTestId("agendamento-a1");
    expect(card.getAttribute("aria-label")).toContain("conduz com");
    expect(card.getAttribute("aria-label")).toContain("Ana");
  });

  it("adicional + convidado em 60 min: aparece só a de quem conduz", () => {
    grade([
      agendamento({
        responsaveis: [ANA],
        convidadosDaEquipe: [BRUNO],
      }),
    ]);

    expect(screen.getByTestId("responsaveis-do-compromisso-a1")).toBeInTheDocument();
    expect(screen.queryByTestId("convidados-do-compromisso-a1")).toBeNull();
  });

  it("adicional + convidado em 90 min: aparecem as duas linhas", () => {
    grade([
      agendamento({
        termina: "2026-09-16T14:30:00-03:00",
        responsaveis: [ANA],
        convidadosDaEquipe: [BRUNO],
      }),
    ]);

    expect(screen.getByTestId("responsaveis-do-compromisso-a1")).toBeInTheDocument();
    expect(screen.getByTestId("convidados-do-compromisso-a1")).toBeInTheDocument();
  });
});
