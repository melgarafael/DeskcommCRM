/**
 * DELETE /api/v1/vendas/[id] — quem apaga uma venda registrada.
 *
 *  - quem registrou: apaga; outro atendente: 403; gestor: apaga;
 *  - venda de OUTRA organização: 404 (como se não existisse), nada apagado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

import { DELETE } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const VENDA = "77777777-7777-4777-8777-777777777777";
const QUEM_REGISTROU = "55555555-5555-4555-8555-555555555555";
const OUTRO_ATENDENTE = "88888888-8888-4888-8888-888888888888";

function montar(orgDaVenda = ORG) {
  const apagadas: Array<Array<[string, unknown]>> = [];
  const linhas = [{ id: VENDA, organization_id: orgDaVenda, created_by: QUEM_REGISTROU, valor_cents: 100 }];
  function from() {
    const filtros: Array<[string, unknown]> = [];
    let apagando = false;
    const q: Record<string, unknown> = {
      select: () => q,
      delete() {
        apagando = true;
        return q;
      },
      eq(c: string, v: unknown) {
        filtros.push([c, v]);
        return q;
      },
      maybeSingle: async () => ({ data: linhas.find((l) => filtros.every(([c, v]) => (l as Record<string, unknown>)[c] === v)) ?? null, error: null }),
      then(ok: (v: unknown) => unknown) {
        if (apagando) apagadas.push(filtros);
        return Promise.resolve({ data: null, error: null }).then(ok);
      },
    };
    return q;
  }
  vi.mocked(createAdminClient).mockReturnValue({ from: vi.fn(from) } as never);
  return { apagadas };
}

function auth(userId: string, role: string) {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: userId, idioma: "pt-BR" },
    org: { orgId: ORG, role },
  } as never);
}

const apagar = () =>
  DELETE(new NextRequest(`http://localhost/api/v1/vendas/${VENDA}`, { method: "DELETE" }), {
    params: Promise.resolve({ id: VENDA }),
  });

beforeEach(() => vi.clearAllMocks());

describe("DELETE /api/v1/vendas/[id]", () => {
  it("quem registrou apaga, com a organização no filtro, e audita", async () => {
    auth(QUEM_REGISTROU, "agent");
    const { apagadas } = montar();

    const res = await apagar();

    expect(res.status).toBe(200);
    expect(apagadas[0]).toContainEqual(["organization_id", ORG]);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(expect.objectContaining({ action: "venda.apagada" }));
  });

  it("outro atendente não apaga: 403", async () => {
    auth(OUTRO_ATENDENTE, "agent");
    const { apagadas } = montar();

    const res = await apagar();

    expect(res.status).toBe(403);
    expect(apagadas).toHaveLength(0);
  });

  it("gestor apaga a venda de outra pessoa", async () => {
    auth(OUTRO_ATENDENTE, "manager");
    const { apagadas } = montar();

    const res = await apagar();

    expect(res.status).toBe(200);
    expect(apagadas).toHaveLength(1);
  });

  it("venda de outra organização: 404, nada apagado", async () => {
    auth(QUEM_REGISTROU, "admin");
    const { apagadas } = montar(OUTRA_ORG);

    const res = await apagar();

    expect(res.status).toBe(404);
    expect(apagadas).toHaveLength(0);
  });
});
