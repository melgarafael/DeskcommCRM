import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const deps = vi.hoisted(() => ({
  role: vi.fn(),
  support: vi.fn(),
  audit: vi.fn(),
  criarClientDeSessao: vi.fn(),
  criarClientAdmin: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: deps.support }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/supabase/server", () => ({ createClient: deps.criarClientDeSessao }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: deps.criarClientAdmin }));

import { GET, POST } from "@/app/api/v1/agenda/enderecos/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const EU = "22222222-2222-4222-8222-222222222222";

function clientQueInsere(resultado: {
  data?: { address: string } | null;
  error?: { code: string; message: string } | null;
}) {
  const capturado: { payload?: Record<string, unknown> } = {};
  return {
    capturado,
    client: {
      from: () => ({
        insert: (payload: Record<string, unknown>) => {
          capturado.payload = payload;
          return {
            select: () => ({
              single: async () => ({
                data: resultado.data ?? null,
                error: resultado.error ?? null,
              }),
            }),
          };
        },
      }),
    },
  };
}

function req(body: unknown) {
  return new NextRequest("http://localhost/api/v1/agenda/enderecos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.support.mockResolvedValue(null);
  deps.role.mockResolvedValue({
    ok: true,
    user: { id: EU },
    org: { orgId: ORG },
  });
});

describe("POST /api/v1/agenda/enderecos", () => {
  it("usa o client de SESSÃO — a RLS é quem autoriza, e o admin bypassaria", async () => {
    const { client, capturado } = clientQueInsere({ data: { address: "Sala 2" } });
    deps.criarClientDeSessao.mockResolvedValue(client);

    const res = await POST(req({ address: "Sala 2" }));
    expect(res.status).toBe(201);
    expect(deps.criarClientAdmin).not.toHaveBeenCalled();
    expect(capturado.payload?.organization_id).toBe(ORG);
    expect(capturado.payload?.address).toBe("Sala 2");
    expect(capturado.payload?.created_by).toBe(EU);
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "agenda.endereco_salvo", organizationId: ORG }),
    );
  });

  it("ignora organization_id do body — a org é da sessão", async () => {
    const { client, capturado } = clientQueInsere({ data: { address: "Sala 2" } });
    deps.criarClientDeSessao.mockResolvedValue(client);

    await POST(req({ address: "Sala 2", organization_id: "33333333-3333-4333-8333-333333333333" }));
    expect(capturado.payload?.organization_id).toBe(ORG);
  });

  it("endereço já salvo (23505) devolve 200 e não audita de novo", async () => {
    const { client } = clientQueInsere({
      error: { code: "23505", message: "duplicate key" },
    });
    deps.criarClientDeSessao.mockResolvedValue(client);

    const res = await POST(req({ address: "Sala 2" }));
    expect(res.status).toBe(200);
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("vazio não chega à escrita", async () => {
    const res = await POST(req({ address: "   " }));
    expect(res.status).toBe(422);
    expect(deps.criarClientDeSessao).not.toHaveBeenCalled();
  });

  it("suporte somente leitura é barrado antes do efeito", async () => {
    deps.support.mockResolvedValue(new Response("readonly", { status: 403 }));
    expect((await POST(req({ address: "Sala 2" }))).status).toBe(403);
    expect(deps.role).not.toHaveBeenCalled();
    expect(deps.criarClientDeSessao).not.toHaveBeenCalled();
  });
});

function clientQueLista() {
  const orgs: string[] = [];
  const thenable = () => {
    const q = {
      select: () => q,
      eq: (col: string, val: string) => {
        if (col === "organization_id") orgs.push(val);
        return q;
      },
      not: () => q,
      ilike: () => q,
      order: () => q,
      limit: () => q,
      then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve(resolve({ data: [], error: null })),
    };
    return q;
  };
  return { orgs, client: { from: () => thenable() } };
}

describe("GET /api/v1/agenda/enderecos", () => {
  it("recusa busca grande demais antes de consultar", async () => {
    const res = await GET(
      new NextRequest(`http://localhost/api/v1/agenda/enderecos?q=${"x".repeat(101)}`),
    );
    expect(res.status).toBe(422);
    expect(deps.criarClientDeSessao).not.toHaveBeenCalled();
  });

  it("filtra organization_id da sessão em cada fonte — nunca do query string", async () => {
    const { client, orgs } = clientQueLista();
    deps.criarClientDeSessao.mockResolvedValue(client);

    const res = await GET(
      new NextRequest(`http://localhost/api/v1/agenda/enderecos?organization_id=${"3".repeat(36)}`),
    );
    expect(res.status).toBe(200);
    expect(orgs).toEqual([ORG, ORG, ORG]);
  });
});
