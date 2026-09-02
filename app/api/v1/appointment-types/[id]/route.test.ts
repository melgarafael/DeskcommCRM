import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { PATCH, DELETE } from "./route";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const TYPE_ID = "33333333-3333-4333-8333-333333333333";

function reqOk() {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u1" } as never,
    org: { orgId: ORG_ID, name: "Org", role: "manager" },
  });
}

beforeEach(() => vi.clearAllMocks());

describe("DELETE /api/v1/appointment-types/[id]", () => {
  it("recusa (409) se houver agendamento futuro para este tipo", async () => {
    reqOk();
    const chain = {
      select: () => chain,
      eq: () => chain,
      gte: () => Promise.resolve({ count: 1, error: null }),
    };
    vi.mocked(createAdminClient).mockReturnValue({ from: () => chain } as never);

    const res = await DELETE(new Request("http://x") as never, {
      params: Promise.resolve({ id: TYPE_ID }),
    } as never);
    expect(res.status).toBe(409);
  });

  it("apaga quando não há agendamento futuro", async () => {
    reqOk();
    let deletado = false;
    const chain = {
      select: () => chain,
      eq: () => chain,
      gte: () => Promise.resolve({ count: 0, error: null }),
      delete: () => ({
        eq: () => ({
          eq: () => {
            deletado = true;
            return Promise.resolve({ error: null });
          },
        }),
      }),
    };
    vi.mocked(createAdminClient).mockReturnValue({ from: () => chain } as never);

    const res = await DELETE(new Request("http://x") as never, {
      params: Promise.resolve({ id: TYPE_ID }),
    } as never);
    expect(res.status).toBe(200);
    expect(deletado).toBe(true);
  });
});

describe("PATCH /api/v1/appointment-types/[id]", () => {
  it("exige manager+ (role insuficiente devolve a resposta do requireRole)", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: { code: "forbidden_role" } }), { status: 403 }) as never,
    });
    const res = await PATCH(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ name: "Novo nome" }) }) as never,
      { params: Promise.resolve({ id: TYPE_ID }) } as never,
    );
    expect(res.status).toBe(403);
  });

  it("atualiza com payload parcial válido, escopado por id e organization_id", async () => {
    reqOk();
    const eqCalls: unknown[][] = [];
    const chain = {
      update: () => chain,
      eq: (...args: unknown[]) => {
        eqCalls.push(args);
        return eqCalls.length >= 2 ? Promise.resolve({ error: null }) : chain;
      },
    };
    vi.mocked(createAdminClient).mockReturnValue({ from: () => chain } as never);

    const res = await PATCH(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ name: "Novo nome" }) }) as never,
      { params: Promise.resolve({ id: TYPE_ID }) } as never,
    );
    expect(res.status).toBe(200);
    expect(eqCalls).toContainEqual(["id", TYPE_ID]);
    expect(eqCalls).toContainEqual(["organization_id", ORG_ID]);
  });

  it("rejeita (422) payload parcial inválido (color fora do formato hex)", async () => {
    reqOk();
    const res = await PATCH(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ color: "not-a-color" }) }) as never,
      { params: Promise.resolve({ id: TYPE_ID }) } as never,
    );
    expect(res.status).toBe(422);
  });

  it("422 quando responsible_user_id não é membro ativo desta organização (cross-tenant)", async () => {
    reqOk();
    const chain = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
    };
    vi.mocked(createAdminClient).mockReturnValue({ from: () => chain } as never);

    const res = await PATCH(
      new Request("http://x", {
        method: "PATCH",
        body: JSON.stringify({ responsible_user_id: "99999999-9999-4999-8999-999999999999" }),
      }) as never,
      { params: Promise.resolve({ id: TYPE_ID }) } as never,
    );
    expect(res.status).toBe(422);
  });
});
