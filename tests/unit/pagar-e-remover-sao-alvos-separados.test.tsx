/**
 * "PAGAR" E "×" SÃO DOIS ALVOS DE 44PX NO CELULAR (ADR-0006, F4).
 *
 * Na lista de lançamentos de Faturamento os dois botões eram texto puro, lado a
 * lado: "Pagar" com 16px de altura e o "×" de remover com uns 8px de largura, a
 * 8px um do outro. No dedo, quem mira em pagar pode apagar o lançamento.
 * Abaixo de `md` cada um passa a ser um quadrado de 44px no mínimo; acima, as
 * classes não valem e a linha é a mesma de sempre.
 *
 * jsdom não calcula layout, então o teste cobra a CLASSE; a geometria (altura,
 * largura e que um não cobre o outro) é medida em
 * `tests/e2e/comercial-no-celular.spec.ts`.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { ListaDeLancamentos, type Lancamento } from "@/app/app/faturamento/_lancamentos";

afterEach(cleanup);

const PENDENTE: Lancamento = {
  id: "l-pendente",
  direction: "out",
  amount_cents: 12000,
  currency: "BRL",
  description: "Aluguel da sala",
  entry_date: "2026-10-10",
  status: "pending",
  origin: "manual",
};

const ALVO_DE_DEDO = ["max-md:inline-flex", "max-md:min-h-11", "max-md:min-w-11"];

describe("pagar e remover no celular", () => {
  it("os dois botões do lançamento pendente têm 44px de piso abaixo de md", () => {
    render(
      <ListaDeLancamentos
        lancamentos={[PENDENTE]}
        contas={[]}
        moeda="BRL"
        podeLancar
        onCriar={vi.fn()}
        onPagar={vi.fn()}
        onRemover={vi.fn()}
      />,
    );

    const pagar = screen.getByTestId("pagar-l-pendente");
    const remover = screen.getByRole("button", { name: "Remover lançamento" });
    for (const botao of [pagar, remover]) {
      for (const classe of ALVO_DE_DEDO) {
        expect(botao.classList.contains(classe), `${botao.textContent} sem ${classe}`).toBe(true);
      }
    }
    // Continuam dois botões separados, não um alvo só.
    expect(pagar).not.toBe(remover);
    expect(remover.classList.contains("ml-2")).toBe(true);
  });
});
