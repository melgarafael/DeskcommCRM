/**
 * COMPROMISSO COM ADICIONAL APARECE NA LINHA DE QUEM CONDUZ (#3067).
 *
 * No quadro por profissional, o agendamento entra na linha do responsável
 * principal E na de cada adicional — e não na de quem não conduz.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { QuadroPorProfissional } from "./QuadroPorProfissional";
import type { Agendamento, Pessoa } from "./tipos";

const DIA = new Date("2026-09-16T12:00:00-03:00");
const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const P3 = "33333333-3333-4333-8333-333333333333";

const pessoas: Pessoa[] = [
  { id: P1, nome: "Ana", trilha: 1 },
  { id: P2, nome: "Bruno", trilha: 2 },
  { id: P3, nome: "Caio", trilha: 3 },
];

function agendamento(over: Partial<Agendamento> = {}): Agendamento {
  return {
    id: "a1",
    titulo: "Reunião estratégica",
    responsavelId: P1,
    comeca: "2026-09-16T13:00:00-03:00",
    termina: "2026-09-16T14:00:00-03:00",
    origem: "ui",
    situacao: "confirmed",
    ...over,
  };
}

function quadro(lista: Agendamento[]) {
  return render(
    <QuadroPorProfissional
      dia={DIA}
      fuso="America/Sao_Paulo"
      pessoas={pessoas}
      agendamentos={lista}
      livres={{}}
      primeiraHora={7}
      ultimaHora={21}
    />,
  );
}

describe("responsável adicional no quadro por profissional", () => {
  it("aparece na linha do principal e na do adicional", () => {
    quadro([agendamento({ responsaveis: [P2] })]);

    const blocos = screen.getAllByTestId("quadro-agendamento-a1");
    expect(blocos).toHaveLength(2);
    const linhaPrincipal = screen.getByTestId("linha-profissional-" + P1);
    const linhaAdicional = screen.getByTestId("linha-profissional-" + P2);
    expect(linhaPrincipal.querySelector("[data-testid='quadro-agendamento-a1']")).not.toBeNull();
    expect(linhaAdicional.querySelector("[data-testid='quadro-agendamento-a1']")).not.toBeNull();
  });

  it("não aparece na linha de uma terceira pessoa", () => {
    quadro([agendamento({ responsaveis: [P2] })]);

    expect(
      screen.queryByTestId("linha-profissional-" + P3)?.querySelector(
        "[data-testid='quadro-agendamento-a1']",
      ),
    ).toBeNull();
  });

  it("sem adicional aparece só na linha do principal", () => {
    quadro([agendamento()]);

    expect(screen.getByTestId("linha-profissional-" + P1)).toContainElement(
      screen.getByTestId("quadro-agendamento-a1"),
    );
    expect(
      screen.queryByTestId("linha-profissional-" + P2)?.querySelector(
        "[data-testid='quadro-agendamento-a1']",
      ),
    ).toBeNull();
  });
});
