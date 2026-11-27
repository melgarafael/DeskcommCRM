import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { QuemConduz } from "./QuemConduz";
import type { Pessoa } from "./tipos";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

const A: Pessoa = { id: "a-111", nome: "Ana", trilha: 1 };
const B: Pessoa = { id: "b-222", nome: "Bruno", trilha: 2 };
const C: Pessoa = { id: "c-333", nome: "Carla", trilha: 3 };

function renderizar(pessoas: Pessoa[], principalId: string | null, selecionados: string[]) {
  const onChange = vi.fn();
  render(<QuemConduz pessoas={pessoas} principalId={principalId} selecionados={selecionados} onChange={onChange} />);
  return onChange;
}

describe("QuemConduz (#3067)", () => {
  it("mostra o principal com 'principal' e o contador '1 de 10'", () => {
    renderizar([A, B, C], A.id, []);
    expect(screen.getByTestId("quem-conduz-principal")).toHaveTextContent("Ana · principal");
    expect(screen.getByTestId("quem-conduz-contador")).toHaveTextContent("1 de 10");
  });

  it("o seletor não oferece o principal nem quem já foi escolhido", () => {
    renderizar([A, B, C], A.id, [B.id]);
    const valores = Array.from(screen.getByTestId("quem-conduz-adicionar").querySelectorAll("option")).map(
      (o) => o.value,
    );
    expect(valores).not.toContain(A.id);
    expect(valores).not.toContain(B.id);
    expect(valores).toContain(C.id);
  });

  it("escolher B chama onChange([id de B])", async () => {
    const onChange = renderizar([A, B, C], A.id, []);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId("quem-conduz-adicionar"), B.id);
    expect(onChange).toHaveBeenCalledWith([B.id]);
  });

  it("clicar em 'Retirar B' chama onChange([])", () => {
    const onChange = renderizar([A, B, C], A.id, [B.id]);
    screen.getByRole("button", { name: /Retirar Bruno/ }).click();
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("com 9 adicionais o seletor some (11 pessoas) e o contador mostra '10 de 10'", () => {
    const outros = Array.from({ length: 10 }, (_, i) => ({ id: `p-${i}`, nome: `Pessoa ${i}`, trilha: 1 as const }));
    const pessoas = [A, ...outros];
    const selecionados = pessoas.slice(1, 10).map((p) => p.id); // 9 adicionais
    renderizar(pessoas, A.id, selecionados);
    expect(screen.queryByTestId("quem-conduz-adicionar")).not.toBeInTheDocument();
    expect(screen.getByTestId("quem-conduz-contador")).toHaveTextContent("10 de 10");
  });

  it("id escolhido que é o principal não vira pílula nem entra na contagem", () => {
    renderizar([A, B, C], A.id, [A.id, B.id]);
    expect(screen.queryByRole("button", { name: /Retirar Ana/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retirar Bruno/ })).toBeInTheDocument();
    expect(screen.getByTestId("quem-conduz-contador")).toHaveTextContent("2 de 10");
  });

  it("com aviso, mostra o texto no quem-conduz-aviso", () => {
    renderizar([A, B, C], A.id, []);
    const onChange = vi.fn(); // renderizar já renderiza; re-render com aviso
    render(<QuemConduz pessoas={[A]} principalId={A.id} selecionados={[]} onChange={onChange} aviso="Sessão coletiva: aviso de teste." />);
    expect(screen.getByTestId("quem-conduz-aviso")).toHaveTextContent("Sessão coletiva: aviso de teste.");
  });

  it("sem aviso, não há quem-conduz-aviso", () => {
    renderizar([A, B, C], A.id, []);
    expect(screen.queryByTestId("quem-conduz-aviso")).not.toBeInTheDocument();
  });
});
