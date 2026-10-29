/**
 * Receitas prontas — o conteúdo do WordPress, qualquer tipo de post (R2 genérica).
 *
 * Prova:
 *   - ADICAR ESCOLHE a receita: o defeito era "adicionar" pegar a primeira da
 *     lista e criar sempre a mesma coisa (WooCommerce);
 *   - editar uma instância salva NÃO mostra a escolha de receita (a receita de
 *     uma instância salva não muda);
 *   - o MODELO "Imóveis" preenche a lista de campos e a de categorias;
 *   - dá para adicionar e remover campo (e categoria);
 *   - o PUT leva o objeto certo: prefixo, post_type, campos, categorias e o
 *     que esconder;
 *   - a chave do dado nasce do rótulo (o leigo não digita a chave).
 *
 * Os locators das linhas usam `within` dentro do grupo da linha: o rótulo
 * "Rótulo" se repete em cada linha, e um `getByLabelText("Rótulo")` na tela
 * inteira seria ambíguo.
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
      { chave: "quartos", rotulo: "Quartos", meta_key: "quartos", tipo: "numero", filtro: "minimo" },
    ],
    categorias: [
      {
        chave: "bairro",
        rotulo: "Bairro",
        taxonomia: "localizacao",
        nivel: "filho",
        filtro: "contem",
      },
    ],
    esconder: { meta_key: "status_imovel", valores: ["vendido"] },
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
    instancia: { id: "inst-1", receita: "wordpress-conteudo", rotulo: "Conteúdo" },
    colunas: ["id", "titulo"],
    linhas: [{ id: "1", titulo: "Apê" }],
    linhas_devolvidas: 1,
  });

  const ui = <ReceitasProntas connectionId="conn-1" motor="mysql" canWrite={canWrite} />;
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** A tela de ESCOLHER a receita: clica "Adicionar receita" e escolhe uma. */
async function adicionarReceita(escolha: "wordpress" | "woocommerce") {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Adicionar receita/i }));
  });
  const botao =
    escolha === "wordpress"
      ? screen.getByRole("button", { name: /Conteúdo do WordPress/ })
      : screen.getByRole("button", { name: /Produtos da loja WooCommerce/ });
  await act(async () => {
    fireEvent.click(botao);
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

describe("Receitas prontas — escolher a receita ao adicionar", () => {
  it("clicar em Adicionar abre a ESCOLHA (não cria a primeira da lista)", async () => {
    renderComQuery([], true);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Adicionar receita/i }));
    });

    expect(screen.getByText("Qual receita você quer usar?")).toBeInTheDocument();
    // As duas receitas do registro aparecem, com o rótulo e a descrição.
    expect(screen.getByRole("button", { name: /Conteúdo do WordPress/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Produtos da loja WooCommerce/ })).toBeInTheDocument();
    // E NENHUMA instância foi criada ainda.
    expect(deps.salvarReceitas).not.toHaveBeenCalled();
  });

  it("escolher o conteúdo do WordPress abre o formulário de campos e categorias", async () => {
    renderComQuery([], true);
    await adicionarReceita("wordpress");

    expect(screen.getByLabelText("Tipo de post")).toBeInTheDocument();
    expect(screen.getByText("Campos do site")).toBeInTheDocument();
    expect(screen.getByText("Categorias do site")).toBeInTheDocument();
    expect(screen.getByText("Esconder itens")).toBeInTheDocument();
  });

  it("escolher o WooCommerce NÃO abre o formulário do WordPress", async () => {
    renderComQuery([], true);
    await adicionarReceita("woocommerce");

    expect(screen.queryByLabelText("Tipo de post")).toBeNull();
    expect(screen.queryByText("Campos do site")).toBeNull();
    // E o PUT leva a receita escolhida.
    const fixos = await salvarEObterFixos();
    expect(fixos.prefixo).toBe("wp_");
  });

  it("editar uma instância salva NÃO mostra a escolha de receita", async () => {
    renderComQuery([INSTANCIA_WORDPRESS], true);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Editar/i }));
    });

    expect(screen.queryByText("Qual receita você quer usar?")).toBeNull();
    // E o que estava salvo volta na tela.
    expect(screen.getByLabelText("Tipo de post")).toHaveValue("imovel");
    expect(screen.getByRole("group", { name: "Preço de venda" })).toBeInTheDocument();
  });
});

