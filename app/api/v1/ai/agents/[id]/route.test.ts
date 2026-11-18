/**
 * RENOMEAR AGENTE PELA API — o mesmo índice da criação (#3952).
 *
 * `PATCH /api/v1/ai/agents/:id` também escreve `ai_agents.name`, então o índice
 * `ai_agents_name_unique` (`organization_id`, `name`) pode bater aqui. Antes,
 * `23505` virava `500 "Erro ao atualizar agent."`; agora é 409 com o MESMO código
 * da criação, para a tela poder marcar o campo.
 *
 * O que este arquivo também prende: `23505` de outro índice continua 500 — a
 * régua é o nome do índice, não o código (ver `lib/ai/agents/nome-repetido.ts`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const deps = vi.hoisted(() => ({
  support: vi.fn(),
  authz: vi.fn(),
  teto: vi.fn(),
  admin: vi.fn(),
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: deps.support }));
vi.mock("@/lib/api/auth-dual", () => ({
  resolveAuthDual: deps.authz,
  tetoDeEscritaDoToken: deps.teto,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: deps.admin }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { PATCH } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const AGENTE = "44444444-4444-4444-8444-444444444444";

const EXISTENTE = {
  id: AGENTE,
  organization_id: ORG,
  name: "Recepção",
  description: null,
  model: "claude-sonnet-5",
  system_prompt: "x",
  is_active: true,
  is_default: false,
  kind: "mcp_agent",
  channel: "whatsapp",
  priority: 0,
  published_version_id: null,
  paused_at: null,
  operation_mode: null,
  operation_revision: 1,
  archived_at: null,
  config: {},
  guardrails: [],
  active_kb_version_id: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function bancoFake(erroNoUpdate: unknown) {
  const escritas: Record<string, unknown>[] = [];
  const from = () => ({
    select: () => ({
      eq: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: EXISTENTE, error: null }) }),
      }),
    }),
    update: (payload: Record<string, unknown>) => {
      escritas.push(payload);
      return {
        eq: () => ({
          eq: () => ({
            select: () => ({
              single: async () => ({ data: erroNoUpdate ? null : { ...EXISTENTE, ...payload }, error: erroNoUpdate }),
            }),
          }),
        }),
      };
    },
  });
  return { from, escritas };
}

function pedido(corpo: unknown) {
  return new NextRequest(`http://localhost/api/v1/ai/agents/${AGENTE}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

const ctx = { params: Promise.resolve({ id: AGENTE }) };

beforeEach(() => {
  vi.clearAllMocks();
  deps.support.mockResolvedValue(null);
  deps.teto.mockResolvedValue(null);
  deps.authz.mockResolvedValue({
    ok: true,
    organizationId: ORG,
    idioma: "pt-BR",
    actor: { type: "user", id: "usuario-1" },
    apiTokenId: null,
  });
});

describe("PATCH /api/v1/ai/agents/:id — nome repetido", () => {
  it("renomear para um nome da organização: 409 agent_name_taken", async () => {
    const banco = bancoFake({
      code: "23505",
      message: 'duplicate key value violates unique constraint "ai_agents_name_unique"',
      details: "Key (organization_id, name)=(org, Recepção) already exists.",
    });
    deps.admin.mockReturnValue(banco);

    const res = await PATCH(pedido({ name: "Recepção" }), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: "agent_name_taken", message: "Já existe um agente com esse nome." },
    });
  });

  it("23505 de OUTRO índice não é este conflito: 500 internal_error", async () => {
    deps.admin.mockReturnValue(
      bancoFake({
        code: "23505",
        message: 'duplicate key value violates unique constraint "ai_agents_org_default_unique"',
        details: "Key (organization_id)=(org) already exists.",
      }),
    );

    const res = await PATCH(pedido({ name: "Recepção" }), ctx);
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("internal_error");
  });

  it("alteração aceita continua 200", async () => {
    deps.admin.mockReturnValue(bancoFake(null));
    const res = await PATCH(pedido({ name: "Financeiro" }), ctx);
    expect(res.status).toBe(200);
  });
});
