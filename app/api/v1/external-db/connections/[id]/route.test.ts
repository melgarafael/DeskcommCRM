import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  role: vi.fn(),
  support: vi.fn(),
  audit: vi.fn(),
  admin: vi.fn(),
  modulo: vi.fn(),
  rate: vi.fn(),
  host: vi.fn(),
  pool: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: deps.support }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: deps.admin }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: deps.modulo }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: deps.rate }));
vi.mock("@/lib/external-db/guardas", () => ({ validarHostDeBanco: deps.host }));
vi.mock("@/lib/external-db/conexao", () => ({ fecharPool: deps.pool }));
vi.mock("@/lib/external-db/credenciais", () => ({
  cifrarSenha: () => ({ password_encrypted: "\\x01", password_iv: "\\x02", password_tag: "\\x03" }),
}));

import { PATCH } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const ID = "c-1";

const selecionadas: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  selecionadas.length = 0;
  deps.modulo.mockResolvedValue(true);
  deps.support.mockResolvedValue(null);
  deps.rate.mockResolvedValue({ allowed: true });
  deps.host.mockResolvedValue({ ok: true, enderecos: ["10.0.0.5"] });
  deps.role.mockResolvedValue({
    ok: true,
    user: { id: "u-1", idioma: "pt-BR" },
    org: { orgId: ORG, role: "admin" },
  });
});

describe("PATCH /api/v1/external-db/connections/:id", () => {
  it("a escrita volta da TABELA BASE: o select do update não pede a coluna calculada sources_count", async () => {
    deps.admin.mockReturnValue({
      from: () => ({
        update: (patch: Record<string, unknown>) => ({
          eq: () => ({
            eq: () => ({
              select: (colunas: string) => {
                selecionadas.push(colunas);
                return { maybeSingle: async () => ({ data: { id: ID, ...patch }, error: null }) };
              },
            }),
          }),
        }),
      }),
    });

    const res = await PATCH(
      new NextRequest(`http://localhost/api/v1/external-db/connections/${ID}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "Nome novo" }),
      }),
      { params: Promise.resolve({ id: ID }) },
    );

    expect(res.status).toBe(200);
    // Sem isto, pedir sources_count na tabela base quebrava com 42703 e a rota devolvia 500.
    expect(selecionadas.join(",")).not.toContain("sources_count");
    expect(selecionadas.join(",")).toContain("id");
    expect(selecionadas.join(",")).toContain("source_mode");
  });
});
