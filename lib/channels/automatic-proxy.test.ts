import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { prepareManagedSession } from "./managed-session";
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
const pool = ["a", "b", "c", "d"].map((id, i) => ({ id, country_code: i === 3 ? "BR" : "US", valid: true,
  proxy_address: `203.0.113.${i + 1}`, port: 8080, username: "test", password: "test" }));
beforeEach(() => {
  vi.stubEnv("WAHA_EXTERNAL", "false"); vi.stubEnv("WEBSHARE_API_KEY", "test");
  vi.stubEnv("WEBSHARE_PROXY_IDS", ""); vi.stubEnv("WAHA_API_BASE_URL", "https://waha.test");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ results: pool, next: null })));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function setup(binding: { proxy_id: string; country_code: string } | null = null, reserved: string[] = [], race = false) {
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => name === "fn_reserved_channel_proxies"
    ? { data: reserved, error: null } : { data: {}, error: race && args.p_proxy === "b" ? { message: "proxy_in_use" } : null });
  const from = vi.fn((table: string) => {
    const query = { select: () => query, eq: () => query, is: () => query, update: () => query,
      single: async () => ({ data: { id: "channel", waha_session_name: "owned", webhook_path_token: "a".repeat(32) }, error: null }),
      maybeSingle: async () => ({ data: table === "channel_proxy_bindings" && binding ? { ...binding, transport_origin: "https://waha.test" } : null, error: null }) };
    return query;
  });
  const db = { from, rpc } as unknown as SupabaseClient;
  const transport = { getProxyOccupancy: vi.fn(async () => [] as string[]) };
  return { db, rpc, transport };
}
it("ignora reservas e ocupação externa e reserva somente no país escolhido", async () => {
  const s = setup(null, ["a"]); s.transport.getProxyOccupancy.mockResolvedValue(["203.0.113.2:8080"]);
  expect((await prepareManagedSession(s.db, s.transport, "org", "channel", { proxy_country: "US" }))?.proxy?.server).toBe("203.0.113.3:8080");
  expect(s.rpc).toHaveBeenLastCalledWith("fn_bind_channel_proxy", expect.objectContaining({ p_proxy: "c", p_org: "org" }));
});
it("tenta o próximo proxy quando outra conexão ganha a reserva", async () => {
  const s = setup(null, ["a"], true);
  expect((await prepareManagedSession(s.db, s.transport, "org", "channel", { proxy_country: "US" }))?.proxy?.server).toBe("203.0.113.3:8080");
  expect(s.rpc.mock.calls.filter(([name]) => name === "fn_bind_channel_proxy")).toHaveLength(2);
});
it("preserva a reserva nas reconexões mesmo com outros proxies livres", async () => {
  const s = setup({ proxy_id: "c", country_code: "US" }, ["c"]);
  expect((await prepareManagedSession(s.db, s.transport, "org", "channel"))?.proxy?.server).toBe("203.0.113.3:8080");
});
it("troca explícita de país usa nova reserva com comparação do vínculo anterior", async () => {
  const s = setup({ proxy_id: "c", country_code: "US" }, ["c"]);
  await prepareManagedSession(s.db, s.transport, "org", "channel", { proxy_country: "BR" });
  expect(s.rpc).toHaveBeenLastCalledWith("fn_bind_channel_proxy", expect.objectContaining({ p_proxy: "d", p_previous: "c" }));
});
it("não troca o país quando todos os proxies estão reservados", async () => {
  const s = setup(null, ["a", "b", "c"]);
  await expect(prepareManagedSession(s.db, s.transport, "org", "channel", { proxy_country: "US" })).rejects.toThrow("proxy_unavailable");
  expect(s.rpc).toHaveBeenCalledTimes(1);
});
it("não gira o proxy de uma reconexão se o vínculo ficar indisponível", async () => {
  const s = setup({ proxy_id: "c", country_code: "US" }, ["c"]);
  s.transport.getProxyOccupancy.mockResolvedValue(["203.0.113.3:8080"]);
  await expect(prepareManagedSession(s.db, s.transport, "org", "channel")).rejects.toThrow("proxy_unavailable");
});
