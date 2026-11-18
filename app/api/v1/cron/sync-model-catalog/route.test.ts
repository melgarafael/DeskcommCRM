import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  autorizado: true,
  nativos: vi.fn(),
  audit: vi.fn(),
  upsert: vi.fn(),
}));
vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => mocks.autorizado }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/ai/catalogo/models-dev", () => ({
  FONTE_MODELS_DEV: "models.dev",
  sincronizarModelosNativos: mocks.nativos,
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({ eq: async () => ({ data: [], error: null }) }),
      upsert: mocks.upsert,
    }),
  }),
}));

import { GET } from "./route";

describe("cron de descoberta de modelos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.autorizado = true;
    mocks.nativos.mockResolvedValue({ fonte: "models.dev", recebidos: 2, gravados: 2 });
    mocks.upsert.mockResolvedValue({ error: null });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ data: [{ id: "meta/modelo" }] })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("exige autenticação antes de consultar fontes ou escrever", async () => {
    mocks.autorizado = false;
    expect((await GET(new NextRequest("http://localhost/cron"))).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.nativos).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("sincroniza ambas as fontes e audita novos modelos para o painel de plataforma", async () => {
    const r = await GET(new NextRequest("http://localhost/cron"));
    expect(r.status).toBe(200);
    expect((await r.json()).data).toMatchObject({
      fonte: "openrouter",
      gravados: 1,
      nativos: { recebidos: 2, gravados: 2 },
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai_models.synced", bypassedRls: true }),
    );
  });

  it("não audita rodada nativa sem novidades", async () => {
    mocks.nativos.mockResolvedValue({ fonte: "models.dev", recebidos: 2, gravados: 0 });
    expect((await GET(new NextRequest("http://localhost/cron"))).status).toBe(200);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("falha nativa não impede OpenRouter e não é escondida pelo sucesso dela", async () => {
    mocks.nativos.mockRejectedValue(new Error("origem indisponível"));
    expect((await GET(new NextRequest("http://localhost/cron"))).status).toBe(500);
    expect(mocks.upsert).toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai_models.sync_failed" }),
    );
  });

  it("falha OpenRouter não impede descobrir e auditar modelos nativos", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 503 }));
    expect((await GET(new NextRequest("http://localhost/cron"))).status).toBe(500);
    expect(mocks.nativos).toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai_models.synced" }),
    );
  });
});
