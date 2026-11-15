import { beforeEach, describe, expect, it, vi } from "vitest";
const g = vi.hoisted(() => ({
  auth: vi.fn(),
  support: vi.fn(),
  config: vi.fn(),
  save: vi.fn(),
  disconnect: vi.fn(),
  execute: vi.fn(),
  ligado: vi.fn(async () => true),
  visivel: { current: true },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const q = {
      from: () => q,
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: g.visivel.current ? { id: "c" } : null, error: null }),
    };
    return q;
  },
}));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: g.ligado }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
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
  g.ligado.mockResolvedValue(true);
  g.visivel.current = true;
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
describe("módulo desligado na instalação", () => {
  it("as rotas respondem 404 e não leem configuração nem falam com o Amigo", async () => {
    g.ligado.mockResolvedValue(false);
    const lida = await GET();
    expect(lida.status).toBe(404);
    const executada = await POST(req({ operation: "places", input: {} }));
    expect(executada.status).toBe(404);
    expect(g.config).not.toHaveBeenCalled();
    expect(g.execute).not.toHaveBeenCalled();
  });
});
describe("contato fora do alcance da sessão", () => {
  it("o id de contato que a sessão não enxerga é recusado antes do domínio do Amigo", async () => {
    g.visivel.current = false;
    const r = await POST(
      req({ operation: "patient_get", input: { patientId: 9 }, contact_id: "11111111-1111-4111-8111-111111111111" }),
    );
    expect(r.status).toBe(403);
    expect(g.execute).not.toHaveBeenCalled();
  });
});
