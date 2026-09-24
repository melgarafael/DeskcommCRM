/**
 * Criar roteiro de atendimento (`surface: "atendimento"`) só existe com o módulo
 * `fluxos_atendimento` ligado na instalação (doc 64). Desligado, a porta não
 * existe: 404, sem tocar no banco da organização — a mesma resposta do banco
 * externo desligado. O follow-up comum não consulta a chave.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const deps = vi.hoisted(() => ({
  role: vi.fn(),
  support: vi.fn(),
  audit: vi.fn(),
  client: vi.fn(),
  modulo: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: deps.support }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/supabase/server", () => ({ createClient: deps.client }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: deps.modulo }));

import { POST } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";

function clientFake() {
  const capturado: { payload?: Record<string, unknown> } = {};
  const client = {
    from: () => ({
      insert: (payload: Record<string, unknown>) => {
        capturado.payload = payload;
        return {
          select: () => ({
            single: async () => ({ data: { id: "novo", status: "draft", ...payload }, error: null }),
          }),
        };
      },
    }),
  };
  return { capturado, client };
}

function req(body: unknown) {
  return new NextRequest("http://localhost/api/v1/ai/followup-flows", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.support.mockResolvedValue(null);
  deps.role.mockResolvedValue({
    ok: true,
    user: { id: "eu", idioma: "pt-BR" },
    org: { orgId: ORG, role: "manager" },
  });
});

describe("POST /api/v1/ai/followup-flows — roteiro de atendimento", () => {
  it("módulo desligado: 404 e nada é gravado", async () => {
    const { capturado, client } = clientFake();
    deps.client.mockResolvedValue(client);
    deps.modulo.mockResolvedValue(false);

    const res = await POST(req({ name: "Cadastro", surface: "atendimento" }));
    expect(res.status).toBe(404);
    expect(capturado.payload).toBeUndefined();
    expect(deps.modulo).toHaveBeenCalledWith(expect.anything(), "fluxos_atendimento");
  });

  it("módulo ligado: cria o roteiro com a superfície gravada", async () => {
    const { capturado, client } = clientFake();
    deps.client.mockResolvedValue(client);
    deps.modulo.mockResolvedValue(true);

    const res = await POST(req({ name: "Cadastro", surface: "atendimento" }));
    expect(res.status).toBe(201);
    expect(capturado.payload).toMatchObject({ organization_id: ORG, surface: "atendimento" });
  });

  it("follow-up comum não consulta a chave nem grava superfície", async () => {
    const { capturado, client } = clientFake();
    deps.client.mockResolvedValue(client);

    const res = await POST(req({ name: "Retomada" }));
    expect(res.status).toBe(201);
    expect(deps.modulo).not.toHaveBeenCalled();
    expect(capturado.payload).not.toHaveProperty("surface");
  });
});
