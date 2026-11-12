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
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: vi.fn(async () => false) }));
vi.mock("@/lib/catalogo/servicos-supabase", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  sinaisFixosQueTravamPreco: vi.fn(async () => new Map()),
}));

import { PATCH } from "./route";

/**
 * A PORTA DO NÚCLEO NO PATCH DE PRODUTO (doc 212, #3480).
 *
 * O preço de um item de serviço também muda por esta rota, que não conhece
 * serviço. Com o módulo ligado, ela não baixa o preço para menos que o sinal
 * fixo da família; desligado, ela é a de sempre e não consulta nada do módulo.
 */
const ID = "33333333-3333-4333-8333-333333333333";
let gravou = false;

beforeEach(() => {
  vi.clearAllMocks();
  gravou = false;
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: "u", idioma: "pt-BR" }, org: { orgId: "org" } } as never);
  const q = {
    update: () => {
      gravou = true;
      return q;
    },
    eq: () => q,
    select: () => q,
    maybeSingle: async () => ({ data: { id: ID }, error: null }),
  };
  vi.mocked(createClient).mockResolvedValue({ from: () => q } as never);
});

const patch = (corpo: unknown) =>
  PATCH(new NextRequest(`http://localhost/api/v1/products/${ID}`, { method: "PATCH", body: JSON.stringify(corpo) }), {
    params: Promise.resolve({ id: ID }),
  });

describe("PATCH /api/v1/products/[id] — o preço contra o sinal fixo do serviço", () => {
  it("módulo desligado: grava como sempre e não pergunta nada ao módulo", async () => {
    expect((await patch({ preco_cents: 100 })).status).toBe(200);
    expect(gravou).toBe(true);
    expect(sinaisFixosQueTravamPreco).not.toHaveBeenCalled();
  });

  it("módulo ligado: preço abaixo do sinal fixo da família = 422, e nada é gravado", async () => {
    vi.mocked(moduloLigado).mockResolvedValue(true);
    vi.mocked(sinaisFixosQueTravamPreco).mockResolvedValue(new Map([[ID, 30_000]]));
    const r = await patch({ preco_cents: 29_999 });
    expect(r.status).toBe(422);
    expect(gravou).toBe(false);
  });

  it("módulo ligado: preço igual ou acima do sinal passa", async () => {
    vi.mocked(moduloLigado).mockResolvedValue(true);
    vi.mocked(sinaisFixosQueTravamPreco).mockResolvedValue(new Map([[ID, 30_000]]));
    expect((await patch({ preco_cents: 30_000 })).status).toBe(200);
    expect(gravou).toBe(true);
  });

  it("módulo ligado e conferência falhou: nada é gravado", async () => {
    vi.mocked(moduloLigado).mockResolvedValue(true);
    vi.mocked(sinaisFixosQueTravamPreco).mockRejectedValue(new Error("boom"));
    expect((await patch({ preco_cents: 30_000 })).status).toBe(500);
    expect(gravou).toBe(false);
  });

  it("PATCH sem preço não consulta o módulo", async () => {
    vi.mocked(moduloLigado).mockResolvedValue(true);
    expect((await patch({ nome: "Outro" })).status).toBe(200);
    expect(sinaisFixosQueTravamPreco).not.toHaveBeenCalled();
  });
});
