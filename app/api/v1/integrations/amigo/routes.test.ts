import { beforeEach, describe, expect, it, vi } from "vitest";
const g = vi.hoisted(() => ({
  auth: vi.fn(),
  support: vi.fn(),
  config: vi.fn(),
  save: vi.fn(),
  disconnect: vi.fn(),
  execute: vi.fn(),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: g.auth }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: g.support }));
vi.mock("@/lib/amigo/store", () => ({
  getAmigoConfig: g.config,
  saveAmigoConfig: g.save,
  disconnectAmigo: g.disconnect,
}));
vi.mock("@/lib/amigo/service", () => ({ executeAmigo: g.execute }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
import { GET, PUT } from "./route";
import { POST } from "./execute/route";
const req = (body: unknown) =>
  new Request("http://localhost/api/v1/integrations/amigo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  g.auth.mockResolvedValue({
    ok: true,
    user: { id: "actor" },
    org: { orgId: "trusted-org", role: "admin" },
  });
  g.support.mockResolvedValue(null);
});
describe("rotas Amigo", () => {
  it("não autenticado não acessa configuração", async () => {
    g.auth.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
    expect((await GET()).status).toBe(401);
    expect(g.config).not.toHaveBeenCalled();
  });
  it("configuração ausente é resposta utilizável sem token", async () => {
    g.config.mockResolvedValue({ configured: false, active: false });
    const r = await GET();
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ data: { configured: false, active: false } });
    expect(g.config).toHaveBeenCalledWith("trusted-org");
  });
  it("suporte somente leitura não salva token", async () => {
    g.support.mockResolvedValue(new Response(null, { status: 403 }));
    expect((await PUT(req({ token: "dummy" }))).status).toBe(403);
    expect(g.save).not.toHaveBeenCalled();
  });
  it("rejeita tentativa de escolher organização pelo corpo", async () => {
    expect((await PUT(req({ organization_id: "other", token: "dummy" }))).status).toBe(422);
    expect(g.save).not.toHaveBeenCalled();
  });
  it("operação não documentada não alcança serviço", async () => {
    expect((await POST(req({ operation: "arbitrary_url", input: {} }))).status).toBe(422);
    expect(g.execute).not.toHaveBeenCalled();
  });
  it("não reflete erro cru com segredo no corpo de resposta", async () => {
    g.execute.mockRejectedValue(new Error("Bearer secret-token"));
    const r = await POST(req({ operation: "places", input: {} }));
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain("secret-token");
  });
  it("organização e papel são da sessão e recibo incerto permanece incerto", async () => {
    g.execute.mockResolvedValue({ state: "uncertain", uncertain: true, operation_id: "op" });
    const r = await POST(req({ operation: "places", input: {} }));
    expect(await r.json()).toMatchObject({ data: { state: "uncertain", uncertain: true } });
    expect(g.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "trusted-org",
        role: "admin",
        actor: { type: "user", id: "actor", role: "admin" },
      }),
      "places",
      {},
      undefined,
    );
  });
});
