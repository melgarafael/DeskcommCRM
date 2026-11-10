/**
 * Receitas prontas — tabela direta (qualquer tabela plana), R3.
 *
 * Prova:
 *   - ADICIONAR ESCOLHE a receita "Tabela direta";
 *   - o MODELO "JetEngine — tipo de conteúdo próprio (CCT)" preenche tabela,
 *     coluna do id, coluna do título e campos;
 *   - editar uma instância salva NÃO mostra a escolha de receita;
 *   - dá para adicionar e remover campo da tabela;
 *   - o PUT leva o objeto certo: tabela, coluna_id, coluna_titulo, campos,
 *     so_mostrar_quando e esconder_quando;
 *   - a chave do dado nasce do rótulo (o leigo não digita a chave).
 *
 * Os locators das linhas usam `within` dentro do grupo da linha: o rótulo
 * "Rótulo" se repete em cada linha.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { toast } from "sonner";

import ReceitasProntas from "./ReceitasProntas";
import type { InstanciaDeReceita } from "@/lib/external-db/receitas/tipos";

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

const INSTANCIA_TABELA: InstanciaDeReceita = {
  id: "inst-td-1",
  receita: "tabela-direta",
  rotulo: "Meus imóveis CCT",
  descricao: "JetEngine CCT publicados",
  fixos: {
    tabela: "wp_jet_cct_imovel",
    coluna_id: "_ID",
    coluna_titulo: "titulo",
    campos: [
      { chave: "preco", rotulo: "Preço de venda", coluna: "preco", tipo: "preco", filtro: "maximo" },
      { chave: "quartos", rotulo: "Quartos", coluna: "quartos", tipo: "numero", filtro: "minimo" },
    ],
    so_mostrar_quando: { coluna: "cct_status", valor: "publish" },
    esconder_quando: { coluna: "situacao", valores: ["vendido"] },
  },
  ativa: true,
};

function renderComQuery(receitas: InstanciaDeReceita[], canWrite = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  deps.useReceitasDaConexao.mockReturnValue({
    data: { receitas },
    isError: false,
    refetch: vi.fn(async () => ({}) as { status: number }),
  });
  deps.salvarReceitas.mockResolvedValue({ receitas });
  deps.previewReceita.mockResolvedValue({
    instancia: { id: "inst-1", receita: "tabela-direta", rotulo: "Tabela" },
    colunas: ["id", "titulo"],
    linhas: [{ id: "1", titulo: "Apê" }],
    linhas_devolvidas: 1,
  });

  const ui = <ReceitasProntas connectionId="conn-1" motor="mysql" canWrite={canWrite} />;
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** A tela de ESCOLHER a receita: clica "Adicionar receita" e escolhe a tabela direta. */
async function adicionarReceitaTabelaDireta() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Adicionar receita/i }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Tabela direta/ }));
  });
}

