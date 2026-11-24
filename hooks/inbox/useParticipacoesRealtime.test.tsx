import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const canal = vi.hoisted(() => ({ onChange: (_payload: unknown) => {} }));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: (opts: { onChange: (payload: unknown) => void }) => {
    canal.onChange = opts.onChange;
    return { status: "subscribed", ultimaEntrega: { current: null } };
  },
}));
import { useParticipacoesRealtime } from "./useParticipacoesRealtime";

afterEach(() => cleanup());

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["conversation", "c1"], { id: "c1", body: "snapshot antigo" });
  qc.setQueryData(["messages", "c1"], { pages: [{ data: [{ id: "m1" }] }] });
  qc.setQueryData(["conversation-counts", "org"], { mine: 1 });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  renderHook(() => useParticipacoesRealtime("pessoa", "org"), { wrapper });
  return qc;
}

describe("o snapshot não sobrevive à revogação do convite", () => {
  it("left_at limpa conversa e histórico antes de reler a nova autorização", async () => {
    const qc = montar();
    await act(async () => canal.onChange({ new: { conversation_id: "c1", left_at: "2026-10-26T19:00:00Z" } }));
    expect(qc.getQueryData(["conversation", "c1"])).toBeUndefined();
    expect(qc.getQueryData(["messages", "c1"])).toBeUndefined();
    expect(qc.getQueryState(["conversation-counts", "org"])?.isInvalidated).toBe(true);
  });

  it("reconexão limpa o snapshot mesmo sem receber o evento perdido da remoção", async () => {
    const qc = montar();
    await act(async () => canal.onChange({ tipo: "reassinado" }));
    expect(qc.getQueryData(["conversation", "c1"])).toBeUndefined();
    expect(qc.getQueryData(["messages", "c1"])).toBeUndefined();
  });
});

it("reconexao mantem o snapshot da conversa ativa disponivel para recuperar a leitura", async () => {
  const qc = montar();
  const chave = ["conversation", "c1"];
  const observer = new QueryObserver(qc, {
    queryKey: chave,
    queryFn: async () => { throw Object.assign(new Error("REST temporariamente fora"), { status: 503 }); },
    staleTime: Infinity,
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    await act(async () => canal.onChange({ tipo: "reassinado" }));
    expect(qc.getQueryData(chave), "o reset descartou o snapshot durante a indisponibilidade").toMatchObject({ id: "c1" });
  } finally {
    unsubscribe();
    qc.clear();
  }
});
