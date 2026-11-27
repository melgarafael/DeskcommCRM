/**
 * A LISTA DE FLUXOS TRAZ O TIPO DO GATILHO (#4593).
 *
 * A busca de Follow-ups passou a casar com o gatilho do fluxo, e a lista que a
 * tela recarrega vem de `GET /api/v1/ai/followup-flows`. Sem a coluna na
 * resposta, o termo «silencio» acharia o fluxo na primeira pintura (a página do
 * servidor) e deixaria de achar depois do primeiro refetch.
 *
 * Só o `kind` sai — `trigger_kind:trigger_config->>kind` —, não o
 * `trigger_config` inteiro: a rota também responde a token de API, e a busca não
 * precisa de mais nada.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const deps = vi.hoisted(() => ({
  role: vi.fn(),
  client: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: deps.client }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: vi.fn(async () => true) }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }));

import { GET } from "@/app/api/v1/ai/followup-flows/route";

function clientDaLista() {
  const colunas: string[] = [];
  const cadeia = {
    select: (c: string) => (colunas.push(c), cadeia),
    eq: () => cadeia,
    neq: () => cadeia,
    order: async () => ({ data: [], error: null }),
  };
  return { colunas, client: { from: () => cadeia } };
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.role.mockResolvedValue({
    ok: true,
    user: { id: "eu", idioma: "pt-BR" },
    org: { orgId: "11111111-1111-4111-8111-111111111111", role: "manager" },
  });
});

describe("U8 — GET /api/v1/ai/followup-flows", () => {
  it("pede o tipo do gatilho junto das colunas de sempre", async () => {
    const { colunas, client } = clientDaLista();
    deps.client.mockResolvedValue(client);
    const res = await GET(new NextRequest("http://localhost/api/v1/ai/followup-flows"));
    expect(res.status).toBe(200);
    const pedidas = (colunas[0] ?? "").split(",").map((c) => c.trim());
    expect(pedidas).toEqual([
      "id",
      "name",
      "status",
      "active_version_id",
      "handoff_policy",
      "updated_at",
      "trigger_kind:trigger_config->>kind",
    ]);
  });
});
