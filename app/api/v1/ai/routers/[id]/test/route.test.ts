import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadActiveRouter } from "@/lib/agent-engine/agent/router-config";
import { classifyIntent } from "@/lib/agent-engine/agent/intent-classifier";
import { fail } from "@/lib/api/wrappers";
import type { AuthUser } from "@/lib/auth/types";
import type { EstadoDaTarefa } from "@/lib/ai/decisao/config";
import { consultarJevNoRoteador, registrarRoteadorDoJev, type EscolhaDoJev } from "@/lib/ai/decisao/roteador";

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
vi.mock("@/lib/ai/decisao/roteador", () => ({
  consultarJevNoRoteador: vi.fn(),
  registrarRoteadorDoJev: vi.fn(async () => undefined),
}));

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

function makeAdminStub(opts: { routerFound: boolean; agentName?: string | null; nomes?: Record<string, string> }) {
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
        let id: unknown = null;
        return {
          select() {
            return this;
          },
          eq(col: string, v: unknown) {
            if (col === "id") id = v;
            return this;
          },
          maybeSingle() {
            const nome = opts.nomes?.[String(id)];
            return Promise.resolve({
              data: nome
                ? { name: nome }
                : opts.agentName !== undefined
                  ? { name: opts.agentName }
                  : { name: "Agente Vendas" },
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

/** O Jev no clique de teste: o estado da tarefa e a escolha dele. */
function jevCom(estado: EstadoDaTarefa, escolha: EscolhaDoJev | null) {
  vi.mocked(consultarJevNoRoteador).mockReturnValue({
    estado: Promise.resolve(estado),
    escolha: Promise.resolve(escolha),
    observar: vi.fn(),
  });
}

function escolhaDoJev(intentName: string | null, confidence: number, estado: "observando" | "decidindo"): EscolhaDoJev {
  return {
    estado,
    veredito: { intentName, confidence },
    confianca: 0.9,
    modelo: "jev-1.13.0",
    tokensDeEntrada: 400,
    tokensDeSaida: 3,
    latenciaMs: 300,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  jevCom("desligada", null);
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
      // Jev desligado: a tela não mostra o lado dele.
      jev: null,
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

  it("SEM veredito, a confiança volta null — nunca zero", async () => {
    // `?? 0` aqui dizia "o classificador tem certeza de que não é nada" para o
    // caso em que ele não disse nada. A tela local escapava por checar
    // `intent_name` antes de exibir, mas isto é `/api/v1/` — todo outro
    // consumidor leria a invenção como medição.
    mockAuthzOk();
    vi.mocked(createAdminClient).mockReturnValue(makeAdminStub({ routerFound: true }) as never);
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
    vi.mocked(classifyIntent).mockResolvedValue(null as never);

    const { POST } = await import("./route");
    const res = await POST(req({ message: "oi" }), ctx());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { intent_name: string | null; confidence: number | null } };
    expect(body.data.intent_name).toBeNull();
    expect(body.data.confidence, "ausência de veredito não é confiança zero").toBeNull();
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
      jev: null,
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

  describe("o Jev lado a lado (onda 2 do Jev, bloco 2.2)", () => {
    const SUPORTE = "88888888-8888-4888-8888-888888888888";
    const FALLBACK = "99999999-9999-4999-8999-999999999999";

    function roteadorComDoisMembros() {
      mockAuthzOk();
      vi.mocked(createAdminClient).mockReturnValue(
        makeAdminStub({
          routerFound: true,
          nomes: { [AGENT_ID]: "Agente Vendas", [SUPORTE]: "Agente Suporte", [FALLBACK]: "Agente Reserva" },
        }) as never,
      );
      vi.mocked(loadActiveRouter).mockResolvedValue({
        id: ROUTER_ID,
        name: "Roteador",
        classifierModel: null,
        classifierProvider: null,
        sticky: true,
        minConfidence: 0.6,
        fallbackAgentId: FALLBACK,
        members: [
          { agentId: AGENT_ID, intentName: "vendas", intentDescription: "Quer comprar", examples: [] },
          { agentId: SUPORTE, intentName: "suporte", intentDescription: "Tem um problema", examples: [] },
        ],
      });
    }

    async function testar(mensagem = "meu pedido não chegou") {
      const { POST } = await import("./route");
      const res = await POST(req({ message: mensagem }), ctx());
      expect(res.status).toBe(200);
      return ((await res.json()) as { data: Record<string, unknown> & { jev: Record<string, unknown> | null } })
        .data;
    }

    it("observando: as duas escolhas, com o AGENTE de cada uma — e a da sua IA é a que valeria", async () => {
      roteadorComDoisMembros();
      vi.mocked(classifyIntent).mockResolvedValue({ intentName: "vendas", confidence: 0.8 });
      jevCom("observando", escolhaDoJev("suporte", 0.91, "observando"));

      const d = await testar();
      expect(d.agent_name).toBe("Agente Vendas");
      expect(d.jev).toEqual({
        estado: "observando",
        respondeu: true,
        intent_name: "suporte",
        confidence: 0.91,
        agent_id: SUPORTE,
        agent_name: "Agente Suporte",
        decide: false,
      });
      // A frase do teste, sozinha, sem cliente nem job por trás.
      expect(vi.mocked(consultarJevNoRoteador).mock.calls[0]![1]).toMatchObject({
        mensagem: "meu pedido não chegou",
        contactId: null,
        jobId: null,
      });
    });

    it("não vira observação (R5), mas o custo do Jev entra em Execuções (R8)", async () => {
      roteadorComDoisMembros();
      vi.mocked(classifyIntent).mockResolvedValue({ intentName: "vendas", confidence: 0.8 });
      const escolha = escolhaDoJev("suporte", 0.91, "observando");
      jevCom("observando", escolha);

      await testar();
      expect(registrarRoteadorDoJev).toHaveBeenCalledOnce();
      expect(vi.mocked(registrarRoteadorDoJev).mock.calls[0]![1]).toMatchObject({
        jev: escolha,
        observacao: null,
        decidiu: false,
        contactId: null,
        jobId: null,
      });
    });

    it("decidindo, com a sua IA respondendo: em produção vale a escolha do Jev", async () => {
      roteadorComDoisMembros();
      vi.mocked(classifyIntent).mockResolvedValue({ intentName: "vendas", confidence: 0.8 });
      jevCom("decidindo", escolhaDoJev("suporte", 0.91, "decidindo"));

      const d = await testar();
      expect(d.jev).toMatchObject({ estado: "decidindo", agent_id: SUPORTE, decide: true });
    });

    it("decidindo, sem a sua IA (R2): vale a regra de sempre, nunca só o Jev", async () => {
      roteadorComDoisMembros();
      vi.mocked(classifyIntent).mockResolvedValue(null as never);
      jevCom("decidindo", escolhaDoJev("suporte", 0.99, "decidindo"));

      const d = await testar();
      expect(d.agent_id, "sem a IA de sempre, o de reserva").toBe(FALLBACK);
      expect(d.jev).toMatchObject({ agent_id: SUPORTE, decide: false });
    });

    it("decidindo, e a sua IA devolve algo que não é resposta: ela 'não respondeu', e o Jev não decide sozinho (R2)", async () => {
      roteadorComDoisMembros();
      vi.mocked(classifyIntent).mockResolvedValue({ intentName: null, confidence: 0, falhou: true });
      jevCom("decidindo", escolhaDoJev("suporte", 0.99, "decidindo"));

      const d = await testar();
      expect(d.confidence, "a tela lê null como 'não respondeu'").toBeNull();
      expect(d.agent_id, "o lixo segue 'nenhuma': o de reserva").toBe(FALLBACK);
      expect(d.jev).toMatchObject({ agent_id: SUPORTE, decide: false });
    });

    it("a probabilidade do Jev abaixo do mínimo leva ao de reserva — a mesma régua da sua IA", async () => {
      roteadorComDoisMembros();
      vi.mocked(classifyIntent).mockResolvedValue({ intentName: "vendas", confidence: 0.8 });
      jevCom("observando", escolhaDoJev("suporte", 0.4, "observando"));

      const d = await testar();
      expect(d.jev).toMatchObject({ intent_name: "suporte", confidence: 0.4, agent_id: FALLBACK, agent_name: "Agente Reserva" });
    });

    it("ligado e sem resposta: a tela diz que ele não respondeu, e nada é gravado", async () => {
      roteadorComDoisMembros();
      vi.mocked(classifyIntent).mockResolvedValue({ intentName: "vendas", confidence: 0.8 });
      jevCom("observando", null);

      const d = await testar();
      expect(d.jev).toEqual({
        estado: "observando",
        respondeu: false,
        intent_name: null,
        confidence: null,
        agent_id: null,
        agent_name: null,
        decide: false,
      });
      expect(registrarRoteadorDoJev).not.toHaveBeenCalled();
    });
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
