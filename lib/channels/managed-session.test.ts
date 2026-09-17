import { afterEach, describe, expect, it, vi } from "vitest";
import { WahaClient } from "@/lib/waha/client";
import type { ManagedSessionConfig } from "./managed-session";

const managed: ManagedSessionConfig = { metadata: { crm_channel_id: "channel", crm_organization_id: "org" },
  proxy: { server: "203.0.113.8:8080", username: "test", password: "secret" },
  webhooks: [{ url: "https://crm.test/api/v1/webhooks/waha/token", events: ["session.status"], hmac: { key: "test-secret" }, retries: { attempts: 3, delaySeconds: 2 } }] };
afterEach(() => vi.unstubAllGlobals());
describe("sessão gerenciada em servidor externo", () => {
  it("cria parada com proxy e webhook e aceita GOWS quando selecionado", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({})).mockResolvedValueOnce(Response.json({ name: "owned", status: "STOPPED", engine: "GOWS", config: managed }));
    vi.stubGlobal("fetch", fetcher);
    const client = new WahaClient("https://waha.test", "key", { engine: "GOWS", managed: true, proxyRequired: true });
    await expect(client.createSession("owned", managed)).resolves.toMatchObject({ created: true });
    const sent = JSON.parse(fetcher.mock.calls[0]![1].body);
    expect(sent).toMatchObject({ start: false, config: managed });
  });
  it("não adota nem altera sessão sem o marcador de propriedade", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ statusCode: 422, error: "Unprocessable Entity", message: "Session 'owned' already exists. Use PUT to update it." }, { status: 422 }))
      .mockResolvedValueOnce(Response.json({ name: "owned", status: "STOPPED", engine: "GOWS", config: { ...managed, metadata: { crm_channel_id: "other" } } }));
    vi.stubGlobal("fetch", fetcher);
    const client = new WahaClient("https://waha.test", "key", { engine: "GOWS", managed: true });
    await expect(client.createSession("owned", managed)).rejects.toThrow("waha_create_409");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("rotina automática nunca recria sessão perdida sem proxy", async () => {
    const fetcher = vi.fn(async () => Response.json({ statusCode: 404, error: "Not Found", message: "Session not found" }, { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    const client = new WahaClient("https://waha.test", "key", { managed: true, proxyRequired: true });
    await expect(client.startSession("owned")).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("recusa rotina automática se uma sessão perdeu o proxy", async () => {
    const fetcher = vi.fn(async () => Response.json({ name: "owned", status: "STOPPED", engine: "GOWS", config: { metadata: managed.metadata } }));
    vi.stubGlobal("fetch", fetcher);
    await expect(new WahaClient("https://waha.test", "key", { engine: "GOWS", managed: true, proxyRequired: true }).startSession("owned")).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("não troca a configuração de uma sessão ativa", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ statusCode: 422, error: "Unprocessable Entity", message: "Session 'owned' already exists. Use PUT to update it." }, { status: 422 }))
      .mockResolvedValueOnce(Response.json({ name: "owned", status: "WORKING", engine: "GOWS", config: { ...managed, proxy: { ...managed.proxy, server: "203.0.113.9:8080" } } }));
    vi.stubGlobal("fetch", fetcher);
    await expect(new WahaClient("https://waha.test", "key", { engine: "GOWS", managed: true }).createSession("owned", managed)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("GOWS confirma logout parado quando o snapshot omite me", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({}, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ name: "owned", status: "STOPPED", config: managed })));
    await expect(new WahaClient("https://waha.test", "key", { engine: "GOWS" }).logoutSession("owned")).resolves.toBeUndefined();
  });
  it("ocupação não devolve usuário/senha de outras sessões", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([{ name: "other", status: "WORKING", config: { proxy: { server: "user:secret@203.0.113.8:8080" } } }])));
    expect(await new WahaClient("https://waha.test", "key").getProxyOccupancy()).toEqual(["203.0.113.8:8080"]);
  });
});
