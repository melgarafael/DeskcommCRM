/**
 * Receitas prontas — tela de instâncias de receita de banco externo.
 * Prova contra os 5 defeitos de produto:
 *   1. Adicionar aparece na lista (não só em rascunho).
 *   2. Salvar envia a LISTA INTEIRA (existentes + nova), não apaga as outras.
 *   3. Adicionar ESCOLHE a receita (não cria sempre a primeira da lista).
 *   4. Pré-visualização envia parâmetros de busca, nunca o objeto fixos.
 *   5. Labels ligados aos inputs (htmlFor/id) — getByLabelText acha o campo.
 */
import type { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { toast } from "sonner";
import { ApiError } from "@/lib/api/types";

import ReceitasProntas from "./ReceitasProntas";
import type { InstanciaDeReceita } from "@/lib/external-db/receitas/tipos";

const receitasMock = vi.hoisted(() => ({
  mapa: new Map([
    [
      "woocommerce-produtos",
      {
        id: "woocommerce-produtos",
        familia: "woocommerce",
        motores: ["mysql"],
        rotulo: "Produtos da loja WooCommerce",
        resumo: "Produtos publicados de uma loja WooCommerce.",
        descricao: "Produtos da loja",
        parametrosFixos: {} as z.ZodTypeAny,
        parametrosDaBusca: {} as z.ZodTypeAny,
        tabelas: () => ["wp_posts"],
        colunas: () => ({ wp_posts: ["ID"] }),
        montar: () => ({ sql: "select ...", valores: [] }),
        tetoDeItens: 5,
      },
    ],
    [
      "woocommerce-clientes",
      {
        id: "woocommerce-clientes",
        familia: "woocommerce",
        motores: ["mysql"],
        rotulo: "Clientes WooCommerce",
        resumo: "Clientes cadastrados na loja.",
        descricao: "Clientes da loja",
        parametrosFixos: {} as z.ZodTypeAny,
        parametrosDaBusca: {} as z.ZodTypeAny,
        tabelas: () => ["wp_posts"],
        colunas: () => ({ wp_posts: ["ID"] }),
        montar: () => ({ sql: "select ...", valores: [] }),
        tetoDeItens: 5,
      },
    ],
  ]),
}));

vi.mock("@/lib/external-db/receitas/registro", () => ({
  RECEITAS: receitasMock.mapa,
  receitaDe: (id: string) => receitasMock.mapa.get(id),
}));

const INSTANCIA_SALVA: InstanciaDeReceita = {
  id: "inst-salva-1",
  receita: "woocommerce-produtos",
  rotulo: "Produtos salvos",
  descricao: "Produtos já cadastrados",
  fixos: { prefixo: "wp_" },
  ativa: true,
};

const deps = vi.hoisted(() => ({
  useReceitasDaConexao: vi.fn(),
  salvarReceitas: vi.fn(),
  previewReceita: vi.fn(),
}));

vi.mock("@/hooks/external-db/useReceitasDaConexao", () => ({
  useReceitasDaConexao: deps.useReceitasDaConexao,
  salvarReceitas: deps.salvarReceitas,
  previewReceita: deps.previewReceita,
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/lib/random-id", () => ({ randomId: () => "id-gerado" }));
vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

function renderComQuery(receitas: InstanciaDeReceita[], canWrite = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  deps.useReceitasDaConexao.mockReturnValue({
    data: { receitas },
    isError: false,
    refetch: vi.fn(async () => ({} as { status: number })),
  });
  deps.salvarReceitas.mockResolvedValue({ receitas });
  deps.previewReceita.mockResolvedValue({
    instancia: { id: "inst-1", receita: "woocommerce-produtos", rotulo: "Produtos" },
    colunas: ["id", "titulo"],
    linhas: [{ id: "1", titulo: "Camisa" }],
    linhas_devolvidas: 1,
  });

  const ui = (
    <ReceitasProntas connectionId="conn-1" motor="mysql" canWrite={canWrite} />
  );
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** Abre a escolha da receita e escolhe a que tem o rótulo pedido. */
async function adicionarReceita(rotulo: RegExp): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Adicionar receita/i }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: rotulo }));
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Receitas prontas — comportamento da lista", () => {
  it("com 0 salvas: adicionar → escolher → aparece na lista → salvar chama o PUT com a nova (não apaga nada)", async () => {
    renderComQuery([], true);

    await adicionarReceita(/Produtos da loja WooCommerce/);

    // Após escolher, o input do rótulo mostra o nome da receita
    expect(screen.getByLabelText(/Nome da receita/i)).toHaveValue("Produtos da loja WooCommerce");

    // Clicar em Salvar
    const botaoSalvar = screen.getByRole("button", { name: /Salvar/i });
    await act(async () => {
      fireEvent.click(botaoSalvar);
    });

    // O PUT recebeu a nova receita
    expect(deps.salvarReceitas).toHaveBeenCalledWith("conn-1", expect.any(Array));
    const args = deps.salvarReceitas.mock.calls[0]![1] as InstanciaDeReceita[];
    expect(args).toHaveLength(1);
    expect(args[0]!.receita).toBe("woocommerce-produtos");
    expect(args[0]!.rotulo).toBe("Produtos da loja WooCommerce");
  });

  it("adicionar NÃO cria a primeira receita da lista sem perguntar (o defeito da tela)", async () => {
    renderComQuery([], true);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Adicionar receita/i }));
    });

    // A escolha está na tela, e nada foi criado ainda.
    expect(screen.getByText("Qual receita você quer usar?")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Nome da receita/i)).toBeNull();
  });

  it("woocommerce mostra o campo Prefixo das tabelas (regressão da R3: só ACF e JetEngine o tinham)", async () => {
    renderComQuery([], true);
    await adicionarReceita(/Produtos da loja WooCommerce/);
    expect(screen.getByLabelText(/Prefixo das tabelas/i)).toHaveValue("wp_");
  });

  it("monta em carregando, depois a query resolve com 1 receita → ela aparece; adicionar outra e salvar → PUT recebe as 2", async () => {
    // Primeira renderização: query ainda carregando (data undefined)
    deps.useReceitasDaConexao.mockReturnValue({
      data: undefined,
      isError: false,
      refetch: vi.fn(async () => ({} as { status: number })),
    });

    const { rerender } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ReceitasProntas connectionId="conn-1" motor="mysql" canWrite />
      </QueryClientProvider>,
    );

    // Em carregando, não deve haver receitas listadas
    expect(screen.queryByText("Produtos salvos")).toBeNull();

    // A query resolve com 1 receita salva
    deps.useReceitasDaConexao.mockReturnValue({
      data: { receitas: [INSTANCIA_SALVA] },
      isError: false,
      refetch: vi.fn(async () => ({} as { status: number })),
    });
    deps.salvarReceitas.mockResolvedValue({ receitas: [INSTANCIA_SALVA] });

    await act(async () => {
      rerender(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <ReceitasProntas connectionId="conn-1" motor="mysql" canWrite />
        </QueryClientProvider>,
      );
    });

    // A receita salva agora aparece
    expect(screen.getByText("Produtos salvos")).toBeInTheDocument();

    // Adicionar outra receita (a segunda opção do registro)
    await adicionarReceita(/Clientes WooCommerce/);

    // Salvar
    const botaoSalvar = screen.getByRole("button", { name: /Salvar/i });
    await act(async () => {
      fireEvent.click(botaoSalvar);
    });

    // O PUT recebeu as 2 receitas (a salva + a nova)
    expect(deps.salvarReceitas).toHaveBeenLastCalledWith("conn-1", expect.any(Array));
    const args = deps.salvarReceitas.mock.calls[deps.salvarReceitas.mock.calls.length - 1]![1] as InstanciaDeReceita[];
    expect(args).toHaveLength(2);
    expect(args.map((a) => a.receita)).toContain("woocommerce-produtos");
    expect(args.map((a) => a.receita)).toContain("woocommerce-clientes");
  });

  it("em carregando, não há como adicionar: salvar antes da lista chegar apagaria as receitas salvas", () => {
    deps.useReceitasDaConexao.mockReturnValue({
      data: undefined,
      isError: false,
      refetch: vi.fn(async () => ({} as { status: number })),
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ReceitasProntas connectionId="conn-1" motor="mysql" canWrite />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Receitas prontas")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Adicionar receita/i })).toBeNull();
  });

  it("com 1 salva: adicionar outra → salvar chama o PUT com as 2", async () => {
    renderComQuery([INSTANCIA_SALVA], true);

    await adicionarReceita(/Clientes WooCommerce/);

    // SABOTAGEM (i): se salvar enviar só a nova instância, este teste fica vermelho
    // porque o PUT deveria receber as 2 receitas (existente + nova)
    const botaoSalvar = screen.getByRole("button", { name: /Salvar/i });
    await act(async () => {
      fireEvent.click(botaoSalvar);
    });

    const args = deps.salvarReceitas.mock.calls[deps.salvarReceitas.mock.calls.length - 1]![1] as InstanciaDeReceita[];
    expect(args).toHaveLength(2);
    expect(args.map((a) => a.receita)).toContain("woocommerce-produtos");
    expect(args.map((a) => a.receita)).toContain("woocommerce-clientes");
  });

  it("com 2 salvas: remover 1 → o PUT recebe a outra (não [])", async () => {
    const inst2: InstanciaDeReceita = {
      id: "inst-salva-2",
      receita: "woocommerce-produtos",
      rotulo: "Outros produtos",
      descricao: "",
      fixos: { prefixo: "wp_" },
      ativa: true,
    };
    renderComQuery([INSTANCIA_SALVA, inst2], true);

    const botoesRemover = screen.getAllByRole("button", { name: /Remover/i });
    await act(async () => {
      fireEvent.click(botoesRemover[0]!);
    });

    // Após clicar em "Remover", aparecem os botões de confirmação "Sim / Não"
    const botaoSim = screen.getByRole("button", { name: /Sim/i });
    await act(async () => {
      fireEvent.click(botaoSim);
    });

    const ultima = deps.salvarReceitas.mock.calls[deps.salvarReceitas.mock.calls.length - 1]![1] as InstanciaDeReceita[];
    expect(ultima).toHaveLength(1);
    expect(ultima[0]!.id).toBe("inst-salva-2");
  });

  it("adicionar → o rótulo padrão é o da receita e getByLabelText acha o campo", async () => {
    renderComQuery([], true);

    await adicionarReceita(/Produtos da loja WooCommerce/);

    const inputRotulo = screen.getByLabelText(/Nome da receita/i);
    expect(inputRotulo).toHaveValue("Produtos da loja WooCommerce");
  });

  it("pré-visualizar chama previewReceita com parâmetros de busca, nunca com fixos", async () => {
    renderComQuery([INSTANCIA_SALVA], true);

    const botoesPreview = screen.getAllByRole("button", { name: /Pré-visualizar/i });
    fireEvent.click(botoesPreview[0]!);

    expect(deps.previewReceita).toHaveBeenCalledWith("conn-1", "inst-salva-1", expect.objectContaining({ limite: 5 }));
    const args = deps.previewReceita.mock.calls[0]![2] as { limite: number };
    expect(args).not.toHaveProperty("prefixo");
  });

  it("canWrite=false → nenhum botão de mudar", () => {
    renderComQuery([INSTANCIA_SALVA], false);

    expect(screen.queryByRole("button", { name: /Adicionar receita/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Editar/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remover/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Salvar/i })).toBeNull();
  });

  it("adicionar e salvar sem editar envia descricao com no máximo 300 caracteres", async () => {
    renderComQuery([], true);

    await adicionarReceita(/Produtos da loja WooCommerce/);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Salvar/i })!);
    });

    const args = deps.salvarReceitas.mock.calls[0]![1] as InstanciaDeReceita[];
    expect(args[0]!.descricao.length).toBeLessThanOrEqual(300);
  });

  it("salvar com 422 mostra o campo que falhou (não o genérico)", async () => {
    renderComQuery([], true);
    deps.salvarReceitas.mockRejectedValueOnce(
      new ApiError(
        422,
        "validation_failed",
        { fieldErrors: { descricao: ["pode ter no máximo 300 caracteres"] } },
        "req-1",
        "Campos inválidos.",
      ),
    );

    await adicionarReceita(/Produtos da loja WooCommerce/);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Salvar/i })!);
    });

    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(expect.stringContaining("Descrição"));
  });
});
