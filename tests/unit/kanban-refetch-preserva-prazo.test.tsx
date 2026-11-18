import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useBoard } from "@/hooks/kanban/useBoard";

vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: () => ({ status: "subscribed", ultimaEntrega: ultima }),
}));
const { ultima } = vi.hoisted(() => ({ ultima: { current: null } }));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: async () => ({ data: { leads: [] } }) } }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("quadro mantém o prazo da releitura de segurança", () => {
  it("redesenhos não adiam indefinidamente os 45 segundos de revogação", async () => {
    vi.useFakeTimers();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const reler = vi.spyOn(qc, "refetchQueries").mockResolvedValue(undefined);
    function wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    }
    const hook = renderHook(() => useBoard("pipeline-a"), { wrapper });
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      hook.rerender();
    }
    expect(reler).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(reler).toHaveBeenCalledExactlyOnceWith({
      queryKey: ["board", "pipeline-a"],
      exact: true,
    });
    hook.unmount();
    qc.clear();
  });
});

it("trocar o funil reinicia o prazo e não consulta o funil anterior", async () => {
  vi.useFakeTimers();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const refetch = vi.spyOn(qc, "refetchQueries").mockResolvedValue(undefined);
  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  const hook = renderHook(({ id }) => useBoard(id), {
    wrapper,
    initialProps: { id: "pipeline-a" },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  hook.rerender({ id: "pipeline-b" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(refetch).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(refetch).toHaveBeenCalledExactlyOnceWith({
    queryKey: ["board", "pipeline-b"],
    exact: true,
  });
  hook.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(90_000);
  });
  expect(refetch).toHaveBeenCalledTimes(1);
  qc.clear();
});
