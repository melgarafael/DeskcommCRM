import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  bindings: [] as Array<{ config: Record<string, string>; handler: (p: unknown) => void }>,
  prepare: vi.fn(), remove: vi.fn(),
}));
vi.mock("@/lib/supabase/browser", () => ({
  prepareRealtimeAuthentication: mock.prepare,
  createClient: () => ({
    channel: () => {
      const channel = {
        on: (_type: string, config: Record<string, string>, handler: (p: unknown) => void) => {
          mock.bindings.push({ config, handler });
          return channel;
        },
        subscribe: (cb: (s: string) => void) => { cb("SUBSCRIBED"); return channel; },
      };
      return channel;
    },
    removeChannel: mock.remove,
  }),
}));
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";

beforeEach(() => {
  mock.bindings = [];
  vi.clearAllMocks();
  mock.prepare.mockResolvedValue(undefined);
});

it("exclusão invalida o consumidor sem entregar ID, conteúdo ou falso evento DELETE", async () => {
  const onChange = vi.fn();
  const { result, unmount } = renderHook(() => useRealtimeChannel({
    name: "kanban-local", postgresChanges: { table: "crm_leads", event: "*", filter: "pipeline_id=eq.synthetic" }, onChange,
  }));
  await act(async () => {});
  const signal = mock.bindings.find(b => b.config.table === "realtime_invalidations");
  expect(signal).toBeDefined();
  await act(async () => signal!.handler({ new: { table_name: "crm_leads", change_token: "unrelated-signal" } }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ tipo: "invalidado", tabela: "crm_leads" });
  expect(result.current.ultimaEntrega.current).not.toBeNull();
  expect(result.current.status).toBe("subscribed");
  unmount();
  expect(mock.remove).toHaveBeenCalledOnce();
});

it("ignora sinal de outra tabela e mantém INSERT/UPDATE originais", async () => {
  const onChange = vi.fn();
  const { unmount } = renderHook(() => useRealtimeChannel({ name: "notes-local", postgresChanges: { table: "conversation_notes", event: "*" }, onChange }));
  await act(async () => {});
  const signal = mock.bindings.find(b => b.config.table === "realtime_invalidations")!;
  await act(async () => signal.handler({ new: { table_name: "messages" } }));
  expect(onChange).not.toHaveBeenCalled();
  const own = { eventType: "INSERT", new: { id: "authorized-note" } };
  await act(async () => mock.bindings.find(b => b.config.table === "conversation_notes")!.handler(own));
  expect(onChange).toHaveBeenCalledExactlyOnceWith(own);
  unmount();
});

it("assinatura somente INSERT não recebe invalidações de exclusão", async () => {
  const { unmount } = renderHook(() => useRealtimeChannel({ name: "alerts-local", postgresChanges: { table: "messages", event: "INSERT" }, onChange: vi.fn() }));
  await act(async () => {});
  expect(mock.bindings.filter(b => b.config.table).map(b => b.config.table)).toEqual(["messages"]);
  unmount();
});

it("assinatura DELETE também recebe invalidação sem depender de polling", async () => {
  const onChange = vi.fn();
  const { unmount } = renderHook(() => useRealtimeChannel({ name: "delete-local", postgresChanges: { table: "crm_leads", event: "DELETE" }, onChange }));
  await act(async () => {});
  await act(async () => mock.bindings.find(b => b.config.table === "realtime_invalidations")!.handler({ new: { table_name: "crm_leads" } }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ tipo: "invalidado", tabela: "crm_leads" });
  unmount();
});
