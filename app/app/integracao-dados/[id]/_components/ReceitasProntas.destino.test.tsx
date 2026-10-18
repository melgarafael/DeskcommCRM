/**
 * Receitas prontas — "Funil de destino" do lead de interesse (Spec 25 R5 / D6).
 * Prova:
 *   - o cartão diz para onde vão os leads ("Leads vão para: Funil › Etapa") ou que
 *     não há destino ("interesse vira aviso na Central");
 *   - na edição o admin escolhe funil e etapa, e o salvar leva `destino` completo;
 *   - funil sem etapa escolhida NÃO grava destino pela metade;
 *   - os textos novos existem em espanhol.
 */
import type { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import ReceitasProntas from "./ReceitasProntas";
import { traduzir } from "@/lib/i18n/dicionario";
import type { InstanciaDeReceita } from "@/lib/external-db/receitas/tipos";

const FUNIL = "66666666-6666-4666-8666-666666666666";
const ETAPA = "77777777-7777-4777-8777-777777777777";

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

const deps = vi.hoisted(() => ({
  useReceitasDaConexao: vi.fn(),
  salvarReceitas: vi.fn(),
  previewReceita: vi.fn(),
  sugerirCamposACF: vi.fn(),
  sugerirCamposJetEngine: vi.fn(),
  sugerirCamposTabelaDireta: vi.fn(),
  useFunis: vi.fn(),
  useEtapas: vi.fn(),
}));

vi.mock("@/hooks/external-db/useReceitasDaConexao", () => ({
  useReceitasDaConexao: deps.useReceitasDaConexao,
  salvarReceitas: deps.salvarReceitas,
  previewReceita: deps.previewReceita,
  sugerirCamposACF: deps.sugerirCamposACF,
  sugerirCamposJetEngine: deps.sugerirCamposJetEngine,
  sugerirCamposTabelaDireta: deps.sugerirCamposTabelaDireta,
}));
vi.mock("@/hooks/external-db/useDestinoDeReceita", () => ({
  useFunisParaDestino: deps.useFunis,
  useEtapasParaDestino: deps.useEtapas,
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/lib/random-id", () => ({ randomId: () => "id-gerado" }));

const INSTANCIA: InstanciaDeReceita = {
  id: "inst-1",
  receita: "acf-imoveis",
  rotulo: "Imóveis do site",
  descricao: "",
  fixos: { prefixo: "wp_", post_type: "imovel", campos: { preco: "preco", quartos: "quartos", bairro: "bairro" } },
  ativa: true,
};

function montar(receitas: InstanciaDeReceita[], canWrite = true) {
  deps.useReceitasDaConexao.mockReturnValue({
    data: { receitas },
    isError: false,
    refetch: vi.fn(async () => ({})),
  });
  deps.salvarReceitas.mockResolvedValue({ receitas });
  deps.useFunis.mockReturnValue({
    data: [
      { id: FUNIL, name: "Vendas de imóveis" },
      { id: "outro", name: "Pós-venda" },
    ],
    isError: false,
  });
  deps.useEtapas.mockImplementation((pipelineId: string | null) => ({
    data: pipelineId
      ? [
          { id: ETAPA, name: "Interessado", is_won: false, is_lost: false },
          { id: "ganho", name: "Fechado", is_won: true, is_lost: false },
        ]
      : undefined,
    isError: false,
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ReceitasProntas connectionId="conn-1" motor="mysql" canWrite={canWrite} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("cartão da instância", () => {
  it("com destino: 'Leads vão para: Funil › Etapa'", () => {
    montar([{ ...INSTANCIA, destino: { pipeline_id: FUNIL, stage_id: ETAPA } }]);
    expect(screen.getByText("Vendas de imóveis › Interessado")).toBeInTheDocument();
    expect(screen.getByText(/Leads vão para:/)).toBeInTheDocument();
  });

  it("sem destino: diz que o interesse vira aviso na Central", () => {
    montar([INSTANCIA]);
    expect(screen.getByText("Sem funil de destino: interesse vira aviso na Central")).toBeInTheDocument();
  });

  it("quem não escreve vê o aviso sem consultar os funis (a rota é de gestor)", () => {
    montar([{ ...INSTANCIA, destino: { pipeline_id: FUNIL, stage_id: ETAPA } }], false);
    expect(deps.useFunis).toHaveBeenCalledWith(false);
    expect(screen.getByText(/Leads vão para:/)).toBeInTheDocument();
  });
});

describe("edição", () => {
  async function editar() {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Editar/i }));
    });
  }

  it("escolher funil e etapa e salvar envia o destino completo", async () => {
    montar([INSTANCIA]);
    await editar();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Funil"), { target: { value: FUNIL } });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Etapa de destino"), { target: { value: ETAPA } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Salvar$/i }));
    });

    const enviado = deps.salvarReceitas.mock.calls[0]![1] as InstanciaDeReceita[];
    expect(enviado[0]!.destino).toEqual({ pipeline_id: FUNIL, stage_id: ETAPA });
  });

  it("funil sem etapa: não grava destino pela metade", async () => {
    montar([INSTANCIA]);
    await editar();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Funil"), { target: { value: FUNIL } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Salvar$/i }));
    });
    const enviado = deps.salvarReceitas.mock.calls[0]![1] as InstanciaDeReceita[];
    expect(enviado[0]!.destino).toBeUndefined();
  });

  it("etapa de ganho ou perda não é oferecida como destino", async () => {
    montar([INSTANCIA]);
    await editar();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Funil"), { target: { value: FUNIL } });
    });
    expect(screen.queryByRole("option", { name: "Fechado" })).toBeNull();
    expect(screen.getByRole("option", { name: "Interessado" })).toBeInTheDocument();
  });

  it("voltar para 'Sem funil de destino' remove o destino salvo", async () => {
    montar([{ ...INSTANCIA, destino: { pipeline_id: FUNIL, stage_id: ETAPA } }]);
    await editar();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Funil"), { target: { value: "" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Salvar$/i }));
    });
    const enviado = deps.salvarReceitas.mock.calls[0]![1] as InstanciaDeReceita[];
    expect(enviado[0]!.destino).toBeUndefined();
  });
});

describe("espanhol", () => {
  it("todo texto novo da R5 tem tradução", () => {
    for (const texto of [
      "Funil de destino",
      "Sem funil de destino",
      "Leads vão para:",
      "o funil configurado",
      "Sem funil de destino: interesse vira aviso na Central",
      "Quando o cliente demonstra interesse em um item, o lead nasce neste funil e etapa.",
      "Escolha a etapa",
      "Não foi possível carregar os funis.",
      "Interesse em item sem funil de destino",
    ]) {
      expect(traduzir(texto, "es"), texto).not.toBe(texto);
    }
  });
});
