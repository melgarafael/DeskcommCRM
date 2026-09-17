import { afterEach, describe, expect, it, vi } from "vitest";
import { listSessionProxies, chooseSessionProxy } from "./session-proxy";

const proxy = { id: "p1", proxy_address: "203.0.113.8", port: 8080, username: "test", password: "secret", country_code: "US", valid: true };
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("proxy por conexão", () => {
  it("pagina em origem fixa e nunca segue next para outro host", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ results: [proxy], next: "https://outro.test/roubar" })).mockResolvedValueOnce(Response.json({ results: [], next: null }));
    vi.stubGlobal("fetch", fetcher);
    const proxies = await listSessionProxies("key");
    expect(proxies).toHaveLength(1);
    expect(fetcher.mock.calls[1]![0]).toContain("https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=2");
  });
  it("não troca país nem usa proxy inválido para compensar indisponibilidade", () => {
    expect(() => chooseSessionProxy([proxy], { country: "BR" })).toThrow("proxy_unavailable");
    expect(() => chooseSessionProxy([{ ...proxy, valid: false }], { country: "US" })).toThrow("proxy_unavailable");
  });
  it("respeita seleção explícita, pool permitido e vínculo anterior", () => {
    expect(chooseSessionProxy([proxy], { country: "US", proxyId: "p1" })).toEqual(proxy);
    expect(() => chooseSessionProxy([proxy], { country: "US", proxyId: "p2" })).toThrow("proxy_unavailable");
    vi.stubEnv("WEBSHARE_PROXY_IDS", "p2");
    expect(() => chooseSessionProxy([proxy], { country: "US" })).toThrow("proxy_unavailable");
  });
  it("não expõe resposta remota em erros", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("senha-secreta", { status: 401 })));
    await expect(listSessionProxies("key")).rejects.toThrow(/^proxy_provider_unavailable$/);
  });
});
