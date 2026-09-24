/**
 * PATCH de gatilho num roteiro de atendimento: o banco recusa (0394,
 * `followup_flow_pointers_roteiro_so_manual`, 23514) e a rota devolve 422 com a
 * razão legível — não um 500 com a mensagem crua do Postgres.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const deps = vi.hoisted(() => ({ role: vi.fn(), support: vi.fn(), audit: vi.fn(), client: vi.fn() }));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: deps.support }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/supabase/server", () => ({ createClient: deps.client }));

import { PATCH } from "./route";

const ID = "11111111-1111-4111-8111-111111111111";

function clientQueRecusa(code: string) {
  const busca = {
    select: () => busca,
    eq: () => busca,
    maybeSingle: async () => ({ data: { id: ID }, error: null }),
  };
  const atualiza = {
    eq: () => atualiza,
    select: () => atualiza,
    single: async () => ({ data: null, error: { code, message: "violates check constraint" } }),
  };
  return { from: () => ({ ...busca, update: () => atualiza }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.support.mockResolvedValue(null);
  deps.role.mockResolvedValue({ ok: true, user: { id: "eu", idioma: "pt-BR" }, org: { orgId: "org", role: "manager" } });
});

describe("PATCH /api/v1/ai/followup-flows/[id]", () => {
  it("gatilho de relógio num roteiro: o 23514 do banco vira 422 legível", async () => {
    deps.client.mockResolvedValue(clientQueRecusa("23514"));
    const res = await PATCH(
      new NextRequest(`http://localhost/api/v1/ai/followup-flows/${ID}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trigger_config: { kind: "silence", params: { threshold_minutes: 60 } } }),
      }),
      { params: Promise.resolve({ id: ID }) } as never,
    );
    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error: { message: string } };
    expect(corpo.error.message).toContain("palavra-gatilho");
    expect(deps.audit).not.toHaveBeenCalled();
  });
});
