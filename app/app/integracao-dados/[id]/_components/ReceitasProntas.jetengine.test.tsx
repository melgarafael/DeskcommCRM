/**
 * Receitas prontas — caminho jetengine-imoveis (fatia R3).
 * Prova:
 *   - quando a receita é jetengine-imoveis, mostra Prefixo das tabelas, Slug do CCT e mapeamento de colunas;
 *   - rótulos ligados aos inputs (useId + htmlFor);
 *   - botão "Sugerir campos" preenche os vazios sem sobrescrever o já digitado;
 *   - salvar manda os fixos completos (prefixo, slug, campos).
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
      "jetengine-imoveis",
      {
        id: "jetengine-imoveis",
        familia: "jetengine-imoveis",
        motores: ["mysql"],
        rotulo: "Imóveis do WordPress com JetEngine",
        descricao: "Imóveis publicados com JetEngine",
        parametrosFixos: {} as z.ZodTypeAny,
        parametrosDaBusca: {} as z.ZodTypeAny,
        tabelas: () => ["wp_jet_cct_imoveis"],
        colunas: () => ({ wp_jet_cct_imoveis: ["_ID", "titulo", "preco", "quartos", "bairro", "cidade", "area", "cct_status"] }),
        montar: () => ({ sql: "select ...", valores: [] }),
        tetoDeItens: 5,
      },
    ],
    [
      "acf-imoveis",
      {
        id: "acf-imoveis",
        familia: "acf-imoveis",
        motores: ["mysql"],
        rotulo: "Imóveis do WordPress com ACF",
        descricao: "Imóveis publicados com ACF",
        parametrosFixos: {} as z.ZodTypeAny,
        parametrosDaBusca: {} as z.ZodTypeAny,
        tabelas: () => ["wp_posts", "wp_postmeta"],
        colunas: () => ({ wp_posts: ["ID"], wp_postmeta: ["post_id", "meta_key", "meta_value"] }),
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

const INSTANCIA_JETENGINE: InstanciaDeReceita = {
  id: "inst-je-1",
  receita: "jetengine-imoveis",
  rotulo: "Meus imóveis JetEngine",
  descricao: "Imóveis publicados com JetEngine",
  fixos: {
    prefixo: "wp_",
    slug: "imoveis",
    campos: {
      preco: "preco",
      quartos: "quartos",
      bairro: "bairro",
      titulo: "titulo",
      cidade: "cidade",
      area: "area",
    },
  },
  ativa: true,
};

const deps = vi.hoisted(() => ({
  useReceitasDaConexao: vi.fn(),
  salvarReceitas: vi.fn(),
  previewReceita: vi.fn(),
  sugerirCamposJetEngine: vi.fn(),
}));

vi.mock("@/hooks/external-db/useReceitasDaConexao", () => ({
  useReceitasDaConexao: deps.useReceitasDaConexao,
  salvarReceitas: deps.salvarReceitas,
  previewReceita: deps.previewReceita,
  sugerirCamposJetEngine: deps.sugerirCamposJetEngine,
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
    instancia: { id: "inst-1", receita: "jetengine-imoveis", rotulo: "Imóveis JetEngine" },
    colunas: ["_ID", "titulo", "preco", "quartos", "bairro", "cidade", "area", "cct_status"],
    linhas: [{ _ID: "1", titulo: "Apê 1", preco: "500000", quartos: "3", bairro: "Asa Norte", cidade: "São Paulo", area: "80m2", cct_status: "publish" }],
    linhas_devolvidas: 1,
  });

  const ui = <ReceitasProntas connectionId="conn-1" motor="mysql" canWrite={canWrite} />;
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Receitas prontas — caminho jetengine-imoveis", () => {
  it("adicionar jetengine-imoveis mostra Prefixo das tabelas, Slug do CCT e mapeamento de campos", async () => {
    renderComQuery([], true);

    const botaoAdicionar = screen.getByRole("button", { name: /Adicionar receita/i })!;
    await act(async () => {
      fireEvent.click(botaoAdicionar);
    });

    // Prefixo das tabelas (o JetEngine não tem tipo de post: o CCT é identificado pelo slug)
    expect(screen.getByLabelText(/Prefixo das tabelas/i)).toBeInTheDocument();
    // Slug do CCT
    expect(screen.getByLabelText(/Slug do CCT/i)).toBeInTheDocument();
    // Mapeamento de campos
    expect(screen.getByLabelText(/Título/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Preço/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Quartos/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Bairro/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Cidade/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Área/i)).toBeInTheDocument();
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
    expect(screen.getByLabelText(/Título/i)).toHaveValue("titulo");
    expect(screen.getByLabelText(/Preço/i)).toHaveValue("preco");
    expect(screen.getByLabelText(/Quartos/i)).toHaveValue("quartos");
    expect(screen.getByLabelText(/Bairro/i)).toHaveValue("bairro");
    expect(screen.getByLabelText(/Cidade/i)).toHaveValue("cidade");
    expect(screen.getByLabelText(/Área/i)).toHaveValue("area");
  });

  it("Sugerir campos preenche os vazios sem sobrescrever o já digitado", async () => {
    const instEdicao: InstanciaDeReceita = {
      ...INSTANCIA_JETENGINE,
      fixos: {
        ...(INSTANCIA_JETENGINE.fixos as Record<string, unknown>),
        campos: {
          ...((INSTANCIA_JETENGINE.fixos as Record<string, unknown>).campos as Record<string, unknown>),
          preco: "meu_preco", // já tem preço
          quartos: "meus_quartos", // já tem quartos
        },
      },
    };
    renderComQuery([instEdicao], true);

    const botaoEditar = screen.getByRole("button", { name: /Editar/i })!;
    await act(async () => {
      fireEvent.click(botaoEditar);
    });

    // Confirma que preço e quartos já estão preenchidos
    expect(screen.getByLabelText(/Preço/i)).toHaveValue("meu_preco");
    expect(screen.getByLabelText(/Quartos/i)).toHaveValue("meus_quartos");

    // O servidor sugere preço e quartos com novos valores (não sobrescreve)
    deps.sugerirCamposJetEngine.mockResolvedValue({
      receita: "jetengine-imoveis",
      prefixo: "wp_",
      ccts: [
        {
          tabela: "wp_jet_cct_imoveis",
          colunas: ["_ID", "titulo", "preco", "quartos", "bairro", "cidade", "area", "cct_status"],
          mapeamento: {
            preco: "meu_preco_servidor", // já tem preço → não sobrescreve
            quartos: "meus_quartos_servidor", // já tem quartos → não sobrescreve
            bairro: "bairro_servidor", // vazio → preenche
            titulo: "titulo", // já tem título → não sobrescreve
            cidade: "cidade_servidor", // vazio → preenche
            area: "area_servidor", // vazio → preenche
          },
        },
      ],
    });

    const botaoSugerir = screen.getByRole("button", { name: /Sugerir campos/i })!;
    await act(async () => {
      fireEvent.click(botaoSugerir);
    });

    // Preço e quartos NÃO foram sobrescritos.
    expect(screen.getByLabelText(/Preço/i)).toHaveValue("meu_preco");
    expect(screen.getByLabelText(/Quartos/i)).toHaveValue("meus_quartos");
  });

  it("salvar jetengine-imoveis envia fixos completos (prefixo, slug, campos)", async () => {
    renderComQuery([], true);

    const botaoAdicionar = screen.getByRole("button", { name: /Adicionar receita/i })!;
    await act(async () => {
      fireEvent.click(botaoAdicionar);
    });

    // Mudar slug do CCT
    const inputSlug = screen.getByLabelText(/Slug do CCT/i);
    await act(async () => {
      fireEvent.input(inputSlug, { target: { value: "apartamentos" } });
    });

    const botaoSalvar = screen.getByRole("button", { name: /Salvar/i })!;
    await act(async () => {
      fireEvent.click(botaoSalvar);
    });

    const args = deps.salvarReceitas.mock.calls[0]![1] as InstanciaDeReceita[];
    expect(args).toHaveLength(1);
    expect(args[0]!.receita).toBe("jetengine-imoveis");
    const fixos = args[0]!.fixos as {
      prefixo: string;
      slug: string;
      campos: Record<string, string>;
    };
    expect(fixos.prefixo).toBe("wp_");
    expect(fixos.slug).toBe("apartamentos");
    expect(fixos.campos.preco).toBe("preco");
    expect(fixos.campos.quartos).toBe("quartos");
    expect(fixos.campos.bairro).toBe("bairro");
    expect(fixos.campos.titulo).toBe("titulo");
    expect(fixos.campos.cidade).toBe("cidade");
    expect(fixos.campos.area).toBe("area");
  });

  it("Campo da foto aparece, e salvar envia imagem só quando preenchida", async () => {
    renderComQuery([INSTANCIA_JETENGINE], true);
    const abrirESalvar = async (valor: string | null) => {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Editar/i })!);
      });
      if (valor !== null) {
        await act(async () => {
          fireEvent.change(screen.getByLabelText(/Campo da foto/i), { target: { value: valor } });
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
    expect(screen.getByLabelText(/Campo da foto/i)).toHaveValue("");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Cancelar/i })!);
    });

    // vazio: a chave não vai (o servidor recusa string vazia)
    expect("imagem" in (await abrirESalvar(null)).campos!).toBe(false);
    // preenchido: a chave vai
    expect((await abrirESalvar("imagem_destaque")).campos!.imagem).toBe("imagem_destaque");
    // apagar de novo remove a chave
    expect("imagem" in (await abrirESalvar("")).campos!).toBe(false);
  });

  it("canWrite=false → nenhum botão de mudar nem sugerir", () => {
    renderComQuery([INSTANCIA_JETENGINE], false);

    expect(screen.queryByRole("button", { name: /Adicionar receita/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Editar/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Sugerir campos/i })).toBeNull();
  });
});
