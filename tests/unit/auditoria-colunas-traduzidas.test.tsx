/**
 * AUDITORIA: AS COLUNAS "ID DA REQUISIÇÃO" E "METADADOS" SEGUEM O IDIOMA (#4819).
 *
 * Os dois cabeçalhos estavam escritos direto no JSX, em inglês, enquanto as
 * quatro colunas vizinhas já passavam por `t()`. O caso monta a tela em
 * espanhol e em português e confere os dois cabeçalhos pelo papel de coluna.
 * O hook de dados devolve lista vazia: o que se mede é só o cabeçalho.
 */
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { AuditClient } from "@/app/app/audit/_client";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

vi.mock("@/hooks/audit/useAuditQuery", () => ({
  useAuditQuery: () => ({
    data: { pages: [{ data: [] }] },
    isLoading: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  }),
}));

function noIdioma(locale: "pt-BR" | "es") {
  return render(createElement(IdiomaProvider, { locale, children: <AuditClient /> }));
}

afterEach(cleanup);

describe("Auditoria › cabeçalhos da tabela", () => {
  it("em espanhol, as duas colunas aparecem traduzidas", () => {
    noIdioma("es");
    expect(screen.getByRole("columnheader", { name: "ID de la solicitud" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Metadatos" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Request ID" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Metadata" })).toBeNull();
  });

  it("em português, as duas colunas aparecem em português", () => {
    noIdioma("pt-BR");
    expect(screen.getByRole("columnheader", { name: "ID da requisição" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Metadados" })).toBeInTheDocument();
  });
});
