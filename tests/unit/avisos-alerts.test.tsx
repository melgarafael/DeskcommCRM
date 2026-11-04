import React from "react";
import { beforeEach, afterEach, test, expect, vi } from "vitest";
import { renderHook, waitFor, act, cleanup } from "@testing-library/react";
const m = vi.hoisted(() => ({
  uid: "A",
  rpc: vi.fn(),
  signal: vi.fn(),
  warning: vi.fn(),
  invalidate: vi.fn(),
  rows: [] as any[],
  readError: false,
  ackError: false,
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useUser: () => ({ id: m.uid }) }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: m.invalidate }),
}));
vi.mock("sonner", () => ({ toast: { warning: m.warning } }));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: async () => {
      const r = await m.rpc("fn_derived_notice_page", {});
      if (r.error) throw Error("401");
      return { data: r.data };
    },
    post: async (_url: string, body: any) => {
      const r = await m.rpc("fn_derived_notice_ack", { p_items: body.items });
      if (r.error) throw Error("receipt failed");
      return { data: r.data };
    },
  },
}));
vi.mock("@/hooks/realtime/useNoticeSignal", () => ({ useNoticeSignal: m.signal }));
import { useAlertsRealtime } from "@/hooks/useAlertsRealtime";
const row = (n = 1) => ({
  id: "00000000-0000-4000-8000-" + String(n).padStart(12, "0"),
  revision: String(n).padStart(64, "0"),
  organization_id: "00000000-0000-4000-8000-000000000001",
  kind: "ai_budget",
  snapshot: { mode: "avisar", percent: 80 + n },
  created_at: "2026-11-01T00:00:00Z",
});
const page = (rows: any[]) => ({
  items: rows.slice(0, 20),
  has_more: rows.length > 20,
  coverage: "persisted_derived_episodes",
  history_complete: false,
});
beforeEach(() => {
  vi.clearAllMocks();
  m.uid = "A";
  m.rows = [row()];
  m.readError = false;
  m.ackError = false;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  m.rpc.mockImplementation(async (name: string, args: any) => {
    if (name === "fn_derived_notice_page")
      return { data: page(m.rows), error: m.readError ? { code: "401" } : null };
    if (m.ackError) return { data: null, error: { code: "500" } };
    m.rows = m.rows.filter((r) => !args.p_items.some((i: any) => i.id === r.id));
    return { data: { acknowledged: args.p_items.length }, error: null };
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
test("StrictMode presents only fresh setup result and confirms once", async () => {
  renderHook(() => useAlertsRealtime(m.uid), { wrapper: React.StrictMode });
  await waitFor(() => expect(m.rows).toHaveLength(0));
  expect(m.warning).toHaveBeenCalledOnce();
  expect(m.warning.mock.calls[0][1].description).toContain("gasto acumulado");
});
test("21 persisted episodes drain without snapshot top20 loss", async () => {
  m.rows = Array.from({ length: 21 }, (_, i) => row(i + 1));
  renderHook(() => useAlertsRealtime(m.uid));
  await waitFor(() => expect(m.warning).toHaveBeenCalledTimes(21));
  expect(m.rows).toHaveLength(0);
  expect(m.rpc.mock.calls.filter((v) => v[0] === "fn_derived_notice_ack")).toHaveLength(2);
});
test("401 with stale data never shows or confirms it", async () => {
  m.readError = true;
  renderHook(() => useAlertsRealtime(m.uid));
  await waitFor(() => expect(console.warn).toHaveBeenCalled());
  expect(m.warning).not.toHaveBeenCalled();
  expect(m.rpc.mock.calls.some((v) => v[0] === "fn_derived_notice_ack")).toBe(false);
});
test("actor change invalidates pending former account result", async () => {
  let resolve: any;
  m.rpc.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const { rerender } = renderHook(() => useAlertsRealtime(m.uid));
  m.rows = [];
  m.uid = "B";
  rerender();
  await act(async () => {
    resolve({ data: page([row()]), error: null });
  });
  expect(m.warning).not.toHaveBeenCalled();
  expect(m.rpc.mock.calls.some((v) => v[0] === "fn_derived_notice_ack")).toBe(false);
});
test("receipt error retries without duplicate toast while component lives", async () => {
  m.ackError = true;
  renderHook(() => useAlertsRealtime(m.uid));
  await waitFor(() => expect(console.warn).toHaveBeenCalled());
  expect(m.warning).toHaveBeenCalledOnce();
  m.ackError = false;
  act(() => m.signal.mock.calls.at(-1)![1]());
  await waitFor(() => expect(m.rows).toHaveLength(0));
  expect(m.warning).toHaveBeenCalledOnce();
});