describe("Receitas prontas — o modelo Imóveis", () => {
  it("aplicar o modelo preenche a lista de campos e a de categorias", async () => {
    renderComQuery([], true);
    await adicionarReceita("wordpress");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Imóveis" }));
    });

    // Os campos do cadastro de imobiliária.
    for (const rotulo of ["Código", "Preço de venda", "Aluguel", "Quartos", "Vagas", "Área"]) {
      expect(screen.getByRole("group", { name: rotulo })).toBeInTheDocument();
    }
    // As categorias.
    for (const rotulo of ["Bairro", "Cidade", "Tipo", "Finalidade"]) {
      expect(screen.getByRole("group", { name: rotulo })).toBeInTheDocument();
    }
    // E o que esconder.
    expect(screen.getByLabelText("Campo a esconder")).toHaveValue("status_imovel");
    expect(screen.getByLabelText("Valores a esconder")).toHaveValue("vendido, alugado");
  });

  it("o modelo traz o tipo de post e a configuração no PUT", async () => {
    renderComQuery([], true);
    await adicionarReceita("wordpress");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Imóveis" }));
    });

    expect(screen.getByLabelText("Tipo de post")).toHaveValue("imovel");

    const fixos = await salvarEObterFixos();
    expect(fixos.post_type).toBe("imovel");
    const campos = fixos.campos as Array<{ chave: string; meta_key: string; tipo: string }>;
    expect(campos.map((c) => c.chave)).toContain("preco");
    expect(campos.find((c) => c.chave === "preco")?.tipo).toBe("preco");
    const categorias = fixos.categorias as Array<{ chave: string; taxonomia: string }>;
    expect(categorias.find((c) => c.chave === "bairro")?.taxonomia).toBe("localizacao");
    expect(fixos.esconder).toEqual({ meta_key: "status_imovel", valores: ["vendido", "alugado"] });
  });

  it("trocar de modelo com algo preenchido pede confirmação", async () => {
    renderComQuery([], true);
    await adicionarReceita("wordpress");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Imóveis" }));
    });

    // Com o modelo já aplicado, trocar apaga o que está preenchido.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Em branco" }));
    });
    expect(screen.getByText("Trocar de modelo apaga o que você preencheu. Quer continuar?")).toBeInTheDocument();
  });

  it("aplicar o modelo com o TIPO DE POST digitado pergunta antes de trocar", async () => {
    // O modelo "Imóveis" traz o tipo de post DELE ("imovel"). A pessoa tinha
    // escrito o tipo do site dela: trocar em silêncio deixaria a receita
    // apontando para um tipo de post que o site não tem.
    renderComQuery([], true);
    await adicionarReceita("wordpress");
    await act(async () => {
      fireEvent.input(screen.getByLabelText("Tipo de post"), { target: { value: "imovel_venda" } });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Imóveis" }));
    });

    expect(screen.getByText("Trocar de modelo apaga o que você preencheu. Quer continuar?")).toBeInTheDocument();
    // E nada foi trocado sem a resposta: o tipo digitado continua.
    expect(screen.getByLabelText("Tipo de post")).toHaveValue("imovel_venda");
  });
});

