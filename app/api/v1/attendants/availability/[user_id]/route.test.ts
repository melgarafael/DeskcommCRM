import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  audit: vi.fn(async () => undefined),
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const ATENDENTE = "22222222-2222-4222-8222-222222222222";
const GERENTE = "33333333-3333-4333-8333-333333333333";

const JORNADA_24H = {
  timezone: "America/Sao_Paulo",
  windows: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, start: "00:00", end: "23:59" })),
};

let gravado: Record<string, unknown> | null = null;

function mockBanco() {
  gravado = null;
  vi.mocked(createClient).mockResolvedValue({
    from: () => {
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        is: () => q,
        maybeSingle: async () => ({ data: { user_id: ATENDENTE }, error: null }),
        upsert: (v: Record<string, unknown>) => ((gravado = v), q),
        single: async () => ({ data: { user_id: ATENDENTE, ...gravado }, error: null }),
      };
      return q;
    },
  } as never);
}

function como(userId: string, role: "agent" | "manager") {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: userId, idioma: "pt-BR" },
    org: { orgId: ORG, role },
  } as never);
}

function patch(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/attendants/availability/${ATENDENTE}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}
const ctx = { params: Promise.resolve({ user_id: ATENDENTE }) };

beforeEach(() => mockBanco());

// A regra da jornada é a de antes dos setores: a própria pessoa OU o gerente
// (decisão do dono em 27/10/2026, no #3485). Este arquivo guarda as três
// pontas para que uma restrição "só o gerente" não volte calada.
const OUTRO = "44444444-4444-4444-8444-444444444444";
const ctxOutro = { params: Promise.resolve({ user_id: OUTRO }) };

describe("PATCH /api/v1/attendants/availability/[user_id] — quem grava a jornada", () => {
  it("o próprio atendente publica a própria jornada", async () => {
    como(ATENDENTE, "agent");
    const { PATCH } = await import("./route");
    const res = await PATCH(patch({ schedule: JORNADA_24H }), ctx);
    expect(res.status).toBe(200);
    expect(gravado).toMatchObject({ organization_id: ORG, user_id: ATENDENTE });
    expect((gravado?.schedule as { windows: unknown[] }).windows).toHaveLength(7);
  });

  it("o gerente publica a jornada do atendente", async () => {
    como(GERENTE, "manager");
    const { PATCH } = await import("./route");
    const res = await PATCH(patch({ schedule: JORNADA_24H }), ctx);
    expect(res.status).toBe(200);
    expect(gravado).toMatchObject({ organization_id: ORG, user_id: ATENDENTE });
  });

  it("um atendente não publica a jornada de OUTRO atendente", async () => {
    como(ATENDENTE, "agent");
    const { PATCH } = await import("./route");
    const res = await PATCH(patch({ schedule: JORNADA_24H }), ctxOutro);
    expect(res.status).toBe(403);
    expect(gravado).toBeNull();
  });
});
