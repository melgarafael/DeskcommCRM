import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { moduloLigado } from "@/lib/instalacao/modulos";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: vi.fn(async () => true) }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/mcp/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp/auth")>()),
  validateBearerToken: vi.fn(),
}));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";

function montarMundo(storedProposals: Record<string, unknown> = {}) {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID, idioma: "pt-BR" },
    org: { orgId: ORG_ID },
  } as never);

  let gravado: Record<string, unknown> | null = null;
  const settings = { proposals: storedProposals };
  const client = {
    from: (tabela: string) => {
      if (tabela !== "organizations") throw new Error(`tabela não mockada: ${tabela}`);
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { settings }, error: null }),
          }),
        }),
        update: (patch: Record<string, unknown>) => ({
          eq: async () => {
            gravado = (patch.settings as { proposals: Record<string, unknown> }).proposals;
            return { error: null };
          },
        }),
      };
    },
  };
  vi.mocked(createClient).mockResolvedValue(client as never);
  vi.mocked(createAdminClient).mockReturnValue(client as never);

  return {
    get gravado() {
      return gravado;
    },
    async GET() {
      const { GET } = await import("./route");
      const res = await GET(new Request("http://x") as never);
      return { status: res.status, body: await res.clone().json() };
    },
    async PATCH(corpo: unknown) {
      const { PATCH } = await import("./route");
      const res = await PATCH(
        new NextRequest("http://localhost/api/v1/settings/proposals", {
          method: "PATCH",
          body: JSON.stringify(corpo),
          headers: { "content-type": "application/json" },
        }),
      );
      return { status: res.status, body: await res.clone().json() };
    },
  };
}

describe("GET /api/v1/settings/proposals", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("sem followup_dias gravado: devolve o default 3 (N2)", async () => {
    const mundo = montarMundo({ enabled: true, default_valid_days: 15, default_conditions: null });
    const res = await mundo.GET();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ followup_dias: 3 });
  });

  it("com followup_dias gravado: devolve o valor", async () => {
    const mundo = montarMundo({ enabled: true, default_valid_days: 15, default_conditions: null, followup_dias: 7 });
    const res = await mundo.GET();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ followup_dias: 7 });
  });
});

describe("PATCH /api/v1/settings/proposals", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("grava followup_dias (N2)", async () => {
    const mundo = montarMundo({ enabled: true, default_valid_days: 15, default_conditions: null });
    const res = await mundo.PATCH({ enabled: true, default_valid_days: 15, default_conditions: null, followup_dias: 7 });
    expect(res.status).toBe(200);
    expect(mundo.gravado).toMatchObject({ followup_dias: 7 });
  });

  it("tela antiga sem followup_dias no body: 200, não 422 — e preserva o valor já gravado", async () => {
    const mundo = montarMundo({ enabled: true, default_valid_days: 15, default_conditions: null, followup_dias: 7 });
    const res = await mundo.PATCH({ enabled: true, default_valid_days: 20, default_conditions: null });
    expect(res.status).toBe(200);
    expect(mundo.gravado).toMatchObject({ default_valid_days: 20, followup_dias: 7 });
  });

  it("followup_dias inválido (negativo): 422, nada gravado", async () => {
    const mundo = montarMundo({});
    const res = await mundo.PATCH({ enabled: true, default_valid_days: 15, default_conditions: null, followup_dias: -1 });
    expect(res.status).toBe(422);
    expect(mundo.gravado).toBeNull();
  });
});

describe("módulo Propostas desligado na INSTALAÇÃO (doc 79)", () => {
  it("⭐ GET e PATCH: 404 — nenhuma empresa vê nem liga, e nada é gravado", async () => {
    vi.mocked(moduloLigado).mockResolvedValue(false);
    const mundo = montarMundo({ enabled: false, default_valid_days: 15, default_conditions: null });
    expect((await mundo.GET()).status).toBe(404);
    const res = await mundo.PATCH({ enabled: true, default_valid_days: 15, default_conditions: null });
    expect(res.status).toBe(404);
    expect(mundo.gravado).toBeNull();
    expect(moduloLigado).toHaveBeenCalledWith(expect.anything(), "propostas");
    vi.mocked(moduloLigado).mockResolvedValue(true);
  });
});
