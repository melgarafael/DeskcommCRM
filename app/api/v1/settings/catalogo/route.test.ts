import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";

let gravado: Record<string, unknown> | null = null;
let filtroDoCas: string | null = null;

function banco({ settings, erroNaLeitura = false, outroGravou = false }: {
  settings: Record<string, unknown> | null;
  erroNaLeitura?: boolean;
  outroGravou?: boolean;
}) {
  const escrita = {
    eq: () => escrita,
    is: () => escrita,
    filter: (_c: string, _o: string, valor: string) => {
      filtroDoCas = valor;
      return escrita;
    },
    select: () => escrita,
    maybeSingle: async () => {
      if (outroGravou) gravado = null;
      return { data: outroGravou ? null : { id: ORG_ID }, error: null };
    },
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

async function patch(corpo: unknown): Promise<Response> {
  const { PATCH } = await import("./route");
  return PATCH(
    new NextRequest("http://localhost/api/v1/settings/catalogo", {
      method: "PATCH",
      body: JSON.stringify(corpo),
      headers: { "content-type": "application/json" },
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  gravado = null;
  filtroDoCas = null;
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u1", idioma: "pt-BR" },
    org: { orgId: ORG_ID },
  } as never);
});

describe("PATCH /api/v1/settings/catalogo", () => {
  it("liga a chave sem encostar no resto da configuração, e audita", async () => {
    const settings = { proposals: { enabled: true }, catalogo: { outra: 1 } };
    vi.mocked(createAdminClient).mockReturnValue(banco({ settings }) as never);

    const r = await patch({ apresentacao: true });

    expect(r.status).toBe(200);
    expect(gravado).toEqual({ proposals: { enabled: true }, catalogo: { outra: 1, apresentacao: true } });
    expect(filtroDoCas).toBe(JSON.stringify(settings));
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "catalogo.apresentacao_changed", organizationId: ORG_ID }),
    );
  });

  it("desliga sem apagar o resto do bloco", async () => {
    const settings = { catalogo: { outra: 1, apresentacao: true } };
    vi.mocked(createAdminClient).mockReturnValue(banco({ settings }) as never);

    expect((await patch({ apresentacao: false })).status).toBe(200);
    expect(gravado).toEqual({ catalogo: { outra: 1, apresentacao: false } });
  });

  it("escrita concorrente vira 409, sem auditar", async () => {
    vi.mocked(createAdminClient).mockReturnValue(banco({ settings: {}, outroGravou: true }) as never);
    expect((await patch({ apresentacao: true })).status).toBe(409);
    expect(audit).not.toHaveBeenCalled();
  });

  it("leitura que falhou não grava: settings vazio apagaria a configuração", async () => {
    vi.mocked(createAdminClient).mockReturnValue(banco({ settings: null, erroNaLeitura: true }) as never);
    expect((await patch({ apresentacao: true })).status).toBe(500);
    expect(gravado).toBeNull();
  });

  it("recusa o que não é booleano", async () => {
    vi.mocked(createAdminClient).mockReturnValue(banco({ settings: {} }) as never);
    expect((await patch({ apresentacao: "true" })).status).toBe(422);
    expect(gravado).toBeNull();
  });

  it("a chave é do admin, o mesmo papel da tela que a hospeda", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    expect((await patch({ apresentacao: true })).status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("admin", expect.anything());
  });
});
