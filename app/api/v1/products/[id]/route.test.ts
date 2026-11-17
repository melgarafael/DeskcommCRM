import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { sinaisFixosQueTravamPreco } from "@/lib/catalogo/servicos-supabase";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/instalacao/modulos", () => ({
  moduloLigado: vi.fn(async () => false),
  modulosLigados: vi.fn(async () => []),
}));
vi.mock("@/lib/catalogo/servicos-supabase", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  sinaisFixosQueTravamPreco: vi.fn(async () => new Map()),
}));

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
  vi.clearAllMocks();
  gravado = null;
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u1", idioma: "pt-BR" },
    org: { orgId: ORG_ID },
  } as never);
  vi.mocked(moduloLigado).mockResolvedValue(false);
  vi.mocked(sinaisFixosQueTravamPreco).mockResolvedValue(new Map());
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

/**
 * A PORTA DO NÚCLEO NO PATCH DE PRODUTO (doc 212, #3480).
 *
 * O preço de um item de serviço também muda por esta rota, que não conhece
 * serviço. Com o módulo ligado, ela não baixa o preço para menos que o sinal
 * fixo da família; desligado, ela é a de sempre e não consulta nada do módulo.
 */
describe("PATCH /api/v1/products/[id] — o preço contra o sinal fixo do serviço", () => {
  it("módulo desligado: grava como sempre e não pergunta nada ao módulo", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseCom(false) as never);
    expect((await patch({ preco_cents: 100 })).status).toBe(200);
    expect(gravado).toEqual({ preco_cents: 100 });
    expect(sinaisFixosQueTravamPreco).not.toHaveBeenCalled();
  });

  it("módulo ligado: preço abaixo do sinal fixo da família = 422, e nada é gravado", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseCom(false) as never);
    vi.mocked(moduloLigado).mockResolvedValue(true);
    vi.mocked(sinaisFixosQueTravamPreco).mockResolvedValue(new Map([[ID, 30_000]]));
    const r = await patch({ preco_cents: 29_999 });
    expect(r.status).toBe(422);
    expect(gravado).toBeNull();
  });

  it("módulo ligado: preço igual ou acima do sinal passa", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseCom(false) as never);
    vi.mocked(moduloLigado).mockResolvedValue(true);
    vi.mocked(sinaisFixosQueTravamPreco).mockResolvedValue(new Map([[ID, 30_000]]));
    expect((await patch({ preco_cents: 30_000 })).status).toBe(200);
    expect(gravado).toEqual({ preco_cents: 30_000 });
  });

  it("módulo ligado e conferência falhou: nada é gravado", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseCom(false) as never);
    vi.mocked(moduloLigado).mockResolvedValue(true);
    vi.mocked(sinaisFixosQueTravamPreco).mockRejectedValue(new Error("boom"));
    expect((await patch({ preco_cents: 30_000 })).status).toBe(500);
    expect(gravado).toBeNull();
  });

  it("PATCH sem preço não consulta o módulo", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseCom(false) as never);
    vi.mocked(moduloLigado).mockResolvedValue(true);
    expect((await patch({ nome: "Outro" })).status).toBe(200);
    expect(sinaisFixosQueTravamPreco).not.toHaveBeenCalled();
  });
});
