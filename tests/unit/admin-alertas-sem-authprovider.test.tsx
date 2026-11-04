import React from "react";
import { test, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
const probes = vi.hoisted(() => ({ items: [] as any[] }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useUser: () => {
    throw new Error("useAuth must be used inside <AuthProvider>");
  },
}));
vi.mock("@/hooks/realtime/useNoticeSignal", () => ({ useNoticeSignal: () => {} }));
vi.mock("@/lib/realtime/drain-retained-episodes", () => ({
  EpisodeDrainCancelled: class extends Error {},
  RetainedEpisodeDrain: class {
    p: any;
    constructor(p: any) {
      this.p = p;
      probes.items.push(this);
    }
    drain() {
      return Promise.resolve();
    }
    cancel = vi.fn();
  },
}));
import { useAlertsRealtime } from "@/hooks/useAlertsRealtime.ts";
test("admin hook mounts without tenant AuthProvider and cancels stale identity", () => {
  const qc = new QueryClient();
  const wrapper = ({ children }: any) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const h = renderHook(({ id }) => useAlertsRealtime(id), {
    initialProps: { id: "synthetic-admin-a" },
    wrapper,
  });
  const a = probes.items[0];
  expect(a.p.isCurrent()).toBe(true);
  h.rerender({ id: "synthetic-admin-b" });
  expect(a.cancel).toHaveBeenCalledOnce();
  expect(a.p.isCurrent()).toBe(false);
  expect(probes.items[1].p.isCurrent()).toBe(true);
  h.unmount();
  expect(probes.items[1].cancel).toHaveBeenCalledOnce();
  expect(probes.items[1].p.isCurrent()).toBe(false);
});

const authGuard = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/requirePlatformAdmin", () => ({ requirePlatformAdmin: authGuard }));
vi.mock("@/app/admin/(protected)/dashboard/_client.tsx", () => ({ DashboardClient: () => null }));
import AdminPage from "@/app/admin/(protected)/dashboard/page.tsx";
test("page passes only server-authorized actor", async () => {
  authGuard.mockResolvedValueOnce({ user: { id: "synthetic-verified-admin" } });
  const view = await AdminPage();
  expect(view.props.actorId).toBe("synthetic-verified-admin");
  expect(authGuard).toHaveBeenCalled();
});
test("page preserves auth/MFA rejection", async () => {
  authGuard.mockRejectedValueOnce(new Error("mfa_required"));
  await expect(AdminPage()).rejects.toThrow("mfa_required");
});
