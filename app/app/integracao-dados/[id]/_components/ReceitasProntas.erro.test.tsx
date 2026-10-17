/**
 * Teste do ramo de erro de ReceitasProntas (P2 da CI #3).
 *
 * Living System, item 1: nunca silêncio. Quando a query falha, a tela deve
 * mostrar uma mensagem legível com botão "Tentar de novo", e "Carregando…"
 * deve sumir.
 */
import { describe, expect, it, vi } from "vitest";

import { render, screen } from "@testing-library/react";

vi.mock("@/hooks/external-db/useReceitasDaConexao", () => ({
  useReceitasDaConexao: vi.fn(),
}));

import ReceitasProntas from "./ReceitasProntas";
import { useReceitasDaConexao } from "@/hooks/external-db/useReceitasDaConexao";

const mockUseReceitas = useReceitasDaConexao as ReturnType<typeof vi.fn>;

function renderReceitasProntas(query: { isError: boolean; data: unknown; refetch: () => void }) {
  mockUseReceitas.mockReturnValue(query);
  return render(<ReceitasProntas connectionId="conn-1" motor="mysql" canWrite={true} />);
}

describe("ReceitasProntas — erro na leitura", () => {
  it("query com erro: mostra mensagem e 'Tentar de novo', 'Carregando…' some", () => {
    renderReceitasProntas({
      isError: true,
      data: undefined,
      refetch: vi.fn(),
    });

    expect(screen.getByText("Não foi possível carregar as receitas.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /tentar de novo/i })).toBeInTheDocument();
    expect(screen.queryByText("Carregando receitas…")).not.toBeInTheDocument();
  });
});
