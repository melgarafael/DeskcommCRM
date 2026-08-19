import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { apiClient } from "@/lib/api/client";
import { chaveDoFunil } from "@/hooks/pipelines/useAgentMapping";

import { useEtapasDeGatilho } from "./useEtapasDeGatilho";

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn() },
}));

function wrapperFor(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe("useEtapasDeGatilho", () => {
  it("não quebra quando a resposta de um funil vem sem o envelope esperado", async () => {
    vi.mocked(apiClient.get).mockImplementation(async (path: string) => {
      if (path === "/api/v1/pipelines") {
        return { data: [{ id: "p1", name: "Funil 1" }] } as never;
      }
      // Simula sessão expirada / proxy devolvendo algo fora do contrato.
      return {} as never;
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useEtapasDeGatilho(), { wrapper: wrapperFor(qc) });

    await waitFor(() => expect(result.current.carregando).toBe(false));
    expect(result.current.etapas).toEqual([]);
  });

  it("lê do MESMO slot de cache que useAgentMapping — sem isso, uma tela contamina a outra", async () => {
    const pipelineId = "p1";
    vi.mocked(apiClient.get).mockImplementation(async (path: string) => {
      if (path === "/api/v1/pipelines") {
        return { data: [{ id: pipelineId, name: "Funil 1" }] } as never;
      }
      throw new Error("não deveria refazer o fetch — o cache já tem o dado desta chave");
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Pré-popula o cache exatamente como `useAgentMapping` deixaria após uma
    // visita à tela de Etapas (formato já desembrulhado, SEM o envelope `data`).
    qc.setQueryData(chaveDoFunil(pipelineId), {
      etapas: [{ id: "e1", name: "Novo contato", is_won: false, is_lost: false }],
      mapeamento: { new: "e1", contacted: null, qualifying: null, qualified: null, negotiating: null, won: null, lost: null },
    });

    const { result } = renderHook(() => useEtapasDeGatilho(), { wrapper: wrapperFor(qc) });

    await waitFor(() => expect(result.current.carregando).toBe(false));
    expect(result.current.etapas).toEqual([
      { stageId: "e1", stageName: "Novo contato", pipelineId, pipelineName: "Funil 1" },
    ]);
  });
});
