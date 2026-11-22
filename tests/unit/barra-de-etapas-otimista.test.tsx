import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useMoveCard } from "@/hooks/kanban/useMoveCard";
import { diasNaEtapa } from "@/lib/kanban/barra-de-etapas";
import type { BoardData } from "@/lib/kanban/types";

/**
 * A BARRA DE ETAPAS NO MOVIMENTO OTIMISTA.
 *
 * Ao mover, o quadro troca a etapa do card no cache antes de o servidor
 * responder. Se só o `stage_id` mudasse, a barra mostraria por um instante
 * "Etapa nova (4 dias)" — os dias da etapa antiga — até a resposta chegar com o
 * `stage_changed_at` novo. O otimista carimba a entrada junto; reordenar na
 * MESMA etapa não mexe nela (o gatilho da 0071 também não).
 */

const post = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/client", () => ({ apiClient: { post } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

const PIPELINE = "p-1";
const LEAD = "l-1";
const QUATRO_DIAS_ATRAS = new Date(Date.now() - 4 * 86_400_000 - 3_600_000).toISOString();

let qc: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);

function card() {
  return qc.getQueryData<BoardData>(["board", PIPELINE])!.leads.find((l) => l.id === LEAD)!;
}

beforeEach(() => {
  post.mockReset();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData<BoardData>(["board", PIPELINE], {
    pipeline: { id: PIPELINE } as BoardData["pipeline"],
    stages: [],
    leads: [
      {
        id: LEAD,
        stage_id: "s-1",
        position_in_stage: 1000,
        updated_at: "2026-09-15T12:00:00.000Z",
        stage_changed_at: QUATRO_DIAS_ATRAS,
        created_at: "2026-09-01T12:00:00.000Z",
      } as BoardData["leads"][number],
    ],
  });
});

describe("barra de etapas — o otimista do mover", () => {
  it("trocar de etapa zera os dias já no otimista, antes da resposta", async () => {
    let responder: (v: unknown) => void = () => {};
    post.mockImplementationOnce(() => new Promise((r) => (responder = r)));
    const { result } = renderHook(() => useMoveCard(PIPELINE), { wrapper });

    expect(diasNaEtapa(card())).toBe(4);
    let movendo: Promise<unknown> = Promise.resolve();
    act(() => {
      movendo = result.current.mutateAsync({ leadId: LEAD, stageId: "s-2", expectedUpdatedAt: "2026-09-15T12:00:00.000Z" });
    });
    await vi.waitFor(() => expect(card().stage_id).toBe("s-2"));
    expect(diasNaEtapa(card())).toBe(0);

    await act(async () => {
      responder({ data: { id: LEAD, stage_id: "s-2", updated_at: "2026-09-15T12:00:01.000Z" } });
      await movendo;
    });
  });

  it("reordenar na mesma etapa não mexe na entrada", async () => {
    let responder: (v: unknown) => void = () => {};
    post.mockImplementationOnce(() => new Promise((r) => (responder = r)));
    const { result } = renderHook(() => useMoveCard(PIPELINE), { wrapper });

    let movendo: Promise<unknown> = Promise.resolve();
    act(() => {
      movendo = result.current.mutateAsync({
        leadId: LEAD, stageId: "s-1", positionInStage: 500, expectedUpdatedAt: "2026-09-15T12:00:00.000Z",
      });
    });
    await vi.waitFor(() => expect(card().position_in_stage).toBe(500));
    expect(card().stage_changed_at).toBe(QUATRO_DIAS_ATRAS);

    await act(async () => {
      responder({ data: { id: LEAD, stage_id: "s-1", updated_at: "2026-09-15T12:00:01.000Z" } });
      await movendo;
    });
  });
});
