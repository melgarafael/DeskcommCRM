/**
 * GET /api/v1/contacts/cep — o lookup que preenche o endereço do contato
 * (#3494, fatia 2).
 *
 * Três perguntas, na ordem em que a rota as faz: quem pode consultar, o que
 * acontece com um CEP que não é CEP, e o que a tela recebe quando a BrasilAPI
 * responde — incluindo o caso em que ela não responde.
 *
 * O ponto que mais importa para o produto: CEP malformado fecha em 422 ANTES de
 * qualquer chamada externa, e falha do serviço fecha em 502 — nunca em 500, e
 * nunca impedindo que o contato seja salvo (a gravação não passa por aqui).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { createBrasilApiClient } from "@/lib/brasil-api/client";
import { requireRole } from "@/lib/auth/require-role";
import type { AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/brasil-api/client", () => ({ createBrasilApiClient: vi.fn() }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";

const lookupCep = vi.fn();

function req(cep?: string): NextRequest {
  const url = new URL("http://localhost/api/v1/contacts/cep");
  if (cep !== undefined) url.searchParams.set("cep", cep);
  return new NextRequest(url);
}

function sessaoOk(): void {
  const user: AuthUser = {
    id: USER_ID,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "agent" }],
  };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG_ID, name: "Org", role: "agent" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createBrasilApiClient).mockReturnValue({ lookupCep } as never);
});

describe("autorização", () => {
  it("sem papel suficiente repassa a recusa e não consulta o CEP", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: { code: "forbidden_role" } }), {
        status: 403,
      }) as never,
    });

    const { GET } = await import("./route");
    const res = await GET(req("01310100"));

    expect(res.status).toBe(403);
    expect(lookupCep).not.toHaveBeenCalled();
  });

  it("a rota exige agent — o MESMO piso de criar e editar contato", async () => {
    sessaoOk();
    const { GET } = await import("./route");
    await GET(req("01310100"));

    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("agent");
  });
});

describe("CEP malformado", () => {
  it.each(["0131010", "013101000", "ABCDEFGH", ""])(
    "recusa %s com 422 sem chamar a BrasilAPI",
    async (cep) => {
      sessaoOk();
      const { GET } = await import("./route");
      const res = await GET(req(cep));

      expect(res.status).toBe(422);
      const corpo = await res.json();
      expect(corpo.error.code).toBe("validation_failed");
      expect(lookupCep).not.toHaveBeenCalled();
    },
  );

  it("sem o parâmetro também é 422, não 500", async () => {
    sessaoOk();
    const { GET } = await import("./route");
    const res = await GET(req());

    expect(res.status).toBe(422);
    expect(lookupCep).not.toHaveBeenCalled();
  });
});

describe("resposta da BrasilAPI", () => {
  it("200 com o endereço normalizado, e o bairro vem de `neighborhood`", async () => {
    sessaoOk();
    lookupCep.mockResolvedValue({
      ok: true,
      data: {
        cep: "01310-100",
        state: "SP",
        city: "São Paulo",
        neighborhood: "Bela Vista",
        street: "Avenida Paulista",
      },
      raw: {},
    });

    const { GET } = await import("./route");
    const res = await GET(req("01310-100"));

    expect(res.status).toBe(200);
    const corpo = await res.json();
    expect(corpo.data).toEqual({
      cep: "01310-100",
      street: "Avenida Paulista",
      district: "Bela Vista",
      city: "São Paulo",
      state: "SP",
    });
    // O CEP chega com máscara e sai normalizado para a consulta.
    expect(lookupCep).toHaveBeenCalledWith("01310100");
  });

  it("404 próprio: código `cep_nao_encontrado`, para a tela não confundir com contato", async () => {
    sessaoOk();
    lookupCep.mockResolvedValue({ ok: false, code: "not_found", message: "x", status: 404 });

    const { GET } = await import("./route");
    const res = await GET(req("99999999"));

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("cep_nao_encontrado");
  });

  it("serviço fora do ar vira 502 com o texto que manda preencher à mão", async () => {
    sessaoOk();
    lookupCep.mockResolvedValue({ ok: false, code: "timeout", message: "x" });

    const { GET } = await import("./route");
    const res = await GET(req("01310100"));

    expect(res.status).toBe(502);
    const corpo = await res.json();
    expect(corpo.error.code).toBe("upstream_unavailable");
    expect(corpo.error.message).toContain("Preencha o endereço à mão");
  });
});
