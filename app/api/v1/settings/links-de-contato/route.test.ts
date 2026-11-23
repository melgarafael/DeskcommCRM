import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { TODOS_OS_TIPOS_DE_LINK } from "@/lib/leads/tipos-por-organizacao";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";

let gravado: Record<string, unknown> | null = null;
let filtroDoCas: string | null = null;

function banco({
  settings,
  erroNaLeitura = false,
  outroGravou = false,
}: {
  settings: Record<string, unknown> | null;
  erroNaLeitura?: boolean;
  outroGravou?: boolean;
}) {
  const escrita = {
    eq: () => escrita,
    is: () => escrita,
    filter: (_coluna: string, _operador: string, valor: string) => {
      filtroDoCas = valor;
      return escrita;
    },
    select: () => escrita,
    maybeSingle: async () => ({ data: outroGravou ? null : { id: ORG_ID }, error: null }),
  };
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            erroNaLeitura
              ? { data: null, error: { message: "fora do ar" } }
              : { data: { settings }, error: null },
        }),
      }),
      update: (linha: { settings: Record<string, unknown> }) => {
        gravado = linha.settings;
        return escrita;
      },
    }),
  };
}

function sessao(role: "admin" | "viewer" | "negado") {
  if (role === "negado") {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    return;
  }
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID, idioma: "pt-BR" },
    org: { orgId: ORG_ID },
  } as never);
}

function montar({
  settings,
  erroNaLeitura = false,
  outroGravou = false,
}: {
  settings: Record<string, unknown> | null;
  erroNaLeitura?: boolean;
  outroGravou?: boolean;
}) {
  const db = banco({ settings, erroNaLeitura, outroGravou });
  vi.mocked(createAdminClient).mockReturnValue(db as never);
  vi.mocked(createClient).mockResolvedValue(db as never);
}

async function get(): Promise<{ status: number; body: { data?: { tipos?: string[] } } }> {
  const { GET } = await import("./route");
  const res = await GET(new NextRequest("http://localhost/api/v1/settings/links-de-contato"));
  return { status: res.status, body: await res.clone().json() };
}

async function patch(corpo: unknown): Promise<{ status: number }> {
  const { PATCH } = await import("./route");
  const res = await PATCH(
    new NextRequest("http://localhost/api/v1/settings/links-de-contato", {
      method: "PATCH",
      body: JSON.stringify(corpo),
      headers: { "content-type": "application/json" },
    }),
  );
  return { status: res.status };
}

beforeEach(() => {
  vi.clearAllMocks();
  gravado = null;
  filtroDoCas = null;
});

describe("GET /api/v1/settings/links-de-contato", () => {
  it("⭐ organização sem o ajuste → catálogo inteiro (nada muda para quem já instalou)", async () => {
    sessao("viewer");
    montar({ settings: { routing: { mode: "manual" } } });

    const r = await get();

    expect(r.status).toBe(200);
    expect(r.body.data?.tipos).toEqual([...TODOS_OS_TIPOS_DE_LINK]);
    expect(requireRole).toHaveBeenCalledWith("viewer", expect.anything());
  });

  it("com o ajuste gravado → só os tipos marcados, na ordem do catálogo", async () => {
    sessao("viewer");
    montar({ settings: { links_de_contato: { tipos: ["linkedin", "instagram"] } } });

    const r = await get();

    expect(r.status).toBe(200);
    expect(r.body.data?.tipos).toEqual(["instagram", "linkedin"]);
  });

  it("jsonb com lixo → catálogo inteiro, sem 500", async () => {
    sessao("viewer");
    montar({ settings: { links_de_contato: { tipos: ["nao_existe"] } } });

    const r = await get();

    expect(r.status).toBe(200);
    expect(r.body.data?.tipos).toEqual([...TODOS_OS_TIPOS_DE_LINK]);
  });
});

describe("PATCH /api/v1/settings/links-de-contato", () => {
  it("⭐ grava só a chave nova, preservando o resto de settings, e audita", async () => {
    sessao("admin");
    const settings = { routing: { mode: "round_robin" }, crm: { x: 1 } };
    montar({ settings });

    const r = await patch({ tipos: ["linkedin", "instagram"] });

    expect(r.status).toBe(200);
    expect(gravado).toEqual({
      routing: { mode: "round_robin" },
      crm: { x: 1 },
      links_de_contato: { tipos: ["instagram", "linkedin"] },
    });
    expect(filtroDoCas).toBe(JSON.stringify(settings));
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "settings.links_de_contato_updated",
        organizationId: ORG_ID,
        metadata: { tipos: ["linkedin", "instagram"] },
      }),
    );
    expect(requireRole).toHaveBeenCalledWith("admin", expect.anything());
  });

  it("⭐ id fora do catálogo → 422, e settings intacto", async () => {
    sessao("admin");
    montar({ settings: { routing: { mode: "manual" } } });

    expect((await patch({ tipos: ["instagram", "orkut"] })).status).toBe(422);

    expect(gravado).toBeNull();
    expect(audit).not.toHaveBeenCalled();
  });

  it("⭐ corpo grande (lista acima do catálogo) → 422, e settings intacto", async () => {
    sessao("admin");
    montar({ settings: { routing: { mode: "manual" } } });
    const enorme = Array.from({ length: 300 }, (_, i) => `tipo_${i}`);

    expect((await patch({ tipos: enorme })).status).toBe(422);
    expect(gravado).toBeNull();
  });

  it("lista vazia (o default da leitura é o catálogo inteiro) → 422, não salva vazio", async () => {
    sessao("admin");
    montar({ settings: {} });

    expect((await patch({ tipos: [] })).status).toBe(422);
    expect(gravado).toBeNull();
  });

  it("chave desconhecida no corpo → 422 (schema estrito)", async () => {
    sessao("admin");
    montar({ settings: {} });

    expect((await patch({ tipos: ["site"], outra_coisa: true })).status).toBe(422);
    expect(gravado).toBeNull();
  });

  it("⭐ papel não-admin → 403, e settings intacto", async () => {
    sessao("negado");
    montar({ settings: { routing: { mode: "manual" } } });

    expect((await patch({ tipos: ["instagram"] })).status).toBe(403);
    expect(gravado).toBeNull();
    expect(requireRole).toHaveBeenCalledWith("admin", expect.anything());
  });

  it("leitura que falhou → 500 e NADA é gravado (não apaga o resto da configuração)", async () => {
    sessao("admin");
    montar({ settings: null, erroNaLeitura: true });

    expect((await patch({ tipos: ["instagram"] })).status).toBe(500);
    expect(gravado).toBeNull();
  });

  it("escrita concorrente → 409, sem auditar", async () => {
    sessao("admin");
    montar({ settings: { routing: { mode: "manual" } }, outroGravou: true });

    expect((await patch({ tipos: ["instagram"] })).status).toBe(409);
    expect(audit).not.toHaveBeenCalled();
  });
});
