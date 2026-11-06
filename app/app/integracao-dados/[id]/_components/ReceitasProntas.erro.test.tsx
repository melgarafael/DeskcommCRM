/**
 * Receitas prontas — o ramo de ERRO da tela.
 *
 * Living System, item 1: nunca silêncio. Quando a query falha, a tela deve
 * mostrar uma mensagem legível com botão "Tentar de novo", e "Carregando…"
 * deve sumir.
 *
 * E o 422 da gravação: a rota devolve `details.fieldErrors` com o CAMINHO do
 * campo que falhou ("esconder.meta_key", "esconder.valores"), e a tela mostra
 * o RÓTULO legível desse caminho ("Campo a esconder", "Valores a esconder") —
 * nunca o caminho cru, que não diz nada para quem opera.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { act, render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { toast } from "sonner";
import { ApiError } from "@/lib/api/types";

vi.mock("@/hooks/external-db/useReceitasDaConexao", () => ({
  useReceitasDaConexao: vi.fn(),
  salvarReceitas: vi.fn(),
  previewReceita: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

import ReceitasProntas from "./ReceitasProntas";
import { salvarReceitas, useReceitasDaConexao } from "@/hooks/external-db/useReceitasDaConexao";
import type { InstanciaDeReceita } from "@/lib/external-db/receitas/tipos";

const mockUseReceitas = useReceitasDaConexao as ReturnType<typeof vi.fn>;
const mockSalvar = salvarReceitas as ReturnType<typeof vi.fn>;

const INSTANCIA_WORDPRESS: InstanciaDeReceita = {
  id: "inst-wp-1",
  receita: "wordpress-conteudo",
  rotulo: "Meus imóveis",
  descricao: "Imóveis publicados",
  fixos: {
    prefixo: "wp_",
    post_type: "imovel",
    campos: [
      { chave: "preco", rotulo: "Preço de venda", meta_key: "preco", tipo: "preco", filtro: "maximo" },
    ],
    categorias: [],
    esconder: { meta_key: "status_imovel", valores: ["vendido"] },
  },
  ativa: true,
};

function renderReceitasProntas(query: {
  isError: boolean;
  data: { receitas: InstanciaDeReceita[] } | undefined;
  refetch: () => void;
}) {
  mockUseReceitas.mockReturnValue(query);
  return render(<ReceitasProntas connectionId="conn-1" motor="mysql" canWrite={true} />);
}

// O toast é lido pelo índice da chamada: sem limpar entre os testes, o
// segundo 422 leria a mensagem do primeiro.
afterEach(() => {
  vi.clearAllMocks();
});

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

describe("ReceitasProntas — o 422 da gravação", () => {
  it("mostra o rótulo legível do caminho que falhou (não o caminho cru)", async () => {
    mockUseReceitas.mockReturnValue({
      data: { receitas: [INSTANCIA_WORDPRESS] },
      isError: false,
      refetch: vi.fn(),
    });
    mockSalvar.mockRejectedValueOnce(
      new ApiError(
        422,
        "validation_failed",
        {
          fieldErrors: {
            "esconder.meta_key": [
              "Use apenas letras, números, underscore e hífen no nome do campo.",
            ],
          },
        },
        "req-1",
        "Campos inválidos.",
      ),
    );

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ReceitasProntas connectionId="conn-1" motor="mysql" canWrite={true} />
      </QueryClientProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Editar/i })!);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Salvar/i })!);
    });

    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
    const texto = vi.mocked(toast.error).mock.calls[0]![0] as string;
    expect(texto).toContain("Campo a esconder");
    // E o caminho cru NÃO vaza para a tela.
    expect(texto).not.toContain("esconder.meta_key");
  });

  it("os valores a esconder mostram 'Valores a esconder' (não o caminho cru)", async () => {
    mockUseReceitas.mockReturnValue({
      data: { receitas: [INSTANCIA_WORDPRESS] },
      isError: false,
      refetch: vi.fn(),
    });
    mockSalvar.mockRejectedValueOnce(
      new ApiError(
        422,
        "validation_failed",
        { fieldErrors: { "esconder.valores": ["Escreva pelo menos um valor a esconder."] } },
        "req-1",
        "Campos inválidos.",
      ),
    );

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ReceitasProntas connectionId="conn-1" motor="mysql" canWrite={true} />
      </QueryClientProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Editar/i })!);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Salvar/i })!);
    });

    const texto = vi.mocked(toast.error).mock.calls[0]![0] as string;
    expect(texto).toContain("Valores a esconder");
    expect(texto).not.toContain("esconder.valores");
  });
});
