/**
 * Conexão em "só o que eu marcar" nasce com nada liberado, e o catálogo chega
 * vazio. Dizer "Este banco não tem tabelas visíveis." logo abaixo do painel que
 * lista as tabelas do banco contradizia a tela (prova pela tela do #2635).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { ExploradorDeDados } from "./ExploradorDeDados";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/hooks/external-db/useCatalogoExterno", () => ({
  useCatalogoExterno: () => ({ data: [], isLoading: false, isError: false, isSuccess: true }),
}));
vi.mock("@/hooks/external-db/useDadosExternos", () => ({
  useDadosExternos: () => ({ data: undefined, isLoading: false, isError: false }),
}));

const NADA_LIBERADO =
  "Nenhuma tabela liberada ainda. Marque acima, em “O que o assistente pode ver”, as que podem ser lidas.";

describe("ExploradorDeDados — catálogo vazio", () => {
  it("em modo lista, diz que nada foi liberado e aponta o painel", () => {
    render(<ExploradorDeDados connectionId="conn-1" soLiberadas />);
    expect(screen.getByText(NADA_LIBERADO)).toBeTruthy();
    expect(screen.queryByText("Este banco não tem tabelas visíveis.")).toBeNull();
  });

  it("fora do modo lista, o banco vazio continua dito como vazio", () => {
    render(<ExploradorDeDados connectionId="conn-1" />);
    expect(screen.getByText("Este banco não tem tabelas visíveis.")).toBeTruthy();
    expect(screen.queryByText(NADA_LIBERADO)).toBeNull();
  });
});
