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
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: deps.support }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: deps.admin }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: deps.modulo }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: deps.rate }));
vi.mock("@/lib/external-db/guardas", () => ({ validarHostDeBanco: deps.host }));
vi.mock("@/lib/external-db/credenciais", () => ({
  cifrarSenha: () => ({ password_encrypted: "\\x01", password_iv: "\\x02", password_tag: "\\x03" }),
}));

import { POST } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
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

describe("POST /api/v1/external-db/connections", () => {
  it("conexão NOVA nasce com as fontes em modo list (o assistente não vê nada até o administrador marcar)", async () => {
    let inserido: Record<string, unknown> | undefined;
    deps.admin.mockReturnValue({
      from: () => ({
        insert: (payload: Record<string, unknown>) => {
          inserido = payload;
          return { select: () => ({ single: async () => ({ data: { id: "c-1", ...payload }, error: null }) }) };
        },
      }),
    });

    const res = await POST(
      new NextRequest("http://localhost/api/v1/external-db/connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: "Outro CRM",
          host: "10.0.0.5",
          database_name: "app",
          username: "leitor",
          password: "segredo",
        }),
      }),
    );

    expect(res.status).toBe(201);
    expect(inserido?.source_mode).toBe("list");
    const evento = deps.audit.mock.calls[0]![0] as { metadata: Record<string, unknown> };
    expect(evento.metadata.source_mode).toBe("list");
  });

  it("o corpo NÃO escolhe o modo: um source_mode mandado pelo cliente é recusado pelo contrato estrito", async () => {
    deps.admin.mockReturnValue({ from: () => ({}) });
    const res = await POST(
      new NextRequest("http://localhost/api/v1/external-db/connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: "x",
          host: "10.0.0.5",
          database_name: "app",
          username: "u",
          password: "p",
          source_mode: "all",
        }),
      }),
    );
    expect(res.status).toBe(422);
  });

  it("criar sem db_type grava postgres no insert e no audit", async () => {
    let inserido: Record<string, unknown> | undefined;
    deps.admin.mockReturnValue({
      from: () => ({
        insert: (payload: Record<string, unknown>) => {
          inserido = payload;
          return { select: () => ({ single: async () => ({ data: { id: "c-1", ...payload }, error: null }) }) };
        },
      }),
    });

    const res = await POST(
      new NextRequest("http://localhost/api/v1/external-db/connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: "Outro CRM",
          host: "10.0.0.5",
          database_name: "app",
          username: "leitor",
          password: "segredo",
        }),
      }),
    );

    expect(res.status).toBe(201);
    expect(inserido?.db_type).toBe("postgres");
    const evento = deps.audit.mock.calls[0]![0] as { metadata: Record<string, unknown> };
    expect(evento.metadata.db_type).toBe("postgres");
  });

  it("criar com db_type mysql é recusado (sem driver instalado) e nem chega ao insert", async () => {
    const from = vi.fn().mockReturnValue({});
    deps.admin.mockReturnValue({ from });
    const res = await POST(
      new NextRequest("http://localhost/api/v1/external-db/connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: "x",
          host: "10.0.0.5",
          database_name: "app",
          username: "u",
          password: "p",
          db_type: "mysql",
        }),
      }),
    );
    expect(res.status).toBe(422);
    expect(from).not.toHaveBeenCalled();
  });
});
