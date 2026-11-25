import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { apiClient } from "@/lib/api/client";
import { MetricsClient } from "./MetricsClient";

vi.mock("@/lib/api/client", () => ({ apiClient: { get: vi.fn() } }));
vi.mock("@/hooks/metrics/useMetasDoMes", () => ({
  useMetasDoMes: () => ({ isLoading: true }),
}));
vi.mock("@/hooks/metrics/usePrevisaoFunil", () => ({
  usePrevisaoFunil: () => ({ isLoading: true }),
}));
vi.mock("@/hooks/team/useTeamMembers", () => ({
  useTeamMembers: () => ({ data: undefined }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

const PRIMEIRA_JANELA = { from: "2026-09-10T15:00:00.000Z", to: "2026-10-10T15:00:00.000Z" };
const NOVA_JANELA = { from: "2026-09-10T16:00:00.000Z", to: "2026-10-10T16:00:00.000Z" };
const ESCOLHIDA = { from: "2026-09-01T03:00:00.000Z", to: "2026-09-02T03:00:00.000Z" };

const ROTAS_EXTRAS = ["atrito", "lost", "channels", "serie"];

function pedidos() {
  return vi.mocked(apiClient.get).mock.calls.map(([path]) => new URL(path, "http://localhost"));
}

function recortePedido(endpoint: string, janela: { from: string; to: string }): boolean {
  return pedidos().some((url) =>
    url.pathname === `/api/v1/metrics/${endpoint}` &&
    url.searchParams.get("from") === janela.from &&
    url.searchParams.get("to") === janela.to,
  );
}

it("envia um só período aos cinco painéis e renova a janela do servidor ao limpar", async () => {
  const padroes = [PRIMEIRA_JANELA, NOVA_JANELA];
  vi.mocked(apiClient.get).mockImplementation(async (path) => {
    const url = new URL(path, "http://localhost");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const janela = from && to ? { from, to } : undefined;
    const padrao = url.pathname.endsWith("/attendants") && !janela ? padroes.shift() : undefined;
    const resposta = {
      window: janela ?? padrao,
      owner_user_id: null,
      attendants: [],
      funnel: [],
      escopo: { demandas: 0, demandas_abertas: 0 },
      pares: [],
      regua: { abandono_horas: 72, default: 72 },
      total: 0,
      channels: [],
      porMotivo: [],
      porCategoria: [],
      porEtapa: [],
      porMoeda: [],
      baldes: [],
      truncado: false,
    };
    return { data: resposta } as never;
  });

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MetricsClient canCompare currentUserId="atendente" funis={[]} fuso="America/Sao_Paulo" />
    </QueryClientProvider>,
  );

  await waitFor(() => {
    expect(pedidos()[0]?.href).toBe("http://localhost/api/v1/metrics/attendants");
    for (const rota of ROTAS_EXTRAS) expect(recortePedido(rota, PRIMEIRA_JANELA), rota).toBe(true);
  });

  fireEvent.change(screen.getByLabelText("Data inicial"), { target: { value: "2026-09-01" } });
  fireEvent.change(screen.getByLabelText("Data final"), { target: { value: "2026-09-01" } });
  fireEvent.click(screen.getByRole("button", { name: "Aplicar" }));

  await waitFor(() => {
    for (const rota of ["attendants", ...ROTAS_EXTRAS]) {
      expect(recortePedido(rota, ESCOLHIDA), rota).toBe(true);
    }
  });

  fireEvent.click(screen.getByRole("button", { name: "Limpar" }));
  await waitFor(() => {
    expect(pedidos().filter((url) => url.href === "http://localhost/api/v1/metrics/attendants"))
      .toHaveLength(2);
    for (const rota of ROTAS_EXTRAS) expect(recortePedido(rota, NOVA_JANELA), rota).toBe(true);
  });
});
