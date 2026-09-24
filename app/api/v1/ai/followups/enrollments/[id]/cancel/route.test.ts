/**
 * Encerrar pela fila um roteiro de atendimento em andamento ('coletando', 0394).
 * Antes a rota devolvia 409 "já está encerrado" — o roteiro não estava na lista
 * de vivos (revisão do PR 1 do port do #1130).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const deps = vi.hoisted(() => ({ role: vi.fn(), support: vi.fn(), audit: vi.fn(), client: vi.fn() }));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: deps.support }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/supabase/server", () => ({ createClient: deps.client }));

import { POST } from "./route";

const ID = "11111111-1111-4111-8111-111111111111";

function client(status: string) {
  const atualizados: Array<Record<string, unknown>> = [];
  const cadeia = {
    select: () => cadeia,
    eq: () => cadeia,
    maybeSingle: async () => ({ data: { id: ID, status, current_node_id: "t" }, error: null }),
    update: (patch: Record<string, unknown>) => (atualizados.push(patch), cadeia),
    single: async () => ({ data: { id: ID, status: "cancelled" }, error: null }),
    insert: async () => ({ error: null }),
  };
  return { atualizados, c: { from: () => cadeia } };
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.support.mockResolvedValue(null);
  deps.role.mockResolvedValue({ ok: true, user: { id: "eu", idioma: "pt-BR" }, org: { orgId: "org", role: "manager" } });
});

describe("POST /api/v1/ai/followups/enrollments/:id/cancel", () => {
  it("roteiro 'coletando' é encerrado, não recusado com 409", async () => {
    const { atualizados, c } = client("coletando");
    deps.client.mockResolvedValue(c);
    const res = await POST(new NextRequest(`http://localhost/x/${ID}/cancel`, { method: "POST" }), {
      params: Promise.resolve({ id: ID }),
    } as never);
    expect(res.status).toBe(200);
    expect(atualizados[0]).toMatchObject({ status: "cancelled", cancel_reason: "manual" });
  });

  it("o que já acabou continua 409", async () => {
    const { c } = client("completed");
    deps.client.mockResolvedValue(c);
    const res = await POST(new NextRequest(`http://localhost/x/${ID}/cancel`, { method: "POST" }), {
      params: Promise.resolve({ id: ID }),
    } as never);
    expect(res.status).toBe(409);
  });
});
