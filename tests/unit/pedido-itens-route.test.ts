/**
 * PATCH /api/v1/commercial-orders/[id]/itens — só rascunho/em_analise.
 *
 * Pedido comprometido não se reescreve (cancela e refaz); PATCH vazio é 422.
 * Auth e banco dublados — o que se mede é a DECISÃO da rota.
 */
import { NextRequest } from "next/server";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const ANA = "11111111-1111-4111-8111-111111111111";

function sessao(papel: Role) {
  const user: AuthUser = {
    id: ANA,
    email: "ana@example.com",
    full_name: "Ana",
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG, organization_name: "Org", role: papel }],
  };
  vi.mocked(requireRole).mockImplementation(async (min: Role) =>
    ROLE_RANK[papel] >= ROLE_RANK[min]
      ? { ok: true, user, org: { orgId: ORG, name: "Org", role: papel } }
      : { ok: false, response: fail("forbidden_role", `Requer role >= ${min}.`, 403, {}) },
  );
}

function req(corpo: unknown) {
  return new NextRequest("http://x/api/v1/commercial-orders/1/itens", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sessao("agent");
});

describe("PATCH /api/v1/commercial-orders/[id]/itens", () => {
  it("recusa corpo vazio com 422 antes de tocar no banco", async () => {
    const chamadas: { tabela: string; op: string }[] = [];
    vi.mocked(createClient).mockResolvedValue({
      from: () => {
        throw new Error("banco não deveria ser chamado");
      },
    } as never);
    const { PATCH } = await import("@/app/api/v1/commercial-orders/[id]/itens/route");
    const res = await PATCH(req({ adicionar: [], remover: [], ajustar: [] }), {
      params: Promise.resolve({ id: "ped-1" }),
    });
    expect(res.status).toBe(422);
    expect(chamadas).toEqual([]);
  });

  it("recusa pedido faturado (só rascunho/em_analise)", async () => {
    const { PATCH } = await import("@/app/api/v1/commercial-orders/[id]/itens/route");
    // Mock mínimo: pedido faturado; itens irrelevantes (a rota barra antes).
    vi.mocked(createClient).mockResolvedValue({
      from: (tabela: string) => {
        const e: Record<string, unknown> = {};
        for (const m of ["select", "eq", "order", "limit"]) e[m] = () => e;
        e.maybeSingle = () =>
          Promise.resolve({
            data:
              tabela === "commercial_orders"
                ? { id: "ped-1", status: "faturado", desconto_cents: 0, frete_cents: 0, condicao_pagamento: null }
                : null,
            error: null,
          });
        return e;
      },
    } as never);
    const res = await PATCH(
      req({ remover: ["11111111-1111-4111-8111-111111111111"] }),
      { params: Promise.resolve({ id: "ped-1" }) },
    );
    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error?: { message?: string } };
    expect(corpo.error?.message ?? "").toMatch(/não aceita edição/i);
  });
});
