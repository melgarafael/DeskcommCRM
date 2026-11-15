import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const ID = "33333333-3333-4333-8333-333333333333";

let gravado: Record<string, unknown> | null = null;

function supabaseCom(capacidadeLigada: boolean) {
  const consulta = {
    select: () => consulta,
    eq: () => consulta,
    in: async () => ({ data: [], error: null }),
    limit: async () => ({ data: [], error: null }),
    update: (linha: Record<string, unknown>) => {
      gravado = linha;
      return consulta;
    },
    maybeSingle: async () =>
      gravado
        ? { data: { id: ID, ...gravado }, error: null }
        : { data: { settings: { catalogo: { capacidade: capacidadeLigada } } }, error: null },
  };
  return { from: () => consulta };
}

async function patch(corpo: unknown): Promise<Response> {
  const { PATCH } = await import("./route");
  return PATCH(
    new NextRequest(`http://localhost/api/v1/products/${ID}`, {
      method: "PATCH",
      body: JSON.stringify(corpo),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id: ID }) },
  );
}

beforeEach(() => {
  gravado = null;
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u1" },
    org: { orgId: ORG_ID },
  } as never);
});

describe("PATCH /api/v1/products/:id — muda o que veio e não encosta no resto", () => {
  it("mudar só o preço não zera o estoque nem reativa o produto", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseCom(false) as never);
    expect((await patch({ preco_cents: 100 })).status).toBe(200);
    expect(gravado).toEqual({ preco_cents: 100 });
  });
});

describe("PATCH /api/v1/products/:id — a capacidade obedece à chave da empresa", () => {
  it("desligada, recusa com 422 e não grava", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseCom(false) as never);
    expect((await patch({ capacidade: "256GB" })).status).toBe(422);
    expect(gravado).toBeNull();
  });

  it("desligada, o resto do produto continua editável", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseCom(false) as never);
    expect((await patch({ preco_cents: 100 })).status).toBe(200);
  });

  it("ligada, grava", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseCom(true) as never);
    expect((await patch({ capacidade: "256GB" })).status).toBe(200);
    expect(gravado).toEqual({ capacidade: "256GB" });
  });
});
