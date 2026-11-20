/**
 * TOKENS DE API: A COLUNA "STATUS" SEGUE O IDIOMA.
 *
 * O cabeçalho estava escrito direto no JSX (`<TableHead>Status</TableHead>`),
 * enquanto as colunas vizinhas (Nome, Prefixo, Escopos, Expira) já passavam por
 * `t()`. Em espanhol, só ele ficava em português. O caso monta a tela em
 * espanhol e em português e confere o cabeçalho pelo papel de coluna.
 * O hook de dados devolve um token de exemplo, só para a tabela aparecer: o
 * que se mede é o cabeçalho.
 */
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { ApiTokensClient } from "@/app/app/settings/api-tokens/_components/ApiTokensClient";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

vi.mock("@/hooks/team/useApiTokens", () => ({
  useApiTokens: () => ({
    isLoading: false,
    data: {
      data: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          name: "Integração de teste",
          prefix: "dsk_abc123",
          scopes: ["contacts:read"],
          last_used_at: null,
          expires_at: null,
          revoked_at: null,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    },
  }),
  useCreateApiToken: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRevokeApiToken: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));

function noIdioma(locale: "pt-BR" | "es") {
  return render(createElement(IdiomaProvider, { locale, children: <ApiTokensClient /> }));
}

afterEach(cleanup);

describe("Tokens de API › cabeçalhos da tabela", () => {
  it("em espanhol, a coluna Status aparece como Estado", () => {
    noIdioma("es");
    expect(screen.getByRole("columnheader", { name: "Estado" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Status" })).toBeNull();
  });

  it("em português, a coluna continua Status", () => {
    noIdioma("pt-BR");
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeInTheDocument();
  });
});
