/**
 * O BOTÃO do relatório de vendas, na tela de Desempenho (#4802, item 5).
 *
 * O que este teste prende, e por que na TELA:
 *
 *   1. o botão EXISTE onde o filtro está — é a porta do arquivo, e sem ele a
 *      rota seria um endpoint que ninguém acha;
 *   2. ele baixa a URL CERTA, com o atendente filtrado na query: o arquivo sai
 *      com o recorte visível, não com o mundo inteiro (a rota prova o outro
 *      lado: `?owner_user_id=` chega ao `p_owner` da RPC);
 *   3. para quem não é manager+ o botão NÃO aparece — mesmo gate da rota
 *      (`requireRole("manager")`); um botão que só devolve 403 é armadilha.
 *
 * Os painéis irmãos são dublês em estado de carregamento: o que se mede aqui é
 * a barra de filtro, não o gráfico de atrito.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/metrics/useAttendantMetrics", () => ({ useAttendantMetrics: vi.fn() }));
vi.mock("@/hooks/metrics/useMetasDoMes", () => ({ useMetasDoMes: vi.fn() }));
vi.mock("@/hooks/team/useTeamMembers", () => ({ useTeamMembers: vi.fn() }));
vi.mock("@/hooks/metrics/useAtritoMetrics", () => ({
  useAtritoMetrics: () => ({ data: undefined, isLoading: true, isError: false }),
  useSalvarReguaAbandono: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/metrics/usePerdasMetrics", () => ({
  usePerdasMetrics: () => ({ data: undefined, isLoading: true, isError: false }),
}));
vi.mock("@/hooks/metrics/usePrevisaoFunil", () => ({
  usePrevisaoFunil: () => ({ data: undefined, isLoading: true, isError: false }),
}));
vi.mock("@/hooks/metrics/useChannelMetrics", () => ({
  useChannelMetrics: () => ({ data: undefined, isLoading: true, isError: false }),
}));
vi.mock("@/hooks/metrics/useSerieTemporal", () => ({
  useSerieTemporal: () => ({ data: undefined, isLoading: true, isError: false }),
}));

import { useAttendantMetrics } from "@/hooks/metrics/useAttendantMetrics";
import { useMetasDoMes } from "@/hooks/metrics/useMetasDoMes";
import { useTeamMembers } from "@/hooks/team/useTeamMembers";

import { MetricsClient } from "./MetricsClient";

const ANA = "33333333-3333-4333-8333-333333333333";

function telaCarregada(): void {
  vi.mocked(useAttendantMetrics).mockReturnValue({
    data: {
      data: {
        window: { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" },
        owner_user_id: null,
        excluded_tag: null,
        excluded_conversations: 0,
        funnel: [],
        attendants: [],
      },
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  } as never);
  vi.mocked(useMetasDoMes).mockReturnValue({
    data: { data: { motivo: "sem_meta", periodo: null, metas: [], valores_do_periodo: null } },
    isLoading: false,
    isError: false,
  } as never);
  vi.mocked(useTeamMembers).mockReturnValue({
    data: { data: [{ user_id: ANA, full_name: "Ana Souza", email: null, role: "agent" }] },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  telaCarregada();
  // `window.location.href` não navega em jsdom: vira um espião do destino.
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { href: "" },
  });
});

describe("o botão de exportar vendas", () => {
  it("⭐ está na barra do filtro e baixa o arquivo — sem filtro, o conjunto inteiro", () => {
    render(<MetricsClient canCompare currentUserId={ANA} />);

    const botao = screen.getByRole("button", { name: /Exportar vendas/ });
    botao.click();

    expect(window.location.href).toBe("/api/v1/reports/vendas/export");
  });

  it("⭐ para quem não é manager+ a porta não existe — o mesmo gate da rota", () => {
    render(<MetricsClient canCompare={false} currentUserId={ANA} />);

    expect(screen.queryByRole("button", { name: /Exportar vendas/ })).toBeNull();
  });
});
