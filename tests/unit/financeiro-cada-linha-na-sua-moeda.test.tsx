import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * LANÇAMENTO E RECORRÊNCIA SÃO ESCRITOS NA MOEDA DA PRÓPRIA LINHA (#1531).
 *
 * `financial_entries.currency` e `recurring_entries.currency` existem desde que
 * o módulo financeiro nasceu, mas as duas listas escreviam todo valor em "BRL"
 * fixo: um lançamento de 50,00 € aparecia como R$ 50,00 — outro número, com o
 * mesmo ar de certo. A linha em real é VERDE também no código anterior, de
 * propósito: ela é a prova de que quem opera só em real não vê diferença.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { ListaDeLancamentos, type Lancamento } from "@/app/app/faturamento/_lancamentos";
import { Recorrencias, type Recorrencia } from "@/app/app/settings/tenant/financeiro/_recorrencias";

/** O `Intl` separa símbolo e número com espaço inseparável; o teste lê espaço. */
const semNbsp = (s: string) => s.replace(/[  ]/g, " ");

function lancamento(id: string, currency: string, description: string): Lancamento {
  return {
    id,
    direction: "in",
    amount_cents: 5000,
    currency,
    description,
    entry_date: "2026-01-10",
    status: "paid",
    origin: "manual",
  };
}

function recorrencia(id: string, currency: string, name: string): Recorrencia {
  return {
    id,
    name,
    account_id: "aaaaaaaa-0000-4000-8000-000000000001",
    direction: "out",
    amount_cents: 5000,
    currency,
    day_of_month: 5,
  };
}

function linhaDe(texto: string): string {
  const alvo = screen.getByText(texto, { exact: false });
  return semNbsp(alvo.closest("tr, li")?.textContent ?? "");
}

describe("lançamentos do período", () => {
  const montar = () =>
    render(
      <ListaDeLancamentos
        lancamentos={[
          lancamento("l-brl", "BRL", "Aluguel da sala"),
          lancamento("l-eur", "EUR", "Material importado"),
        ]}
        contas={[]}
        podeLancar={false}
        onCriar={vi.fn()}
        onPagar={vi.fn()}
        onRemover={vi.fn()}
      />,
    );

  it("o lançamento em real sai em real", () => {
    montar();
    expect(linhaDe("Aluguel da sala")).toContain("+R$ 50,00");
  });

  it("o lançamento em euro sai em euro, e não em real", () => {
    montar();
    const linha = linhaDe("Material importado");
    expect(linha).toContain("+50,00 €");
    expect(linha).not.toContain("R$");
  });
});

describe("lançamentos recorrentes", () => {
  const montar = () =>
    render(
      <Recorrencias
        recorrencias={[
          recorrencia("r-brl", "BRL", "Aluguel"),
          recorrencia("r-eur", "EUR", "Licença anual"),
        ]}
        contas={[]}
        podeEditar={false}
        carregando={false}
        onCriar={vi.fn()}
        onEditar={vi.fn()}
        onInativar={vi.fn()}
      />,
    );

  it("a recorrência em real sai em real", () => {
    montar();
    expect(linhaDe("Aluguel ·")).toContain("R$ 50,00");
  });

  it("a recorrência em euro sai em euro, e não em real", () => {
    montar();
    const linha = linhaDe("Licença anual");
    expect(linha).toContain("50,00 €");
    expect(linha).not.toContain("R$");
  });
});
