/**
 * A TELA DO PAINEL COMERCIAL (#4280, fatia 2).
 *
 * Dois casos, e cada um prende uma promessa da fatia:
 *
 *   1. PERÍODO VAZIO: a tela diz que não houve negócio ganho — não desenha
 *      zeros como se fossem venda. O zero explícito existe na API; a tela não
 *      pode transformá-lo em gráfico.
 *   2. NENHUM BOTÃO QUE MUDE DADO: a fatia é SÓ LEITURA. O único controle
 *      interativo é o período. Se alguém acrescentar "novo negócio" aqui, este
 *      caso reprova — e é de propósito.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/hooks/reports/useCommercialReport", () => ({
  useCommercialReport: vi.fn(),
}));

import { useCommercialReport } from "@/hooks/reports/useCommercialReport";
import type { RespostaDoRelatorioComercial } from "@/lib/relatorios/comercial";

import { DashboardComercial } from "./dashboard-comercial";

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
    faturamento_centavos: 0,
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

describe("DashboardComercial", () => {
  it("período vazio: diz que não houve negócio ganho, sem desenhar zeros", () => {
    responder(relatorio());
    render(<DashboardComercial />);

    expect(screen.getByText("Nenhum negócio ganho no período.")).toBeTruthy();
    // Nenhum bloco de número é desenhado — zero na tela leria como "vendemos nada".
    expect(screen.queryByText("Faturamento do período")).toBeNull();
    semBotaoQueMudaDado();
  });

  it("com dado: mostra os três blocos e o nome do cliente", () => {
    responder(
      relatorio({
        sem_dados: false,
        motivo: null,
        faturamento_centavos: 150_000,
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

    render(<DashboardComercial />);

    expect(screen.getByText("Faturamento do período")).toBeTruthy();
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
        faturamento_centavos: 100_000,
        negocios_ganhos: 1,
        negocios_sem_valor: 1,
        excluidos: { outra_moeda: 2, sem_data_de_ganho: 3 },
      }),
    );

    render(<DashboardComercial />);

    const lista = screen.getByRole("list");
    expect(lista.textContent).toContain("outra moeda");
    expect(lista.textContent).toContain("sem data de fechamento");
    expect(lista.textContent).toContain("sem valor preenchido");
  });
});
