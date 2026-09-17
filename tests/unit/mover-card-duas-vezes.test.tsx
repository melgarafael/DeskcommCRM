import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useMoveCard } from "@/hooks/kanban/useMoveCard";
import type { BoardData } from "@/lib/kanban/types";

/**
 * Arrastar o mesmo card duas vezes seguidas dava 409 "modificado por outro
 * usuário" (issue #916): o cache do quadro guardava o `updated_at` de antes do
 * primeiro movimento até o refetch chegar, e o segundo arrastar mandava esse
 * valor velho como `expected_updated_at`.
 */

const post = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/client", () => ({ apiClient: { post } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

const PIPELINE = "p-1";
const LEAD = "l-1";

function quadro(): BoardData {
  return {
    pipeline: { id: PIPELINE } as BoardData["pipeline"],
    stages: [],
    leads: [
      {
        id: LEAD,
        stage_id: "s-1",
        position_in_stage: 1000,
        updated_at: "2026-09-15T12:00:00.000Z",
      } as BoardData["leads"][number],
    ],
  };
}

let qc: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);

beforeEach(() => {
  post.mockReset();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData(["board", PIPELINE], quadro());
});

describe("mover o mesmo card duas vezes seguidas", () => {
  it("o segundo movimento manda o updated_at que o servidor devolveu no primeiro", async () => {
    post.mockResolvedValueOnce({
      data: { id: LEAD, stage_id: "s-2", position_in_stage: 1500, updated_at: "2026-09-15T12:00:01.500Z" },
    });

    const { result } = renderHook(() => useMoveCard(PIPELINE), { wrapper });

    await act(() =>
      result.current.mutateAsync({
        leadId: LEAD,
        stageId: "s-2",
        positionInStage: 1500,
        expectedUpdatedAt: "2026-09-15T12:00:00.000Z",
      }),
    );

    // O que o quadro passa no segundo arrastar é o `updated_at` do card no cache.
    const card = qc.getQueryData<BoardData>(["board", PIPELINE])!.leads.find((l) => l.id === LEAD)!;
    expect(card.updated_at).toBe("2026-09-15T12:00:01.500Z");
    expect(card.stage_id).toBe("s-2");
  });
});
