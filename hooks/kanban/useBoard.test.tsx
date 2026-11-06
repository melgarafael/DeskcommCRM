/**
 * `?lead=` com o quadro já no cache (#2995).
 *
 * O staleTime global é de 30 s. Quem está no quadro, vai para a ficha do
 * contato e clica em "Abrir negócio" volta com o quadro FRESCO no cache: sem
 * buscar de novo, o `?lead=` nunca chega à rota, o negócio encerrado antigo não
 * vem e o dossiê não abre. A prova de tela por `page.goto` (cache vazio) não
 * alcança esse caminho; este teste alcança.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const get = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/client", () => ({ apiClient: { get } }));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: () => ({ status: "SUBSCRIBED", ultimaEntrega: null }),
}));
vi.mock("@/hooks/realtime/useRefetchDeSeguranca", () => ({
  useRefetchDeSeguranca: () => undefined,
}));

import { chaveDoQuadro, useBoard } from "@/hooks/kanban/useBoard";
import { makeQueryClient } from "@/lib/query/client";

const PIPE = "pipe-1";

function clienteComQuadroFresco(): QueryClient {
  const qc = makeQueryClient();
  qc.setQueryData(chaveDoQuadro(PIPE), { pipeline: { id: PIPE }, stages: [], leads: [] });
  return qc;
}

function envolver(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe("useBoard — `?lead=` com o quadro no cache", () => {
  it("⭐ busca de novo, com o `?lead=`, mesmo com o quadro fresco no cache", async () => {
    get.mockReset().mockResolvedValue({ data: { pipeline: { id: PIPE }, stages: [], leads: [] } });

    renderHook(() => useBoard(PIPE, "perdido-90"), { wrapper: envolver(clienteComQuadroFresco()) });

    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    expect(get).toHaveBeenCalledWith(`/api/v1/pipelines/${PIPE}/board?lead=perdido-90`);
  });

  it("sem `?lead=`, o quadro fresco segue vindo do cache — a leitura de hoje", async () => {
    get.mockReset().mockResolvedValue({ data: { pipeline: { id: PIPE }, stages: [], leads: [] } });

    const { result } = renderHook(() => useBoard(PIPE), {
      wrapper: envolver(clienteComQuadroFresco()),
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(get).not.toHaveBeenCalled();
  });
});
