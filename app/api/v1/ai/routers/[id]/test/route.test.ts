import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadActiveRouter } from "@/lib/agent-engine/agent/router-config";
import { classifyIntent } from "@/lib/agent-engine/agent/intent-classifier";
import { fail } from "@/lib/api/wrappers";
import type { AuthUser } from "@/lib/auth/types";

/**
 * Task 6 (Fase 3 — Intent Router) — POST /api/v1/ai/routers/:id/test:
 *  - classifica uma mensagem de TESTE reusando loadActiveRouter/classifyIntent
 *    (Tasks 2-3, o MESMO seam do runtime);
 *  - devolve intent_name/confidence/agent_id/agent_name SEM gravar em
 *    ai_router_decisions (telemetria de decisão real, não de teste).
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai/skills/db", () => ({ getSkillsPool: vi.fn(() => ({})) }));
vi.mock("@/lib/agent-engine/agent/router-config", () => ({ loadActiveRouter: vi.fn() }));
vi.mock("@/lib/agent-engine/agent/intent-classifier", () => ({ classifyIntent: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: { ANTHROPIC_API_KEY: "test-key" } }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const ROUTER_ID = "55555555-5555-4555-8555-555555555555";
const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const AGENT_ID = "66666666-6666-4666-8666-666666666666";

function mockAuthzOk() {
  const user: AuthUser = {
    id: USER_ID,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "manager" }],
  };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG_ID, name: "Org", role: "manager" },
  });
}

function makeAdminStub(opts: { routerFound: boolean; agentName?: string | null }) {
  return {
    from(table: string) {
      if (table === "ai_routers") {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          maybeSingle() {
            return Promise.resolve({
              data: opts.routerFound ? { id: ROUTER_ID, channel_session_id: SESSION_ID } : null,
              error: null,
            });
          },
        };
      }
      if (table === "ai_agents") {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          maybeSingle() {
            return Promise.resolve({
              data: opts.agentName !== undefined ? { name: opts.agentName } : { name: "Agente Vendas" },
              error: null,
            });
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

function req(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/ai/routers/${ROUTER_ID}/test`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function ctx() {
  return { params: Promise.resolve({ id: ROUTER_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/ai/routers/:id/test", () => {
  it("sem auth → repassa authz.response", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthenticated", "Auth required.", 401, {}),
    });
    const { POST } = await import("./route");
    const res = await POST(req({ message: "oi" }), ctx());
    expect(res.status).toBe(401);
  });

  it("classifica e devolve intent_name/confidence/agent_id/agent_name, sem gravar ai_router_decisions", async () => {
    mockAuthzOk();
    vi.mocked(createAdminClient).mockReturnValue(makeAdminStub({ routerFound: true, agentName: "Agente Vendas" }) as never);
    vi.mocked(loadActiveRouter).mockResolvedValue({
      id: ROUTER_ID,
      name: "Roteador",
      classifierModel: "claude-haiku-4-5",
      classifierProvider: null,
      sticky: true,
      minConfidence: 0.6,
      fallbackAgentId: null,
      members: [
        { agentId: AGENT_ID, intentName: "vendas", intentDescription: "Quer comprar", examples: [] },
      ],
    });
    vi.mocked(classifyIntent).mockResolvedValue({ intentName: "vendas", confidence: 0.92 });

    const { POST } = await import("./route");
    const res = await POST(req({ message: "quanto custa o plano?" }), ctx());

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { intent_name: string | null; confidence: number; agent_id: string | null; agent_name: string | null };
    };
    expect(body.data).toEqual({
      intent_name: "vendas",
      confidence: 0.92,
      min_confidence: 0.6,
      agent_id: AGENT_ID,
      agent_name: "Agente Vendas",
    });

    // classifyIntent chamado com leadId/jobId null (nunca um uuid inventado —
    // violaria a FK de llm_calls.contact_id/job_id).
    const [, , classifyInput] = vi.mocked(classifyIntent).mock.calls[0]!;
    expect(classifyInput.leadId).toBeNull();
    expect(classifyInput.jobId).toBeNull();

    // NUNCA grava em ai_router_decisions — a única tabela tocada é ai_routers
    // (leitura) e ai_agents (leitura do nome); nenhuma chamada de INSERT/DELETE.
    const admin = vi.mocked(createAdminClient).mock.results[0]!.value as { from: (t: string) => unknown };
    expect(() => admin.from("ai_router_decisions")).toThrow();
  });

  it("confidence abaixo do min_confidence → não casa o membro, cai no fallback do router (espelha resolve-turn-agent)", async () => {
    mockAuthzOk();
    vi.mocked(createAdminClient).mockReturnValue(makeAdminStub({ routerFound: true, agentName: "Agente Fallback" }) as never);
    vi.mocked(loadActiveRouter).mockResolvedValue({
      id: ROUTER_ID,
      name: "Roteador",
      classifierModel: "claude-haiku-4-5",
      classifierProvider: null,
      sticky: true,
      minConfidence: 0.6,
      fallbackAgentId: AGENT_ID,
      members: [
        { agentId: "77777777-7777-4777-8777-777777777777", intentName: "vendas", intentDescription: "Quer comprar", examples: [] },
      ],
    });
    vi.mocked(classifyIntent).mockResolvedValue({ intentName: "vendas", confidence: 0.4 });

    const { POST } = await import("./route");
    const res = await POST(req({ message: "talvez eu compre" }), ctx());

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { intent_name: string | null; confidence: number; min_confidence: number; agent_id: string | null; agent_name: string | null };
    };
    // intent_name reporta o que o classificador viu, mas agent_id NÃO é o
    // membro "vendas" — confidence 0.4 < min_confidence 0.6 cai no fallback,
    // igual à produção (resolve-turn-agent.ts:193).
    expect(body.data).toEqual({
      intent_name: "vendas",
      confidence: 0.4,
      min_confidence: 0.6,
      agent_id: AGENT_ID,
      agent_name: "Agente Fallback",
    });
  });

  it("router não está ativo (loadActiveRouter não devolve este id) → 409 state_conflict", async () => {
    mockAuthzOk();
    vi.mocked(createAdminClient).mockReturnValue(makeAdminStub({ routerFound: true }) as never);
    vi.mocked(loadActiveRouter).mockResolvedValue(null);

    const { POST } = await import("./route");
    const res = await POST(req({ message: "oi" }), ctx());
    expect(res.status).toBe(409);
    expect(classifyIntent).not.toHaveBeenCalled();
  });

  it("router não encontrado na org → 404", async () => {
    mockAuthzOk();
    vi.mocked(createAdminClient).mockReturnValue(makeAdminStub({ routerFound: false }) as never);

    const { POST } = await import("./route");
    const res = await POST(req({ message: "oi" }), ctx());
    expect(res.status).toBe(404);
    expect(loadActiveRouter).not.toHaveBeenCalled();
  });

  it("body inválido (message vazio) → 422 validation_failed", async () => {
    mockAuthzOk();
    const { POST } = await import("./route");
    const res = await POST(req({ message: "" }), ctx());
    expect(res.status).toBe(422);
  });
});

// Este teste isola o handler; autoridade de suporte é exercitada na suíte própria.
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/impersonate/support")>(),
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => "f2200000-0000-4000-8000-000000000099"),
}));
