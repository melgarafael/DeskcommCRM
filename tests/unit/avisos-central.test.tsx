import React from "react";
import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, cleanup, act } from "@testing-library/react";
const m = vi.hoisted(() => ({
  user: "A",
  org: "orgA",
  allowed: true,
  rpc: vi.fn(),
  info: vi.fn(),
  rows: [] as any[],
  error: false,
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useUser: () => ({ id: m.user }),
  useActiveOrg: () => ({ orgId: m.org }),
  usePermission: () => m.allowed,
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: async () => {
      const r = await m.rpc("fn_notice_episode_page", { p_organization_id: m.org });
      if (r.error) throw Error("401");
      return { data: r.data };
    },
    post: async (_url: string, body: any) => {
      const r = await m.rpc("fn_notice_episode_ack", { p_items: body.items });
      if (r.error) throw Error("receipt failed");
      return { data: r.data };
    },
  },
}));
vi.mock("sonner", () => ({ toast: { info: m.info } }));
import { useCentralEpisodeRecovery } from "@/hooks/realtime/useCentralEpisodeRecovery";
const row = (n: number) => ({
  id: "00000000-0000-4000-8000-" + String(n).padStart(12, "0"),
  revision: String(n).padStart(64, "0"),
  title: "Aviso sintético",
  body: "Já resolvido",
  status: "resolved",
});
beforeEach(() => {
  vi.clearAllMocks();
  m.user = "A";
  m.org = "orgA";
  m.allowed = true;
  m.error = false;
  m.rows = [row(1)];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  m.rpc.mockImplementation(async (name: string, args: any) => {
    if (name === "fn_notice_episode_page")
      return {
        data: {
          items: m.rows.slice(0, 20),
          has_more: m.rows.length > 20,
          coverage: "retained_agent_inbox_items",
          history_complete: false,
        },
        error: m.error ? { code: "401" } : null,
      };
    m.rows = m.rows.filter((i) => !args.p_items.some((r: any) => r.id === i.id));
    return { data: { acknowledged: args.p_items.length }, error: null };
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
test("visible bell consumer recovers resolved21 in20+1 under StrictMode and does not replay confirmed", async () => {
  m.rows = Array.from({ length: 21 }, (_, i) => row(i + 1));
  const h = renderHook(({ stamp }) => useCentralEpisodeRecovery(stamp), {
    initialProps: { stamp: 1 },
    wrapper: React.StrictMode,
  });
  await waitFor(() => expect(m.rows).toHaveLength(0));
  expect(m.info).toHaveBeenCalledTimes(21);
  h.rerender({ stamp: 2 });
  await waitFor(() =>
    expect(
      m.rpc.mock.calls.filter((v) => v[0] === "fn_notice_episode_page").length,
    ).toBeGreaterThanOrEqual(3),
  );
  expect(m.info).toHaveBeenCalledTimes(21);
});
test("permission prevents reads and401stale never presents or confirms", async () => {
  m.allowed = false;
  const h = renderHook(() => useCentralEpisodeRecovery(1));
  await act(async () => {});
  expect(m.rpc).not.toHaveBeenCalled();
  m.allowed = true;
  m.error = true;
  h.rerender();
  await waitFor(() => expect(console.warn).toHaveBeenCalled());
  expect(m.info).not.toHaveBeenCalled();
  expect(m.rpc.mock.calls.some((v) => v[0] === "fn_notice_episode_ack")).toBe(false);
});
test("organization switch cancels former response and uses current organization only", async () => {
  let resolve: any;
  m.rpc.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const h = renderHook(() => useCentralEpisodeRecovery(1));
  m.org = "orgB";
  m.rows = [];
  h.rerender();
  await act(async () => {
    resolve({
      data: {
        items: [row(1)],
        has_more: false,
        coverage: "retained_agent_inbox_items",
        history_complete: false,
      },
      error: null,
    });
  });
  expect(m.info).not.toHaveBeenCalled();
  expect(
    m.rpc.mock.calls.filter((v) => v[0] === "fn_notice_episode_page").at(-1)![1].p_organization_id,
  ).toBe("orgB");
  expect(m.rpc.mock.calls.some((v) => v[0] === "fn_notice_episode_ack")).toBe(false);
});
