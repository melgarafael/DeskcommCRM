/**
 * QUEM É CONVIDADO APARECE NO CARD DO COMPROMISSO (#4006).
 *
 * O compromisso em que a pessoa foi convidada entra na agenda dela pela mesma
 * régua do responsável (`estaNaAgendaDe`), e sem esta linha ele era
 * indistinguível de um compromisso próprio: mesmo bloco, mesma cor da trilha,
 * mesmo silêncio sobre quem mais participa. Quem marcou a reunião para quatro
 * pessoas abria a semana e não via nenhuma delas.
 *
 * O que o teste prova, em jsdom (que não faz layout): a linha existe, com os
 * nomes resolvidos pela lista de pessoas, e o rótulo acessível leva a equipe
 * mesmo no bloco curto demais para desenhar a terceira linha.
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

describe("convidados da equipe no card do compromisso", () => {
  it("mostra o nome de quem foi convidado", () => {
    grade([agendamento({ convidadosDaEquipe: [ANA, BRUNO] })]);

    const linha = screen.getByTestId("convidados-do-compromisso-a1");
    expect(linha.textContent).toContain("Ana");
    expect(linha.textContent).toContain("Bruno");
  });

  it("não desenha a linha quando não há convidado", () => {
    grade([agendamento()]);

    expect(screen.queryByTestId("convidados-do-compromisso-a1")).toBeNull();
  });

  it("id que não é mais da equipe não vira nome inventado", () => {
    grade([agendamento({ convidadosDaEquipe: [ANA, DE_FORA] })]);

    const linha = screen.getByTestId("convidados-do-compromisso-a1");
    expect(linha.textContent).toContain("Ana");
    expect(linha.textContent).not.toContain(DE_FORA);
    expect(linha.textContent?.trim().endsWith(",")).toBe(false);
  });

  it("o rótulo acessível leva a equipe mesmo no bloco curto", () => {
    grade([
      agendamento({
        termina: "2026-09-16T13:30:00-03:00",
        convidadosDaEquipe: [ANA],
      }),
    ]);

    // 30 minutos: cabe o título, não cabe a terceira linha — o leitor de tela
    // continua sabendo com quem é.
    expect(screen.queryByTestId("convidados-do-compromisso-a1")).toBeNull();
    const card = screen.getByTestId("agendamento-a1");
    expect(card.getAttribute("aria-label")).toContain("Ana");
  });
});
