/**
 * OS RANKINGS DE NEGÓCIOS GANHOS, dentro da tela de Faturamento (#4280).
 *
 * Cada caso prende uma promessa:
 *
 *   1. PERÍODO VAZIO: o bloco diz que não houve negócio ganho — não desenha
 *      tabela de zeros.
 *   2. NENHUM BOTÃO, NENHUM PERÍODO PRÓPRIO: é SÓ LEITURA, e o período é o que a
 *      tela de Faturamento entrega (`de`/`ate`). Um seletor aqui seriam dois
 *      meses na mesma página.
 *   3. SEM NÚMERO DE FATURAMENTO PRÓPRIO (doc 306): o total que vale é o da
 *      tela. Se o cartão "Faturamento do período" voltar, o caso reprova.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

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
    excluidos: { outra_moeda: 0, sem_data_de_ganho: 0 },
    sem_dados: true,
    motivo: "nenhum_negocio_ganho_no_periodo",
    truncado: false,
    nota: null,
    contatos: {},
    ...patch,
  };
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

  it("lê o período que a tela entrega, e não tem seletor próprio", () => {
    responder(relatorio());
    render(<RankingsDeNegociosGanhos de="2026-01-05" ate="2026-01-20" />);

    expect(vi.mocked(useCommercialReport)).toHaveBeenLastCalledWith({
      de: "2026-01-05",
      ate: "2026-01-20",
    });
    // Nem data, nem atalho de período: quem escolhe o período é a tela.
    expect(document.querySelector('input[type="date"]')).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
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
