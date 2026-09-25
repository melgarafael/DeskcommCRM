import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/v1/ai/knowledge/reindex-all — "Preparar tudo de novo" (recorte do
 * #1130, de @vgamkt).
 *
 * O que se trava aqui: o papel exigido é `manager` (o mesmo do reindexar de uma
 * fonte), a organização vem da sessão, o que não está pronto entra na fila
 * ANTES do que já está, e a mutação AUDITA — quando há material; sem material
 * nada mudou e não há auditoria.
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";

let fontes: Array<Record<string, unknown>>;
let filtrosDaLeitura: Array<[string, unknown]>;
let emitidos: Array<Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  filtrosDaLeitura = [];
  emitidos = [];
  fontes = [
    { id: "ks-pronta", agent_id: null, source_type: "faq", last_index_status: "success" },
    { id: "ks-falhou", agent_id: null, source_type: "documento", last_index_status: "failed" },
  ];

  vi.mocked(requireSupportWrite).mockResolvedValue(null as never);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID, idioma: "pt-BR" },
    org: { orgId: ORG_ID, role: "manager" },
  } as never);

  const leitura = {
    select: () => leitura,
    eq: (col: string, v: unknown) => {
      filtrosDaLeitura.push([col, v]);
      return leitura;
    },
    neq: () => Promise.resolve({ data: fontes, error: null }),
  };
  vi.mocked(createClient).mockResolvedValue({ from: () => leitura } as never);

  const escrita = { eq: () => escrita, neq: () => Promise.resolve({ error: null }) };
  vi.mocked(createAdminClient).mockReturnValue({
    from: () => ({ update: () => escrita }),
    rpc: (_fn: string, args: Record<string, unknown>) => {
      emitidos.push(args);
      return Promise.resolve({ error: null });
    },
  } as never);
});

describe("POST /api/v1/ai/knowledge/reindex-all", () => {
  it("exige manager e lê só a organização da sessão", async () => {
    const { POST } = await import("./route");
    await POST();
    expect(requireRole).toHaveBeenCalledWith("manager", expect.objectContaining({ resource: "ai_knowledge" }));
    expect(filtrosDaLeitura).toContainEqual(["organization_id", ORG_ID]);
  });

  it("papel insuficiente: devolve a recusa e não emite nada", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    const { POST } = await import("./route");
    const res = await POST();
    expect(res.status).toBe(403);
    expect(emitidos).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("o que não está pronto vai primeiro, e a mutação é auditada com as contagens", async () => {
    const { POST } = await import("./route");
    const res = await POST();
    expect(res.status).toBe(200);
    expect(emitidos.map((e) => e["p_entity_id"])).toEqual(["ks-falhou", "ks-pronta"]);
    expect(emitidos.every((e) => e["p_organization_id"] === ORG_ID)).toBe(true);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai.knowledge_reindex_all",
        actorUserId: USER_ID,
        organizationId: ORG_ID,
        metadata: { total: 2, prioridade1: 1, prioridade2: 1, emitidos: 2 },
      }),
    );
  });

  it("sem material: nada mudou, e não há auditoria", async () => {
    fontes = [];
    const { POST } = await import("./route");
    const res = await POST();
    const body = (await res.json()) as { data: { total: number } };
    expect(body.data.total).toBe(0);
    expect(audit).not.toHaveBeenCalled();
  });
});
