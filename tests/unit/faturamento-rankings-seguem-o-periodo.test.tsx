import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * OS RANKINGS DE NEGÓCIOS GANHOS SEGUEM O PERÍODO DA TELA DE FATURAMENTO (#4280).
 *
 * A decisão do dono (doc 306) pôs "etiquetas que mais vendem" e "clientes que
 * mais compram" DENTRO da tela de Faturamento, sem tela nova. A promessa que
 * este arquivo prende é a que faz isso valer: os dois blocos leem o MESMO `de` e
 * `ate` que o relatório financeiro. Se um dia o bloco ganhar período próprio — ou
 * cair no "mês corrente do servidor" —, a tela mostra janeiro em cima e novembro
 * embaixo, e este caso reprova.
 *
 * Aqui a tela é montada inteira, com o cliente de API de dublê: o que se mede é a
 * URL pedida, que é o que de fato chega ao servidor.
 */

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { Faturamento } from "@/app/app/faturamento/_client";
import { apiClient } from "@/lib/api/client";
import type { RespostaDoRelatorioComercial } from "@/lib/relatorios/comercial";

const FINANCEIRO = "/api/v1/reports/financeiro";
const COMERCIAL = "/api/v1/reports/comercial";

const RANKINGS: RespostaDoRelatorioComercial = {
  janela: {
    de: "2026-01-01",
    ate: "2026-01-31",
    tz: "America/Sao_Paulo",
    from: "2026-01-01T03:00:00.000Z",
    to: "2026-02-01T03:00:00.000Z",
  },
  padrao: false,
  moeda: "BRL",
  negocios_ganhos: 1,
  negocios_sem_valor: 0,
  tags: [{ tag: "plano", centavos: 50_000, negocios: 1 }],
  total_etiquetagens: 1,
  clientes: [{ contact_id: "c1", centavos: 50_000, negocios: 1 }],
  negocios_sem_contato: 0,
  excluidos: { outra_moeda: 0, sem_data_de_ganho: 0 },
  sem_dados: false,
  motivo: null,
  truncado: false,
  nota: null,
  contatos: { c1: { id: "c1", display_name: "Ana", name: "Ana", phone_number: null } },
};

const FINANCEIRO_VAZIO = {
  de: "2026-01-01",
  ate: "2026-01-31",
  entradas_cents: 0,
  saidas_cents: 0,
  saldo_cents: 0,
  comandas_finalizadas: 0,
  comandas_estornadas: 0,
  faturado_cents: 0,
  ticket_medio_cents: 0,
  por_forma: [],
  por_profissional: [],
  por_servico: [],
  por_cliente: [],
};

/** O período (`de=…&ate=…`) do último pedido feito a esta rota. */
function ultimoPeriodoPedido(rota: string): string | undefined {
  const pedidos = vi
    .mocked(apiClient.get)
    .mock.calls.map((chamada) => String(chamada[0]))
    .filter((url) => url.startsWith(`${rota}?`));
  return pedidos[pedidos.length - 1]?.slice(rota.length + 1);
}

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    if (url.startsWith(COMERCIAL)) return { data: RANKINGS };
    if (url.startsWith(FINANCEIRO)) return { data: FINANCEIRO_VAZIO };
    return { data: [] };
  });
});

describe("faturamento — os rankings de negócios ganhos seguem o período da tela", () => {
  it("os dois blocos aparecem na tela de Faturamento, pedidos com o mesmo período do relatório", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <Faturamento podeLancar={false} moedaDaOrg="BRL" />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Tags que mais vendem")).toBeTruthy();
    expect(screen.getByText("Clientes que mais compram")).toBeTruthy();
    expect(screen.getByText("plano")).toBeTruthy();
    // Um número de faturamento só: o da tela. O bloco não traz o dele.
    expect(screen.queryByText("Faturamento do período")).toBeNull();

    // Período inicial: o mês corrente da tela — o MESMO nas duas rotas.
    expect(ultimoPeriodoPedido(COMERCIAL)).toBeTruthy();
    expect(ultimoPeriodoPedido(COMERCIAL)).toBe(ultimoPeriodoPedido(FINANCEIRO));

    // Mudou o período na tela: os rankings vão junto.
    fireEvent.change(screen.getByTestId("periodo-de"), { target: { value: "2026-01-05" } });
    fireEvent.change(screen.getByTestId("periodo-ate"), { target: { value: "2026-01-20" } });

    await waitFor(() =>
      expect(ultimoPeriodoPedido(COMERCIAL)).toBe("de=2026-01-05&ate=2026-01-20"),
    );
    await waitFor(() =>
      expect(ultimoPeriodoPedido(FINANCEIRO)).toBe("de=2026-01-05&ate=2026-01-20"),
    );
  });
});
