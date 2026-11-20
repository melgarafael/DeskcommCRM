/**
 * OS RANKINGS DE NEGÓCIOS GANHOS, dentro da tela de Faturamento (#4280).
 *
 * Cada caso prende uma promessa:
 *
 *   1. PERÍODO VAZIO: o bloco diz que não houve negócio ganho — não desenha
 *      tabela de zeros.
 *   2. NENHUM BOTÃO DE ESCRITA, NENHUM PERÍODO PRÓPRIO: é SÓ LEITURA, e o
 *      período é o que a tela de Faturamento entrega (`de`/`ate`). Um seletor
 *      de período aqui seriam dois meses na mesma página. Os únicos seletores
 *      são os do RECORTE — funil e tag (#4802, item 4).
 *   3. SEM NÚMERO DE FATURAMENTO PRÓPRIO (doc 306): o total que vale é o da
 *      tela. Se o cartão "Faturamento do período" voltar, o caso reprova.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/hooks/reports/useCommercialReport", () => ({
  useCommercialReport: vi.fn(),
}));

import { useCommercialReport } from "@/hooks/reports/useCommercialReport";
import type { RespostaDoRelatorioComercial } from "@/lib/relatorios/comercial";

import { RankingsDeNegociosGanhos } from "./rankings-de-negocios-ganhos";

const JANELA = {
  de: "2026-09-01",
  ate: "2026-09-30",
  tz: "America/Sao_Paulo",
  from: "2026-09-01T03:00:00.000Z",
  to: "2026-10-01T03:00:00.000Z",
};

function relatorio(patch: Partial<RespostaDoRelatorioComercial> = {}): RespostaDoRelatorioComercial {
  return {
    janela: JANELA,
    padrao: true,
    moeda: "BRL",
    negocios_ganhos: 0,
    negocios_sem_valor: 0,
    tags: [],
    total_etiquetagens: 0,
    clientes: [],
    negocios_sem_contato: 0,
    funis: [],
    filtro: { pipeline_id: null, tag: null },
    opcoes: { pipeline_ids: [], tags: [] },
    vendas: [],
    vendas_no_filtro: 0,
    excluidos: { outra_moeda: 0, sem_data_de_ganho: 0 },
    sem_dados: true,
    motivo: "nenhum_negocio_ganho_no_periodo",
    truncado: false,
    nota: null,
    contatos: {},
    nomes_dos_funis: {},
    ...patch,
  };
}

const FUNIL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FUNIL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** Um período com vendas em dois funis — o caso típico do recorte. */
function comVendas(patch: Partial<RespostaDoRelatorioComercial> = {}) {
  return relatorio({
    sem_dados: false,
    motivo: null,
    negocios_ganhos: 2,
    tags: [{ tag: "recompra", centavos: 30_000, negocios: 1 }],
    total_etiquetagens: 1,
    clientes: [{ contact_id: "c1", centavos: 50_000, negocios: 2 }],
    funis: [
      { pipeline_id: FUNIL_A, centavos: 30_000, negocios: 1 },
      { pipeline_id: FUNIL_B, centavos: 20_000, negocios: 1 },
    ],
    opcoes: { pipeline_ids: [FUNIL_A, FUNIL_B], tags: ["recompra"] },
    vendas: [
      {
        id: "v1",
        titulo: "Plano anual",
        contact_id: "c1",
        pipeline_id: FUNIL_A,
        ganho_em: "2026-09-20T15:00:00.000Z",
        centavos: 30_000,
        tags: ["recompra"],
      },
      {
        id: "v2",
        titulo: null,
        contact_id: "c1",
        pipeline_id: FUNIL_B,
        ganho_em: "2026-09-05T15:00:00.000Z",
        centavos: null,
        tags: [],
      },
    ],
    vendas_no_filtro: 2,
    contatos: { c1: { id: "c1", display_name: "Ana", name: "Ana", phone_number: null } },
    nomes_dos_funis: { [FUNIL_A]: "Vendas", [FUNIL_B]: "Recompra" },
    ...patch,
  });
}

function responder(payload: RespostaDoRelatorioComercial) {
  vi.mocked(useCommercialReport).mockReturnValue({
    data: { data: payload },
    isLoading: false,
    isError: false,
  } as never);
}