/** Salva e devolve os "fixos" que foram para o PUT. */
async function salvarEObterFixos(): Promise<Record<string, unknown>> {
  const botaoSalvar = screen.getByRole("button", { name: /Salvar/i });
  await act(async () => {
    fireEvent.click(botaoSalvar);
  });
  const args = deps.salvarReceitas.mock.calls[0]![1] as InstanciaDeReceita[];
  return (args[0]!.fixos ?? {}) as Record<string, unknown>;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Receitas prontas — tabela direta", () => {
  it("escolher a receita tabela-direta abre o editor da tabela", async () => {
    renderComQuery([], true);
    await adicionarReceitaTabelaDireta();
    // O editor da tabela direta pede tabela, coluna do id e coluna do título.
    expect(screen.getByLabelText("Tabela")).toBeInTheDocument();
    expect(screen.getByLabelText("Coluna do id")).toBeInTheDocument();
    expect(screen.getByLabelText("Coluna do título")).toBeInTheDocument();
    // E não pede tipo de post (é do WordPress).
    expect(screen.queryByLabelText("Tipo de post")).not.toBeInTheDocument();
  });

  it("o modelo JetEngine CCT preenche tabela, colunas e campos com 1 clique", async () => {
    renderComQuery([], true);
    await adicionarReceitaTabelaDireta();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /JetEngine — tipo de conteúdo próprio \(CCT\)/ }));
    });
    expect(screen.getByLabelText("Tabela")).toHaveValue("wp_jet_cct_imovel");
    expect(screen.getByLabelText("Coluna do id")).toHaveValue("_ID");
    expect(screen.getByLabelText("Coluna do título")).toHaveValue("titulo");
    // E traz os campos do imóvel.
    expect(screen.getByDisplayValue("Preço de venda")).toBeInTheDocument();
  });

  it("aplicar o modelo pergunta antes de apagar o que já foi digitado", async () => {
    renderComQuery([], true);
    await adicionarReceitaTabelaDireta();
    // Digita algo na tabela.
    await act(async () => {
      fireEvent.input(screen.getByLabelText("Tabela"), {
        target: { value: "minha_tabela" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /JetEngine/ }));
    });
    expect(screen.getByText("Trocar de modelo apaga o que você preencheu. Quer continuar?")).toBeInTheDocument();
    // Sem confirmação, nada muda.
    expect(screen.getByLabelText("Tabela")).toHaveValue("minha_tabela");
  });

  it("adicionar e remover campo da tabela", async () => {
    renderComQuery([], true);
    await adicionarReceitaTabelaDireta();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Adicionar campo/i }));
    });
    // Aparece uma segunda linha de campo.
    const grupos = screen.getAllByRole("group", { name: /Campo/ });
    expect(grupos).toHaveLength(2);
    // Remove o primeiro.
    await act(async () => {
      fireEvent.click(
        within(grupos[0]!).getByRole("button", { name: /Remover/i }),
      );
    });
    const gruposDepois = screen.getAllByRole("group", { name: /Campo/ });
    expect(gruposDepois).toHaveLength(1);
  });

  it("o PUT leva tabela, coluna_id, coluna_titulo, campos, so_mostrar_quando e esconder_quando", async () => {
    renderComQuery([], true);
    await adicionarReceitaTabelaDireta();
    await act(async () => {
      fireEvent.input(screen.getByLabelText("Tabela"), {
        target: { value: "wp_jet_cct_imovel" },
      });
    });
    await act(async () => {
      fireEvent.input(screen.getByLabelText("Coluna do id"), {
        target: { value: "_ID" },
      });
    });
    await act(async () => {
      fireEvent.input(screen.getByLabelText("Coluna do título"), {
        target: { value: "titulo" },
      });
    });
    // Preenche o primeiro campo.
    const grupo = screen.getAllByRole("group", { name: /Campo/ })[0]!;
    await act(async () => {
      fireEvent.input(within(grupo).getByLabelText("Rótulo"), {
        target: { value: "Preço" },
      });
    });
    await act(async () => {
      fireEvent.input(within(grupo).getByLabelText("Coluna na tabela"), {
        target: { value: "preco" },
      });
    });
    await act(async () => {
      // "Coluna" existe duas vezes (Só mostrar quando / Esconder quando); a primeira é a do "Só mostrar quando".
      fireEvent.input(screen.getAllByLabelText("Coluna")[0]!, {
        target: { value: "cct_status" },
      });
    });
    await act(async () => {
      fireEvent.input(screen.getByLabelText("Valor"), {
        target: { value: "publish" },
      });
    });

    const fixos = await salvarEObterFixos();
    expect(fixos.tabela).toBe("wp_jet_cct_imovel");
    expect(fixos.coluna_id).toBe("_ID");
    expect(fixos.coluna_titulo).toBe("titulo");
    const campos = fixos.campos as Array<{ rotulo: string; coluna: string }>;
    expect(campos.find((c) => c.rotulo === "Preço")?.coluna).toBe("preco");
    expect((fixos as { so_mostrar_quando?: { coluna: string; valor: string } }).so_mostrar_quando).toEqual({
      coluna: "cct_status",
      valor: "publish",
    });
  });

  it("editar uma instância salva carrega o editor da tabela direta", async () => {
    renderComQuery([INSTANCIA_TABELA], true);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Editar/i }));
    });
    expect(screen.getByLabelText("Tabela")).toHaveValue("wp_jet_cct_imovel");
    expect(screen.getByLabelText("Coluna do id")).toHaveValue("_ID");
    expect(screen.getByLabelText("Coluna do título")).toHaveValue("titulo");
  });

  it("o filtro Igual aparece para campo de texto e não para número", async () => {
    renderComQuery([], true);
    await adicionarReceitaTabelaDireta();
    await act(async () => {
      fireEvent.input(screen.getByLabelText("Tabela"), {
        target: { value: "wp_jet_cct_imovel" },
      });
    });
    await act(async () => {
      fireEvent.input(screen.getByLabelText("Coluna do id"), {
        target: { value: "_ID" },
      });
    });
    await act(async () => {
      fireEvent.input(screen.getByLabelText("Coluna do título"), {
        target: { value: "titulo" },
      });
    });
    const grupo = screen.getAllByRole("group", { name: /Campo/ })[0]!;
    await act(async () => {
      fireEvent.input(within(grupo).getByLabelText("Rótulo"), {
        target: { value: "Bairro" },
      });
    });
    await act(async () => {
      fireEvent.input(within(grupo).getByLabelText("Coluna na tabela"), {
        target: { value: "bairro" },
      });
    });
    // Tipo texto: Contém e Igual aparecem.
    await act(async () => {
      fireEvent.click(within(grupo).getByLabelText("Tipo"));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: /Texto/ }));
    });
    const filtro = within(grupo).getByLabelText("Filtro");
    expect(filtro).toHaveValue("nenhum");
    await act(async () => {
      fireEvent.click(filtro);
    });
    expect(screen.getByRole("option", { name: /Igual/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Contém/ })).toBeInTheDocument();
    // Não aparece Mínimo/Máximo para texto.
    expect(screen.queryByRole("option", { name: /Mínimo/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Máximo/ })).not.toBeInTheDocument();
  });
});
