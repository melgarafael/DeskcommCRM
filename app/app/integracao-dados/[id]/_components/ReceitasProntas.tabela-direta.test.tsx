/**
 * Receitas prontas — caminho tabela-direta (fatia R3).
 * Prova:
 *   - quando a receita é tabela-direta, mostra Tabela e mapeamento de colunas;
 *   - rótulos ligados aos inputs (useId + htmlFor);
 *   - botão "Sugerir campos" preenche os vazios sem sobrescrever o já digitado;
 *   - salvar manda os fixos completos (tabela, colunas).
 */
import type { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import ReceitasProntas from "./ReceitasProntas";
import type { InstanciaDeReceita } from "@/lib/external-db/receitas/tipos";

const receitasMock = vi.hoisted(() => ({
  mapa: new Map([
    [
      "tabela-direta",
      {
        id: "tabela-direta",
        familia: "tabela-direta",
        motores: ["mysql"],
        rotulo: "Tabela direta (qualquer tabela plana)",
        descricao: "Lê qualquer tabela plana do banco externo",
        parametrosFixos: {} as z.ZodTypeAny,
        parametrosDaBusca: {} as z.ZodTypeAny,
        tabelas: () => ["carros"],
        colunas: () => ({ carros: ["id", "modelo", "ano", "preco", "cor", "foto", "status"] }),
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

const INSTANCIA_TABELA_DIRETA: InstanciaDeReceita = {
  id: "inst-td-1",
  receita: "tabela-direta",
  rotulo: "Meus carros",
  descricao: "Carros publicados",
  fixos: {
    tabela: "carros",
    colunas: {
      id: "id",
      titulo: "modelo",
      preco: "preco",
      filtros_texto: ["cor"],
      filtro_numero: "ano",
      exibir: ["foto"],
      status: { coluna: "status", valor: "1" },
    },
  },
  ativa: true,
};

const deps = vi.hoisted(() => ({
  useReceitasDaConexao: vi.fn(),
  salvarReceitas: vi.fn(),
  previewReceita: vi.fn(),
  sugerirCamposTabelaDireta: vi.fn(),
}));

vi.mock("@/hooks/external-db/useReceitasDaConexao", () => ({
  useReceitasDaConexao: deps.useReceitasDaConexao,
  salvarReceitas: deps.salvarReceitas,
  previewReceita: deps.previewReceita,
  sugerirCamposTabelaDireta: deps.sugerirCamposTabelaDireta,
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/lib/random-id", () => ({ randomId: () => "id-gerado" }));

function renderComQuery(receitas: InstanciaDeReceita[], canWrite = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  deps.useReceitasDaConexao.mockReturnValue({
    data: { receitas },
    isError: false,
    refetch: vi.fn(async () => ({}) as { status: number }),
  });
  deps.salvarReceitas.mockResolvedValue({ receitas });
  deps.previewReceita.mockResolvedValue({
    instancia: { id: "inst-1", receita: "tabela-direta", rotulo: "Carros" },
    colunas: ["id", "titulo", "preco", "cor", "foto"],
    linhas: [{ id: "1", titulo: "Fusca", preco: "25000", cor: "vermelho", foto: "foto1.jpg" }],
    linhas_devolvidas: 1,
  });

  const ui = <ReceitasProntas connectionId="conn-1" motor="mysql" canWrite={canWrite} />;
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Receitas prontas — caminho tabela-direta", () => {
  it("adicionar tabela-direta mostra Tabela e mapeamento de colunas", async () => {
    renderComQuery([], true);

    const botaoAdicionar = screen.getByRole("button", { name: /Adicionar receita/i })!;
    await act(async () => {
      fireEvent.click(botaoAdicionar);
    });

    // Deve mostrar campos de configuração da tabela-direta
    expect(screen.getByLabelText(/Tabela$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Coluna ID/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Coluna Título/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Coluna Preço/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Coluna Filtro Numérico/i)).toBeInTheDocument();
    // Botão sugerir
    expect(screen.getByRole("button", { name: /Sugerir campos/i })).toBeInTheDocument();
  });

  it("labels estão ligados aos inputs (htmlFor/id) — getByLabelText acha cada campo", async () => {
    renderComQuery([], true);

    const botaoAdicionar = screen.getByRole("button", { name: /Adicionar receita/i })!;
    await act(async () => {
      fireEvent.click(botaoAdicionar);
    });

    // Cada input de mapeamento tem label ligado.
    expect(screen.getByLabelText(/Coluna ID/i)).toHaveValue("id");
    expect(screen.getByLabelText(/Coluna Título/i)).toHaveValue("modelo");
    expect(screen.getByLabelText(/Coluna Preço/i)).toHaveValue("preco");
    expect(screen.getByLabelText(/Coluna Filtro Numérico/i)).toHaveValue("ano");
  });

  it("Sugerir campos preenche os vazios sem sobrescrever o já digitado", async () => {
    const instEdicao: InstanciaDeReceita = {
      ...INSTANCIA_TABELA_DIRETA,
      fixos: {
        ...(INSTANCIA_TABELA_DIRETA.fixos as Record<string, unknown>),
        colunas: {
          ...((INSTANCIA_TABELA_DIRETA.fixos as Record<string, unknown>).colunas as Record<string, unknown>),
          preco: "meu_preco", // já tem preço
          filtros_texto: ["cor"], // já tem filtro de texto
        },
      },
    } as InstanciaDeReceita;
    renderComQuery([instEdicao], true);

    const botaoEditar = screen.getByRole("button", { name: /Editar/i })!;
    await act(async () => {
      fireEvent.click(botaoEditar);
    });

    // Confirma que preço e filtro_numero já estão preenchidos
    expect(screen.getByLabelText(/Coluna Preço/i)).toHaveValue("meu_preco");
    expect(screen.getByLabelText(/Coluna Filtro Numérico/i)).toHaveValue("ano");

    // O servidor sugere preço e filtro_numero com novos valores (não sobrescreve)
    deps.sugerirCamposTabelaDireta.mockResolvedValue({
      receita: "tabela-direta",
      tabela: "carros",
      colunas: ["id", "modelo", "preco", "cor", "ano", "foto", "status"],
      mapeamento_sugerido: {
        id: "meu_id", // já tem id → não sobrescreve
        titulo: "meu_titulo", // já tem título → não sobrescreve
        preco: "meu_preco", // já tem preço → não sobrescreve
        filtros_texto: "cor", // já tem filtros_texto → não sobrescreve
        filtro_numero: "meu_ano", // já tem filtro_numero → não sobrescreve
      },
    });

    const botaoSugerir = screen.getByRole("button", { name: /Sugerir campos/i })!;
    await act(async () => {
      fireEvent.click(botaoSugerir);
    });

    // Preço e filtro_numero NÃO foram sobrescritos.
    expect(screen.getByLabelText(/Coluna Preço/i)).toHaveValue("meu_preco");
    expect(screen.getByLabelText(/Coluna Filtro Numérico/i)).toHaveValue("ano");
  });

  it("salvar tabela-direta envia fixos completos", async () => {
    renderComQuery([], true);

    const botaoAdicionar = screen.getByRole("button", { name: /Adicionar receita/i })!;
    await act(async () => {
      fireEvent.click(botaoAdicionar);
    });

    // Mudar tabela
    const inputTabela = screen.getByLabelText(/Tabela$/i);
    await act(async () => {
      fireEvent.input(inputTabela, { target: { value: "carros_2" } });
    });

    const botaoSalvar = screen.getByRole("button", { name: /Salvar/i })!;
    await act(async () => {
      fireEvent.click(botaoSalvar);
    });

    const args = deps.salvarReceitas.mock.calls[0]![1] as InstanciaDeReceita[];
    expect(args).toHaveLength(1);
    expect(args[0]!.receita).toBe("tabela-direta");
    const fixos = args[0]!.fixos as {
      tabela: string;
      colunas: Record<string, unknown>;
    };
    expect(fixos.tabela).toBe("carros_2");
    expect(fixos.colunas.id).toBe("id");
    expect(fixos.colunas.titulo).toBe("modelo");
    expect(fixos.colunas.preco).toBe("preco");
  });

  it("Coluna da foto aparece, e salvar envia imagem só quando preenchida", async () => {
    renderComQuery([INSTANCIA_TABELA_DIRETA], true);
    const abrirESalvar = async (valor: string | null) => {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Editar/i })!);
      });
      if (valor !== null) {
        await act(async () => {
          fireEvent.change(screen.getByLabelText(/Coluna da foto/i), { target: { value: valor } });
        });
      }
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Salvar/i })!);
      });
      const chamadas = deps.salvarReceitas.mock.calls;
      return (chamadas[chamadas.length - 1]![1] as InstanciaDeReceita[])[0]!.fixos as Record<string, Record<string, unknown>>;
    };

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Editar/i })!);
    });
    expect(screen.getByLabelText(/Coluna da foto/i)).toHaveValue("");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Cancelar/i })!);
    });

    // vazio: a chave não vai (o servidor recusa string vazia)
    expect("imagem" in (await abrirESalvar(null)).colunas!).toBe(false);
    // preenchido: a chave vai
    expect((await abrirESalvar("foto")).colunas!.imagem).toBe("foto");
    // apagar de novo remove a chave
    expect("imagem" in (await abrirESalvar("")).colunas!).toBe(false);
  });

  it("canWrite=false → nenhum botão de mudar nem sugerir", () => {
    renderComQuery([INSTANCIA_TABELA_DIRETA], false);

    expect(screen.queryByRole("button", { name: /Adicionar receita/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Editar/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Sugerir campos/i })).toBeNull();
  });
});