/** Nenhum botão de escrita na tela — o teste falha se um aparecer. */
function semBotaoQueMudaDado() {
  const proibidos = /adicionar|novo|nova|salvar|editar|excluir|apagar|exportar|importar/i;
  const rotulos = screen
    .queryAllByRole("button")
    .map((b) => b.textContent ?? "")
    .filter((texto) => proibidos.test(texto));
  expect(rotulos).toEqual([]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

const PERIODO = { de: "2026-09-01", ate: "2026-09-30" };

describe("RankingsDeNegociosGanhos", () => {
  it("período vazio: diz que não houve negócio ganho, sem desenhar zeros", () => {
    responder(relatorio());
    render(<RankingsDeNegociosGanhos {...PERIODO} />);

    expect(screen.getByText("Nenhum negócio ganho no período.")).toBeTruthy();
    // Nenhuma tabela é desenhada — zero na tela leria como "vendemos nada".
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("Tags que mais vendem")).toBeNull();
    semBotaoQueMudaDado();
  });

  it("lê o período que a tela entrega, e não tem seletor de período próprio", () => {
    responder(comVendas());
    render(<RankingsDeNegociosGanhos de="2026-01-05" ate="2026-01-20" />);

    expect(vi.mocked(useCommercialReport)).toHaveBeenLastCalledWith({
      de: "2026-01-05",
      ate: "2026-01-20",
      pipelineId: "",
      tag: "",
    });
    // Nem data, nem atalho de período: quem escolhe o período é a tela.
    expect(document.querySelector('input[type="date"]')).toBeNull();
    // Os ÚNICOS seletores são os do recorte — funil e tag.
    const seletores = screen.queryAllByRole("combobox").map((s) => s.getAttribute("data-testid"));
    expect(seletores).toEqual(["recorte-funil", "recorte-tag"]);
  });

  it("o seletor de funil oferece os funis do período pelo nome, e recorta ao escolher", () => {
    responder(comVendas());
    render(<RankingsDeNegociosGanhos {...PERIODO} />);

    const funil = screen.getByTestId("recorte-funil") as HTMLSelectElement;
    const nomes = [...funil.options].map((o) => o.textContent);
    expect(nomes).toEqual(["Todos os funis", "Vendas", "Recompra"]);

    fireEvent.change(funil, { target: { value: FUNIL_B } });

    expect(vi.mocked(useCommercialReport)).toHaveBeenLastCalledWith({
      ...PERIODO,
      pipelineId: FUNIL_B,
      tag: "",
    });
  });

  it("clicar numa tag do ranking recorta por ela", () => {
    responder(comVendas());
    render(<RankingsDeNegociosGanhos {...PERIODO} />);

    fireEvent.click(screen.getByTitle("Ver as vendas desta tag"));

    expect(vi.mocked(useCommercialReport)).toHaveBeenLastCalledWith({
      ...PERIODO,
      pipelineId: "",
      tag: "recompra",
    });
  });

  it("a lista mostra cada venda, e valor ausente aparece como 'sem valor'", () => {
    responder(comVendas());
    render(<RankingsDeNegociosGanhos {...PERIODO} />);

    const lista = screen.getByTestId("lista-de-vendas");
    expect(lista.textContent).toContain("Plano anual");
    expect(lista.textContent).toContain("Vendas (2)");
    expect(lista.textContent).toContain("sem valor");
    expect(screen.getByText("Funis que mais vendem")).toBeTruthy();
    semBotaoQueMudaDado();
  });

  it("recorte sem venda mantém os seletores e diz como sair", () => {
    responder(
      comVendas({
        negocios_ganhos: 0,
        tags: [],
        clientes: [],
        funis: [],
        vendas: [],
        vendas_no_filtro: 0,
        filtro: { pipeline_id: FUNIL_B, tag: "recompra" },
      }),
    );
    render(<RankingsDeNegociosGanhos {...PERIODO} />);

    expect(screen.getByTestId("recorte-vazio")).toBeTruthy();
    expect(screen.getByTestId("recorte-funil")).toBeTruthy();
    expect(screen.getByTestId("recorte-limpar")).toBeTruthy();
    expect(screen.queryByText("Nenhum negócio ganho no período.")).toBeNull();
  });

  it("com dado: mostra os dois rankings e o nome do cliente, sem total próprio de vendas", () => {
    responder(
      relatorio({
        sem_dados: false,
        motivo: null,
        negocios_ganhos: 2,
        tags: [
          { tag: "plano", centavos: 100_000, negocios: 1 },
          { tag: "setup", centavos: 50_000, negocios: 1 },
        ],
        total_etiquetagens: 2,
        clientes: [{ contact_id: "c1", centavos: 150_000, negocios: 2 }],
        contatos: { c1: { id: "c1", display_name: "Ana", name: "Ana", phone_number: null } },
      }),
    );

    render(<RankingsDeNegociosGanhos {...PERIODO} />);

    // O número de faturamento é o da tela de Faturamento — aqui não há outro.
    expect(screen.queryByText("Faturamento do período")).toBeNull();
    expect(screen.getByText("Tags que mais vendem")).toBeTruthy();
    expect(screen.getByText("Clientes que mais compram")).toBeTruthy();
    expect(screen.getByText("plano")).toBeTruthy();
    expect(screen.getByText("Ana")).toBeTruthy();
    semBotaoQueMudaDado();
  });

  it("declara o que ficou fora em vez de esconder", () => {
    responder(
      relatorio({
        sem_dados: false,
        motivo: null,
        negocios_ganhos: 1,
        negocios_sem_valor: 1,
        excluidos: { outra_moeda: 2, sem_data_de_ganho: 3 },
      }),
    );

    render(<RankingsDeNegociosGanhos {...PERIODO} />);

    const lista = screen.getByRole("list");
    expect(lista.textContent).toContain("outra moeda");
    expect(lista.textContent).toContain("sem data de fechamento");
    expect(lista.textContent).toContain("sem valor preenchido");
  });
});

describe("o funil ou a tag que sumiu do período (revisão do #4941)", () => {
  function responderComo(payload: RespostaDoRelatorioComercial, isPlaceholderData: boolean) {
    vi.mocked(useCommercialReport).mockReturnValue({
      data: { data: payload },
      isLoading: false,
      isError: false,
      isPlaceholderData,
    } as never);
  }

  it("período novo sem o funil escolhido: o recorte é zerado, e o seletor diz a verdade", () => {
    responder(comVendas());
    const { rerender } = render(<RankingsDeNegociosGanhos {...PERIODO} />);
    fireEvent.change(screen.getByTestId("recorte-funil"), { target: { value: FUNIL_B } });

    // O período mudou no topo: a resposta NOVA não tem o FUNIL_B nas opções.
    const outroPeriodo = { de: "2026-10-01", ate: "2026-10-31" };
    responderComo(comVendas({ opcoes: { pipeline_ids: [FUNIL_A], tags: ["recompra"] } }), false);
    rerender(<RankingsDeNegociosGanhos {...outroPeriodo} />);

    expect(vi.mocked(useCommercialReport)).toHaveBeenLastCalledWith({
      ...outroPeriodo,
      pipelineId: "",
      tag: "",
    });
    expect((screen.getByTestId("recorte-funil") as HTMLSelectElement).value).toBe("");
  });

  it("a tag que sumiu também é zerada, e o funil que continua fica", () => {
    responder(comVendas());
    const { rerender } = render(<RankingsDeNegociosGanhos {...PERIODO} />);
    fireEvent.change(screen.getByTestId("recorte-funil"), { target: { value: FUNIL_A } });
    fireEvent.click(screen.getByTitle("Ver as vendas desta tag"));

    responderComo(comVendas({ opcoes: { pipeline_ids: [FUNIL_A], tags: [] } }), false);
    rerender(<RankingsDeNegociosGanhos de="2026-10-01" ate="2026-10-31" />);

    expect(vi.mocked(useCommercialReport)).toHaveBeenLastCalledWith({
      de: "2026-10-01",
      ate: "2026-10-31",
      pipelineId: FUNIL_A,
      tag: "",
    });
  });

  it("a resposta ANTIGA (enquanto o período novo carrega) não zera um filtro válido", () => {
    responder(comVendas());
    const { rerender } = render(<RankingsDeNegociosGanhos {...PERIODO} />);
    fireEvent.change(screen.getByTestId("recorte-funil"), { target: { value: FUNIL_B } });

    // keepPreviousData: ainda é a resposta do período anterior, sem o FUNIL_B.
    responderComo(comVendas({ opcoes: { pipeline_ids: [FUNIL_A], tags: ["recompra"] } }), true);
    rerender(<RankingsDeNegociosGanhos de="2026-10-01" ate="2026-10-31" />);

    expect(vi.mocked(useCommercialReport)).toHaveBeenLastCalledWith({
      de: "2026-10-01",
      ate: "2026-10-31",
      pipelineId: FUNIL_B,
      tag: "",
    });
  });
});
