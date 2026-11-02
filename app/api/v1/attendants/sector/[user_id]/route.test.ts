import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
// Módulo `setores` ligado (doc 213): o desligado tem arquivo próprio,
// tests/unit/setores-modulo-desligado.test.ts.
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: vi.fn(async () => true) }));
vi.mock("@/lib/audit", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  audit: vi.fn(async () => undefined),
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const GERENTE = "22222222-2222-4222-8222-222222222222";
const ALVO = "33333333-3333-4333-8333-333333333333";
const SETOR = "44444444-4444-4444-8444-444444444444";
const OUTRO_SETOR = "55555555-5555-4555-8555-555555555555";

type Chamada = { tabela: string; op: string; filtros: Array<[string, unknown]>; valores?: unknown };

/**
 * Admin client de mentira: cada `from(tabela)` devolve um encadeável que
 * registra a operação e os filtros, e resolve com o que `respostas` disser
 * para `tabela:op`. Registrar os FILTROS é o ponto: a rota usa service role,
 * e o que separa uma org da outra é o `.eq("organization_id", …)` à mão.
 */
function mockAdmin(respostas: Record<string, { data: unknown; error: unknown }>) {
  const chamadas: Chamada[] = [];
  vi.mocked(createAdminClient).mockReturnValue({
    from: (tabela: string) => {
      const chamada: Chamada = { tabela, op: "select", filtros: [] };
      chamadas.push(chamada);
      const resposta = () => respostas[`${tabela}:${chamada.op}`] ?? { data: null, error: null };
      const q: Record<string, unknown> = {
        select: () => q,
        delete: () => ((chamada.op = "delete"), q),
        upsert: (v: unknown) => ((chamada.op = "upsert"), (chamada.valores = v), q),
        eq: (c: string, v: unknown) => (chamada.filtros.push([c, v]), q),
        is: (c: string, v: unknown) => (chamada.filtros.push([c, v]), q),
        maybeSingle: async () => resposta(),
        then: (resolve: (r: unknown) => void) => resolve(resposta()),
      };
      return q;
    },
  } as never);
  return chamadas;
}

function put(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/attendants/sector/${ALVO}`, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}
const ctx = { params: Promise.resolve({ user_id: ALVO }) };

beforeEach(() => {
  vi.mocked(audit).mockClear();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: GERENTE, idioma: "pt-BR" },
    org: { orgId: ORG, role: "manager" },
  } as never);
});

describe("PUT /api/v1/attendants/sector/[user_id]", () => {
  it("exige manager: a recusa do requireRole volta como está", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    const { PUT } = await import("./route");
    const res = await PUT(put({ sector_id: SETOR }), ctx);
    expect(res.status).toBe(403);
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("manager");
  });

  it("põe o atendente no setor, filtrando a org em toda leitura e gravando a org do cookie", async () => {
    const chamadas = mockAdmin({
      "user_organizations:select": { data: { user_id: ALVO }, error: null },
      "attendant_sector_members:select": { data: null, error: null },
      "attendant_sectors:select": { data: { id: SETOR }, error: null },
      "attendant_sector_members:upsert": { data: null, error: null },
    });
    const { PUT } = await import("./route");
    const res = await PUT(put({ sector_id: SETOR }), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ user_id: ALVO, sector_id: SETOR });

    for (const c of chamadas.filter((c) => c.op !== "upsert")) {
      expect(c.filtros).toContainEqual(["organization_id", ORG]);
    }
    const upsert = chamadas.find((c) => c.op === "upsert");
    expect(upsert?.valores).toMatchObject({ organization_id: ORG, user_id: ALVO, sector_id: SETOR });
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "attendant.sector_assigned",
        metadata: expect.objectContaining({ from_sector_id: null, to_sector_id: SETOR }),
      }),
    );
  });

  it("setor que não é desta org vira 404, sem gravar", async () => {
    const chamadas = mockAdmin({
      "user_organizations:select": { data: { user_id: ALVO }, error: null },
      "attendant_sectors:select": { data: null, error: null },
    });
    const { PUT } = await import("./route");
    const res = await PUT(put({ sector_id: OUTRO_SETOR }), ctx);
    expect(res.status).toBe(404);
    expect(chamadas.some((c) => c.op === "upsert")).toBe(false);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("alvo que não é membro ativo vira 404", async () => {
    mockAdmin({ "user_organizations:select": { data: null, error: null } });
    const { PUT } = await import("./route");
    const res = await PUT(put({ sector_id: SETOR }), ctx);
    expect(res.status).toBe(404);
  });

  it("sector_id null tira do setor e audita a saída", async () => {
    const chamadas = mockAdmin({
      "user_organizations:select": { data: { user_id: ALVO }, error: null },
      "attendant_sector_members:select": { data: { sector_id: SETOR }, error: null },
      "attendant_sector_members:delete": { data: null, error: null },
    });
    const { PUT } = await import("./route");
    const res = await PUT(put({ sector_id: null }), ctx);
    expect(res.status).toBe(200);
    const apagou = chamadas.find((c) => c.op === "delete");
    expect(apagou?.filtros).toEqual([["organization_id", ORG], ["user_id", ALVO]]);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ from_sector_id: SETOR, to_sector_id: null }) }),
    );
  });

  it("repetir o mesmo setor não é mutação: não audita", async () => {
    mockAdmin({
      "user_organizations:select": { data: { user_id: ALVO }, error: null },
      "attendant_sector_members:select": { data: { sector_id: SETOR }, error: null },
      "attendant_sectors:select": { data: { id: SETOR }, error: null },
    });
    const { PUT } = await import("./route");
    const res = await PUT(put({ sector_id: SETOR }), ctx);
    expect(res.status).toBe(200);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("corpo inválido é recusado antes de tocar no banco", async () => {
    const chamadas = mockAdmin({});
    const { PUT } = await import("./route");
    const res = await PUT(put({ sector_id: "nao-e-uuid" }), ctx);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(chamadas).toHaveLength(0);
  });
});
