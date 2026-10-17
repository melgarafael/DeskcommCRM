/**
 * Receitas prontas — caminho ACF (fatia R2).
 * Prova:
 *   - quando a receita é acf-imoveis, mostra Tipo de post e mapeamento de campos;
 *   - rótulos ligados aos inputs (useId + htmlFor);
 *   - botão "Sugerir campos" preenche os vazios sem sobrescrever o já digitado;
 *   - salvar envia os fixos completos do ACF.
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
    [
      "woocommerce-produtos",
      {
        id: "woocommerce-produtos",
        familia: "woocommerce",
        motores: ["mysql"],
        rotulo: "Produtos da loja WooCommerce",
        descricao: "Produtos da loja",
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

const INSTANCIA_ACF: InstanciaDeReceita = {
  id: "inst-acf-1",
  receita: "acf-imoveis",
  rotulo: "Meus imóveis",
  descricao: "Imóveis publicados",
  fixos: {
    prefixo: "wp_",
    post_type: "imovel",
    campos: { preco: "preco", quartos: "quartos", bairro: "bairro" },
  },
  ativa: true,
};

const deps = vi.hoisted(() => ({
  useReceitasDaConexao: vi.fn(),
  salvarReceitas: vi.fn(),
  previewReceita: vi.fn(),
  sugerirCamposACF: vi.fn(),
}));

vi.mock("@/hooks/external-db/useReceitasDaConexao", () => ({
  useReceitasDaConexao: deps.useReceitasDaConexao,
  salvarReceitas: deps.salvarReceitas,
  previewReceita: deps.previewReceita,
  sugerirCamposACF: deps.sugerirCamposACF,
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
    instancia: { id: "inst-1", receita: "acf-imoveis", rotulo: "Imóveis" },
    colunas: ["id", "titulo", "preco"],
    linhas: [{ id: "1", titulo: "Apê", preco: "500000" }],
    linhas_devolvidas: 1,
  });

  const ui = <ReceitasProntas connectionId="conn-1" motor="mysql" canWrite={canWrite} />;
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Receitas prontas — caminho ACF", () => {
  it("adicionar acf-imoveis mostra Tipo de post e mapeamento de campos", async () => {
    renderComQuery([], true);

    const botaoAdicionar = screen.getByRole("button", { name: /Adicionar receita/i })!;
    await act(async () => {
      fireEvent.click(botaoAdicionar);
    });

    // Tipo de post
    expect(screen.getByLabelText(/Tipo de post/i)).toBeInTheDocument();
    // Mapeamento de campos obrigatórios
    expect(screen.getByLabelText(/Preço \*/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Quartos \*/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Bairro \*/i)).toBeInTheDocument();
    // Opcionais
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
    expect(screen.getByLabelText(/Preço \*/i)).toHaveValue("preco");
    expect(screen.getByLabelText(/Quartos \*/i)).toHaveValue("quartos");
    expect(screen.getByLabelText(/Bairro \*/i)).toHaveValue("bairro");
    expect(screen.getByLabelText(/Cidade/i)).toHaveValue("");
    expect(screen.getByLabelText(/Área/i)).toHaveValue("");
  });

  it("Sugerir campos preenche os vazios sem sobrescrever o já digitado", async () => {
    // O rascunho já tem preço e quartos digitados; só bairro está vazio.
    const instEdicao: InstanciaDeReceita = {
      ...INSTANCIA_ACF,
      fixos: {
        prefixo: "wp_",
        post_type: "imovel",
        campos: { preco: "meu_preco", quartos: "meus_quartos" }, // bairro vazio
      },
    };
    renderComQuery([instEdicao], true);

    // Entrar em modo de edição da instância existente
    const botaoEditar = screen.getByRole("button", { name: /Editar/i })!;
    await act(async () => {
      fireEvent.click(botaoEditar);
    });

    // Confirma que preço e quartos já estão preenchidos (não vazios)
    expect(screen.getByLabelText(/Preço \*/i)).toHaveValue("meu_preco");
    expect(screen.getByLabelText(/Quartos \*/i)).toHaveValue("meus_quartos");
    expect(screen.getByLabelText(/Bairro \*/i)).toHaveValue("");

    // O servidor sugere bairro = "bairro_servidor" (não sobrescreve preço/quartos)
    deps.sugerirCamposACF.mockResolvedValue({
      receita: "acf-imoveis",
      prefixo: "wp_",
      post_type: "imovel",
      meta_keys: ["meu_preco", "meus_quartos", "bairro_servidor"],
      mapeamento_sugerido: {
        preco: "meu_preco_servidor", // já tem preço → não sobrescreve
        quartos: "meus_quartos_servidor", // já tem quartos → não sobrescreve
        bairro: "bairro_servidor", // vazio → preenche
        cidade: null,
        area: null,
        finalidade: null,
      },
    });

    const botaoSugerir = screen.getByRole("button", { name: /Sugerir campos/i })!;
    await act(async () => {
      fireEvent.click(botaoSugerir);
    });

    // Preço e quartos NÃO foram sobrescritos.
    expect(screen.getByLabelText(/Preço \*/i)).toHaveValue("meu_preco");
    expect(screen.getByLabelText(/Quartos \*/i)).toHaveValue("meus_quartos");
    // Bairro foi preenchido (estava vazio).
    expect(screen.getByLabelText(/Bairro \*/i)).toHaveValue("bairro_servidor");
  });

  it("salvar acf-imoveis envia fixos completos (prefixo, post_type, campos)", async () => {
    renderComQuery([], true);

    const botaoAdicionar = screen.getByRole("button", { name: /Adicionar receita/i })!;
    await act(async () => {
      fireEvent.click(botaoAdicionar);
    });

    // Mudar tipo de post
    const inputPostType = screen.getByLabelText(/Tipo de post/i);
    await act(async () => {
      fireEvent.input(inputPostType, { target: { value: "apartamento" } });
    });

    const botaoSalvar = screen.getByRole("button", { name: /Salvar/i })!;
    await act(async () => {
      fireEvent.click(botaoSalvar);
    });

    const args = deps.salvarReceitas.mock.calls[0]![1] as InstanciaDeReceita[];
    expect(args).toHaveLength(1);
    expect(args[0]!.receita).toBe("acf-imoveis");
    const fixos = args[0]!.fixos as {
      prefixo: string;
      post_type: string;
      campos: Record<string, string>;
    };
    expect(fixos.prefixo).toBe("wp_");
    expect(fixos.post_type).toBe("apartamento");
    expect(fixos.campos.preco).toBe("preco");
    expect(fixos.campos.quartos).toBe("quartos");
    expect(fixos.campos.bairro).toBe("bairro");
  });

  it("canWrite=false → nenhum botão de mudar nem sugerir", () => {
    renderComQuery([INSTANCIA_ACF], false);

    expect(screen.queryByRole("button", { name: /Adicionar receita/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Editar/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Sugerir campos/i })).toBeNull();
  });
});