describe("Receitas prontas — a lista de campos", () => {
  it("dá para adicionar e remover campo", async () => {
    renderComQuery([], true);
    await adicionarReceita("wordpress");

    expect(screen.getAllByRole("group")).toHaveLength(1);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Adicionar campo/i }));
    });
    expect(screen.getAllByRole("group")).toHaveLength(2);

    const remover = screen.getAllByRole("button", { name: "Remover campo" });
    await act(async () => {
      fireEvent.click(remover[remover.length - 1]!);
    });
    expect(screen.getAllByRole("group")).toHaveLength(1);
  });

  it("dá para adicionar e remover categoria", async () => {
    renderComQuery([], true);
    await adicionarReceita("wordpress");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Adicionar categoria/i }));
    });
    expect(screen.getAllByRole("group")).toHaveLength(2);

    const remover = screen.getAllByRole("button", { name: "Remover categoria" });
    await act(async () => {
      fireEvent.click(remover[0]!);
    });
    expect(screen.getAllByRole("group")).toHaveLength(1);
  });

  it("a chave nasce do rótulo (o leigo não digita a chave)", async () => {
    renderComQuery([], true);
    await adicionarReceita("wordpress");

    const grupo = screen.getByRole("group", { name: "Campo" });
    await act(async () => {
      fireEvent.input(within(grupo).getByLabelText("Rótulo"), {
        target: { value: "Quilometragem" },
      });
    });

    // A chave aparece no "avançado".
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Chaves \(avançado\)/i }));
    });
    expect(screen.getByLabelText("Chave")).toHaveValue("quilometragem");
  });

  it("a chave RESERVADA da saída não nasce do rótulo (o 'Título' vira 'titulo_2')", async () => {
    // `titulo` já é coluna da saída: um dado com o mesmo nome colidiria com
    // ela, e o servidor recusaria com um erro que a pessoa não entende.
    renderComQuery([], true);
    await adicionarReceita("wordpress");

    const grupo = screen.getByRole("group", { name: "Campo" });
    await act(async () => {
      fireEvent.input(within(grupo).getByLabelText("Rótulo"), { target: { value: "Título" } });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Chaves \(avançado\)/i }));
    });
    expect(screen.getByLabelText("Chave")).toHaveValue("titulo_2");
  });

  it("um rótulo que NÃO vira chave recusa a gravação, dizendo o que escrever", async () => {
    // "!!!" não vira chave nenhuma: o dado ficaria sem nome na saída. A tela
    // recusa ANTES do clique, com frase legível — não com erro de validação.
    renderComQuery([], true);
    await adicionarReceita("wordpress");
    await act(async () => {
      fireEvent.input(screen.getByLabelText("Tipo de post"), { target: { value: "imovel" } });
    });

    const grupo = screen.getByRole("group", { name: "Campo" });
    await act(async () => {
      fireEvent.input(within(grupo).getByLabelText("Rótulo"), { target: { value: "!!!" } });
    });
    const grupoDoCampo = screen.getByRole("group", { name: "!!!" });
    await act(async () => {
      fireEvent.input(within(grupoDoCampo).getByLabelText("Campo no site"), {
        target: { value: "chave" },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Salvar/i }));
    });

    expect(deps.salvarReceitas).not.toHaveBeenCalled();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      "Um dos rótulos não virou uma chave. Escreva o rótulo com letras ou números.",
    );
  });
});

