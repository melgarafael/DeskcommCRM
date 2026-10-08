/**
 * A lista de canais (GET /api/v1/channel-sessions) é lida por QUALQUER membro,
 * inclusive `viewer`. O #2318 passou a selecionar `metadata` para a tela saber
 * se o canal está pausado — e com ela iam os números de teste da IA e o resto
 * da configuração interna do canal. A resposta leva só `disabled`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const linhas = [
  {
    id: "c1",
    provider: "waha",
    metadata: {
      disabled: true,
      ai_gate: "allowlist",
      ai_gate_mode: "pre_go_live",
      ai_test_phone_numbers: ["+5511999990000"],
      guardar_historico: true,
    },
  },
  { id: "c2", provider: "waha", metadata: null },
];

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ id: "u1" })),
  mfaEmDivida: vi.fn(async () => false),
}));
vi.mock("@/lib/auth/require-role", () => ({
  orgAtivaDaApi: vi.fn(async () => ({ ok: true, org: { orgId: "org-1", role: "viewer" } })),
  requireRole: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => {
  // O cliente NÃO pode ser thenable (o `await createClient()` o desembrularia);
  // quem resolve é a consulta.
  const consulta: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "is", "order"]) consulta[m] = () => consulta;
  consulta.then = (r: (v: unknown) => unknown) =>
    Promise.resolve({ data: linhas, error: null }).then(r);
  return { createClient: vi.fn(async () => ({ from: () => consulta })) };
});

describe("GET /api/v1/channel-sessions — a lista de qualquer membro", () => {
  beforeEach(() => vi.clearAllMocks());

  it("devolve só o `disabled` da metadata, nunca a configuração interna do canal", async () => {
    const { GET } = await import("@/app/api/v1/channel-sessions/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: Array<{ id: string; metadata: unknown }> };
    expect(corpo.data.map((c) => c.metadata)).toEqual([{ disabled: true }, { disabled: false }]);
    expect(JSON.stringify(corpo)).not.toContain("+5511999990000");
  });
});
