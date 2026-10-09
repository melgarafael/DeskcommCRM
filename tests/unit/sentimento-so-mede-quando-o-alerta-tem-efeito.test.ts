/**
 * O SENTIMENTO SÓ PAGA O MODELO QUANDO O ALERTA TEM QUEM O CONSUMA.
 *
 * `workers/ai-sentiment-worker.ts` roda uma vez por MENSAGEM recebida. O efeito
 * dele é o `ai.sentiment_alert`, que vira `triggerHandoff` — e o handoff recusa
 * toda conversa em que a IA não pode atender (`elegib && !elegib.permite`,
 * `lib/ai/handoff/orchestrator.ts`, "GATE DE ELEGIBILIDADE"). O worker só pulava
 * a trava da lista; nos outros vetos (uma pessoa no comando, conversa
 * silenciada, contato passado a humano) ele pagava o modelo e o alerta morria
 * no handoff. Os pedidos do cliente também não rodam ali:
 * `perguntarOsPedidosDoCliente` devolve `null` sem `iaPodeResponder`.
 *
 * E o resolvedor do modelo (três leituras e uma decifragem) rodava ANTES de
 * qualquer guarda — inclusive para mensagem sem texto, que pula logo depois.
 *
 * O controle positivo é a conversa elegível: ela tem de continuar disparando o
 * alerta, senão "não chama o modelo" passaria por um worker que não faz nada.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-teste",
  AI_GATEWAY_API_KEY: "",
  OPENROUTER_API_KEY: "",
  OPENAI_API_KEY: "",
};
vi.mock("@/lib/env", () => ({
  get env() {
    return envMock;
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai/log-invocation", () => ({ logInvocation: vi.fn() }));
vi.mock("@/lib/ai/cost", () => ({ computeCost: vi.fn(async () => 1) }));
vi.mock("@/lib/ai/gateway-binding", () => ({ resolverModeloDoPonto: vi.fn() }));
vi.mock("ai", () => ({ generateObject: vi.fn() }));

import { generateObject } from "ai";

import { resolverModeloDoPonto } from "@/lib/ai/gateway-binding";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";
import { processSentiment } from "@/workers/ai-sentiment-worker";

const ORG = "11111111-1111-4111-8111-111111111111";
const MSG = "22222222-2222-4222-8222-222222222222";
const CONV = "33333333-3333-4333-8333-333333333333";
const SESSAO = "44444444-4444-4444-8444-444444444444";
const AGENTE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VERSAO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** Abaixo do limiar padrão (0.3): numa conversa elegível, o alerta sai. */
const NOTA_IRRITADA = 0.1;

type Linha = Record<string, unknown>;