describe("Receitas prontas — o que vai para o PUT", () => {
  it("leva prefixo, post_type, campos, categorias e o que esconder", async () => {
    renderComQuery([], true);
    await adicionarReceita("wordpress");

    await act(async () => {
      fireEvent.input(screen.getByLabelText("Tipo de post"), { target: { value: "veiculo" } });
    });
    // O rótulo primeiro: é dele que nasce a chave ("ano").
    const grupo = screen.getByRole("group", { name: "Campo" });
    await act(async () => {
      fireEvent.input(within(grupo).getByLabelText("Rótulo"), { target: { value: "Ano" } });
    });
    const grupoDoAno = screen.getByRole("group", { name: "Ano" });
    await act(async () => {
      fireEvent.input(within(grupoDoAno).getByLabelText("Campo no site"), {
        target: { value: "ano" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Adicionar categoria/i }));
    });
    const grupoCat = screen.getByRole("group", { name: "Categoria" });
    await act(async () => {
      fireEvent.input(within(grupoCat).getByLabelText("Rótulo"), { target: { value: "Marca" } });
    });
    const grupoDaMarca = screen.getByRole("group", { name: "Marca" });
    await act(async () => {
      fireEvent.input(within(grupoDaMarca).getByLabelText("Categoria no site"), {
        target: { value: "marca_veiculo" },
      });
    });
    await act(async () => {
      fireEvent.input(screen.getByLabelText("Campo a esconder"), {
        target: { value: "status_veiculo" },
      });
    });
    await act(async () => {
      fireEvent.input(screen.getByLabelText("Valores a esconder"), {
        target: { value: "vendido" },
      });
    });

    const fixos = await salvarEObterFixos();
    expect(fixos.prefixo).toBe("wp_");
    expect(fixos.post_type).toBe("veiculo");
    const campos = fixos.campos as Array<{ chave: string; rotulo: string; meta_key: string }>;
    expect(campos).toHaveLength(1);
    expect(campos[0]).toMatchObject({ chave: "ano", rotulo: "Ano", meta_key: "ano" });
    const categorias = fixos.categorias as Array<{ chave: string; taxonomia: string }>;
    expect(categorias[0]).toMatchObject({ chave: "marca", taxonomia: "marca_veiculo" });
    expect(fixos.esconder).toEqual({ meta_key: "status_veiculo", valores: ["vendido"] });
  });

  it("sem o tipo de post, a tela não grava (e diz o que falta)", async () => {
    renderComQuery([], true);
    await adicionarReceita("wordpress");
    const grupo = screen.getByRole("group", { name: "Campo" });
    await act(async () => {
      fireEvent.input(within(grupo).getByLabelText("Rótulo"), { target: { value: "Ano" } });
    });
    const grupoDoAno = screen.getByRole("group", { name: "Ano" });
    await act(async () => {
      fireEvent.input(within(grupoDoAno).getByLabelText("Campo no site"), {
        target: { value: "ano" },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Salvar/i }));
    });

    expect(deps.salvarReceitas).not.toHaveBeenCalled();
    // E a tela diz o que falta, em vez de falhar em silêncio.
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Escreva o tipo de post do site.");
  });

  it("campo apagado e não preenchido não grava: a tela recusa e diz o que falta", async () => {
    renderComQuery([INSTANCIA_WORDPRESS], true);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Editar/i }));
    });
    const grupo = screen.getByRole("group", { name: "Preço de venda" });
    await act(async () => {
      fireEvent.input(within(grupo).getByLabelText("Campo no site"), { target: { value: "" } });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Salvar/i }));
    });

    // A recusa do editor impede a gravação: salvarReceitas nunca é chamado.
    expect(deps.salvarReceitas).not.toHaveBeenCalled();
    // E a tela diz o que falta, em vez de falhar em silêncio.
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      "Preencha o rótulo e o nome do campo de todos os dados.",
    );
  });
});

describe("Receitas prontas — o filtro de campo do WordPress", () => {
  it("campo de TEXTO oferece só Nenhum e Contém (o schema da receita recusa 'Igual')", async () => {
    renderComQuery([INSTANCIA_WORDPRESS], true);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Editar/i }));
    });
    const grupo = screen.getByRole("group", { name: "Quartos" });
    await act(async () => {
      fireEvent.change(within(grupo).getByLabelText("Tipo"), { target: { value: "texto" } });
    });

    const opcoes = Array.from(
      (within(grupo).getByLabelText("Filtro") as HTMLSelectElement).options,
    ).map((o) => o.value);
    expect(opcoes).toEqual(["nenhum", "contem"]);
  });
});
