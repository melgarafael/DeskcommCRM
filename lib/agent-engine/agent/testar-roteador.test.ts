/**
 * A FUNÇÃO, CHAMADA DIRETO — sem `NextRequest`, sem `Response`.
 *
 * Por que este arquivo existe além de `route.test.ts`: aquele mede a borda HTTP
 * (status, código, corpo). Este mede o CONTRATO da função que a rota passou a
 * chamar — que é o que o servidor MCP e a automação vão usar. Se a rota fosse
 * uma casca e a regra continuasse nela, os casos abaixo reprovariam: a função
 * é quem responde agora.
 *
 * O caso do roteador por remetente e o do `sob_demanda` sem a IA de sempre estão
 * aqui porque são as duas recusas que nenhum teste de borda prendia.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadActiveRouter } from "@/lib/agent-engine/agent/router-config";
import { classifyIntent } from "@/lib/agent-engine/agent/intent-classifier";
import { consultarJevNoRoteador, registrarRoteadorDoJev } from "@/lib/ai/decisao/roteador";
import type * as Credenciais from "@/lib/agent-engine/edge/llm/credentials";
import { testarRoteador, type DependenciasDoTesteDoRoteador } from "./testar-roteador";

vi.mock("@/lib/agent-engine/agent/router-config", () => ({ loadActiveRouter: vi.fn() }));
vi.mock("@/lib/agent-engine/agent/intent-classifier", () => ({ classifyIntent: vi.fn() }));
const { temIaDeSempre } = vi.hoisted(() => ({ temIaDeSempre: vi.fn(async () => true) }));
vi.mock("@/lib/agent-engine/edge/llm/credentials", async (original) => ({
  ...(await original<typeof Credenciais>()),
  temIaDeSempre,
}));
vi.mock("@/lib/ai/decisao/roteador", () => ({
  consultarJevNoRoteador: vi.fn(),
  registrarRoteadorDoJev: vi.fn(async () => undefined),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const ROUTER_ID = "55555555-5555-4555-8555-555555555555";
const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const AGENT_ID = "66666666-6666-4666-8666-666666666666";

function adminFake(opts: { routerFound?: boolean; erroNoRouter?: { message: string } | null; nomes?: Record<string, string> } = {}) {
  const filtros: Record<string, unknown>[] = [];
  return {
    filtros,
    from(tabela: string) {
      const f: Record<string, unknown> = {};
      const api = {
        select: () => api,
        eq(k: string, v: unknown) {
          f[k] = v;
          return api;
        },
        maybeSingle: async () => {
          if (tabela === "ai_agents") {
            return { data: { name: opts.nomes?.[String(f.id)] ?? "Agente Vendas" }, error: null };
          }
          filtros.push(f);
          if (opts.erroNoRouter) return { data: null, error: opts.erroNoRouter };
          return {
            data: opts.routerFound === false ? null : { id: ROUTER_ID, channel_session_id: SESSION_ID },
            error: null,
          };
        },
      };
      return api;
    },
  };
}

function deps(admin: ReturnType<typeof adminFake>, over: Partial<DependenciasDoTesteDoRoteador> = {}) {
  return {
    admin: admin as never,
    pool: {} as never,
    llmCfg: {} as never,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  };
}

function routerAtivo(over: Record<string, unknown> = {}) {
  return {
    id: ROUTER_ID,
    name: "Roteador",
    classifierModel: "claude-haiku-4-5",
    classifierProvider: null,
    sticky: true,
    minConfidence: 0.6,
    fallbackAgentId: null,
    senderRoutes: [],
    members: [{ agentId: AGENT_ID, intentName: "vendas", intentDescription: "Quer comprar", examples: [] }],
    ...over,
  } as never;
}

function jevCom(estado: string, escolha: unknown, modo: "comparacao" | "sob_demanda" = "comparacao") {
  vi.mocked(consultarJevNoRoteador).mockReturnValue({
    modo: Promise.resolve(modo),
    estado: Promise.resolve(estado),
    escolha: Promise.resolve(escolha),
    observar: vi.fn(),
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(temIaDeSempre).mockResolvedValue(true);
  jevCom("desligada", null);
});

describe("testarRoteador — o caminho feliz devolve o MESMO payload da rota", () => {
  it("classifica e devolve os campos do wire de hoje", async () => {
    const admin = adminFake();
    vi.mocked(loadActiveRouter).mockResolvedValue(routerAtivo());
    vi.mocked(classifyIntent).mockResolvedValue({ intentName: "vendas", confidence: 0.92 } as never);

    const r = await testarRoteador(deps(admin), {
      organizationId: ORG,
      routerId: ROUTER_ID,
      mensagem: "quanto custa?",
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({
      ia_consultada: true,
      modo_roteador: "comparacao",
      intent_name: "vendas",
      confidence: 0.92,
      min_confidence: 0.6,
      agent_id: AGENT_ID,
      agent_name: "Agente Vendas",
      jev: null,
    });
    // A leitura filtra a organização: é ela que separa A de B sem RLS.
    expect(admin.filtros[0]).toEqual({ id: ROUTER_ID, organization_id: ORG });
    // O clique de teste nunca grava decisão real.
    expect(registrarRoteadorDoJev).not.toHaveBeenCalled();
  });

  it("sem veredito, confidence é null — nunca 0, que seria uma afirmação", async () => {
    vi.mocked(loadActiveRouter).mockResolvedValue(routerAtivo());
    vi.mocked(classifyIntent).mockResolvedValue(null as never);

    const r = await testarRoteador(deps(adminFake()), {
      organizationId: ORG,
      routerId: ROUTER_ID,
      mensagem: "oi",
    });

    expect(r.ok && r.data.confidence).toBeNull();
    expect(r.ok && r.data.intent_name).toBeNull();
  });
});

describe("testarRoteador — as recusas, com o mesmo código e status da rota", () => {
  it("router de outra organização ou inexistente é 404", async () => {
    const r = await testarRoteador(deps(adminFake({ routerFound: false })), {
      organizationId: ORG,
      routerId: ROUTER_ID,
      mensagem: "oi",
    });
    expect(r).toEqual({ ok: false, code: "not_found", status: 404, message: "Router não encontrado." });
  });

  it("erro de banco é 500 com a mensagem de hoje, que NÃO passa pelo dicionário", async () => {
    const r = await testarRoteador(
      deps(adminFake({ erroNoRouter: { message: "boom" } }), { t: (x) => `ES:${x}` }),
      { organizationId: ORG, routerId: ROUTER_ID, mensagem: "oi" },
    );
    expect(r).toEqual({
      ok: false,
      code: "internal_error",
      status: 500,
      message: "Erro ao carregar router.",
    });
  });

  it("router inativo é 409 — e o tradutor da borda alcança esta mensagem", async () => {
    vi.mocked(loadActiveRouter).mockResolvedValue(null);
    const r = await testarRoteador(deps(adminFake(), { t: (x) => `ES:${x}` }), {
      organizationId: ORG,
      routerId: ROUTER_ID,
      mensagem: "oi",
    });
    expect(r).toEqual({
      ok: false,
      code: "state_conflict",
      status: 409,
      message: "ES:O router precisa estar ativo (is_active=true) para ser testado.",
    });
  });

  it("roteador por remetente é 409 com a explicação, sem tradução (mensagem interpolada na origem)", async () => {
    vi.mocked(loadActiveRouter).mockResolvedValue(
      routerAtivo({ senderRoutes: [{ senderId: SESSION_ID, agentId: AGENT_ID }] }),
    );
    const r = await testarRoteador(deps(adminFake(), { t: (x) => `ES:${x}` }), {
      organizationId: ORG,
      routerId: ROUTER_ID,
      mensagem: "oi",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect([r.code, r.status]).toEqual(["state_conflict", 409]);
    expect(r.message).toContain("Este roteador escolhe pelo remetente.");
    expect(r.message.startsWith("ES:")).toBe(false);
  });
});

describe("testarRoteador — o sob_demanda sem a IA de sempre", () => {
  it("sem a IA de sempre, o Jev não decide sozinho: a reserva é consultada", async () => {
    vi.mocked(loadActiveRouter).mockResolvedValue(routerAtivo());
    vi.mocked(classifyIntent).mockResolvedValue({ intentName: "vendas", confidence: 0.7 } as never);
    vi.mocked(temIaDeSempre).mockResolvedValue(false);
    jevCom(
      "decidindo",
      { estado: "decidindo", veredito: { intentName: "vendas", confidence: 0.99 } },
      "sob_demanda",
    );

    const r = await testarRoteador(deps(adminFake()), {
      organizationId: OUTRA_ORG,
      routerId: ROUTER_ID,
      mensagem: "oi",
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.modo_roteador).toBe("sob_demanda");
    // Sem a IA de sempre o Jev não decide sozinho: a reserva é consultada.
    expect(r.data.ia_consultada).toBe(true);
    expect(classifyIntent).toHaveBeenCalled();
    // A IA de sempre foi conferida NA organização do ator.
    const chamada = vi.mocked(temIaDeSempre).mock.calls[0] as unknown as unknown[];
    expect(chamada?.[2]).toBe(OUTRA_ORG);
    // O Jev é registrado como observação, nunca como decisão.
    expect(vi.mocked(registrarRoteadorDoJev).mock.calls[0]?.[1]).toMatchObject({ decidiu: false });
  });
});