/** Mini-banco: aplica `eq`/`is`, e anota cada tabela lida. */
function fazerAdmin(banco: Record<string, Linha[]>, lidas: string[], rpcs: Linha[]) {
  const from = (tabela: string) => {
    lidas.push(tabela);
    const filtros: Array<(l: Linha) => boolean> = [];
    const linhas = () => (banco[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = new Proxy(
      {},
      {
        get: (_alvo, prop: string) => {
          if (prop === "maybeSingle" || prop === "single") {
            return () => Promise.resolve({ data: linhas()[0] ?? null, error: null });
          }
          if (prop === "then") {
            return (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) =>
              Promise.resolve({ data: linhas(), error: null }).then(ok, falha);
          }
          return (...args: unknown[]) => {
            if (prop === "eq") filtros.push((l) => l[args[0] as string] === args[1]);
            if (prop === "is") filtros.push((l) => (l[args[0] as string] ?? null) === args[1]);
            return chain;
          };
        },
      },
    );
    return chain;
  };
  return {
    from,
    rpc: (nome: string, args: Linha) => {
      rpcs.push({ nome, ...args });
      return Promise.resolve({ data: null, error: null });
    },
  };
}

interface Cenario {
  conversa?: Linha;
  corpo?: string;
}

function montarBanco(c: Cenario): Record<string, Linha[]> {
  return {
    organizations: [{ id: ORG, settings: {}, locale: "pt-BR" }],
    messages: [
      {
        id: MSG,
        organization_id: ORG,
        conversation_id: CONV,
        body: c.corpo ?? "já é a terceira vez que eu peço isso",
        direction: "inbound",
        metadata: {},
      },
    ],
    conversations: [
      {
        id: CONV,
        organization_id: ORG,
        channel_session_id: SESSAO,
        active_ai_agent_id: null,
        contact_id: "55555555-5555-4555-8555-555555555555",
        is_group: false,
        assignee_kind: "ai",
        bot_silenced_until: null,
        // Os embeds que a régua de elegibilidade lê.
        organizations: { status: "active" },
        contacts: { force_human: false, ai_authorized_at: null, phone_number: null },
        channel_sessions: { metadata: {} },
        ...c.conversa,
      },
    ],
    ai_agents: [
      {
        id: AGENTE,
        organization_id: ORG,
        config: {},
        kind: "mcp_agent",
        is_active: true,
        priority: 0,
        created_at: "2026-01-01T00:00:00.000Z",
        published_version_id: VERSAO,
        archived_at: null,
        paused_at: null,
      },
    ],
    ai_agent_versions: [
      { id: VERSAO, organization_id: ORG, agent_id: AGENTE, channel_session_id: SESSAO, status: "published" },
    ],
  };
}

const evento = {
  id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  organization_id: ORG,
  entity_id: MSG,
  payload: { message_id: MSG, conversation_id: CONV },
} as unknown as EventRow;

async function rodar(c: Cenario) {
  const lidas: string[] = [];
  const rpcs: Linha[] = [];
  vi.mocked(createAdminClient).mockReturnValue(
    fazerAdmin(montarBanco(c), lidas, rpcs) as unknown as ReturnType<typeof createAdminClient>,
  );
  const resultado = await processSentiment(evento);
  return {
    resultado,
    lidas,
    alertas: rpcs.filter((r) => r["p_event_type"] === "ai.sentiment_alert"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolverModeloDoPonto).mockResolvedValue({
    model: "modelo-dublê",
    modelId: "anthropic/claude-haiku-4-5",
  } as unknown as Awaited<ReturnType<typeof resolverModeloDoPonto>>);
  vi.mocked(generateObject).mockResolvedValue({
    object: { sentiment_score: NOTA_IRRITADA, reasoning_short: "cliente irritado" },
    usage: { inputTokens: 10, outputTokens: 5 },
  } as unknown as Awaited<ReturnType<typeof generateObject>>);
});

describe("sentimento — só mede quando o alerta teria efeito", () => {
  it("conversa elegível continua medindo e disparando o alerta (controle positivo)", async () => {
    const r = await rodar({});
    expect(r.resultado).toMatchObject({ skipped: false, sentiment_score: NOTA_IRRITADA });
    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(r.alertas, "o cliente irritado deixou de chamar uma pessoa").toHaveLength(1);
  });

  it.each([
    ["uma pessoa no comando da conversa", { assignee_kind: "user" }, "conversa_de_humano"],
    ["conversa silenciada", { bot_silenced_until: "2999-01-01T00:00:00.000Z" }, "conversa_silenciada"],
    [
      "contato passado para uma pessoa",
      { contacts: { force_human: true, ai_authorized_at: null, phone_number: null } },
      "force_human",
    ],
  ])("%s: não chama o modelo, nem o resolvedor, nem lê os agentes", async (_caso, conversa, motivo) => {
    const r = await rodar({ conversa });

    expect(r.resultado).toEqual({ skipped: true, reason: `nao_elegivel_para_ia:${motivo}` });
    expect(generateObject, "pagou o modelo por um alerta que o handoff recusaria").not.toHaveBeenCalled();
    expect(resolverModeloDoPonto).not.toHaveBeenCalled();
    expect(r.lidas).not.toContain("ai_agents");
    expect(r.alertas).toHaveLength(0);
  });

  it("mensagem sem texto pula antes de resolver o modelo", async () => {
    const r = await rodar({ corpo: "   " });
    expect(r.resultado).toEqual({ skipped: true, reason: "empty_body" });
    expect(resolverModeloDoPonto, "três leituras e uma decifragem antes de uma guarda que não precisa delas").not.toHaveBeenCalled();
  });
});
