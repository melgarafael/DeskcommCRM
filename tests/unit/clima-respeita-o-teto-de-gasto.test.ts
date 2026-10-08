/**
 * O CLIMA DA CONVERSA RESPEITA O TETO DE GASTO DE IA.
 *
 * ## O defeito medido
 *
 * `workers/ai-sentiment-worker.ts` chama um LLM a cada mensagem recebida e não
 * passava por nenhum dos dois lugares onde o teto vinculava (o seam do engine e
 * o guard do caminho legado). Com a organização em "parar a IA" e o teto
 * estourado, o turno ia para a fila humana e o classificador seguia cobrando.
 *
 * ## O que se prova, pelo worker REAL
 *
 * Banco de brinquedo, SDK dublê (`generateObject`), e o snapshot do orçamento
 * (`getBudgetStatus`) controlado por caso — a decisão é a função pura de
 * verdade, via `podeGastarComIa`. O controle positivo é o caso que pula; os
 * outros provam que "só avisar", "desligado" e "parar, mas ainda sem aviso no
 * mês" CONTINUAM medindo — o erro caro aqui seria calar o clima, que é quem
 * chama uma pessoa quando o cliente se irrita.
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
vi.mock("@/lib/ai/budget/check", () => ({ getBudgetStatus: vi.fn() }));
vi.mock("ai", () => ({ generateObject: vi.fn() }));

import { generateObject } from "ai";

import { getBudgetStatus, type BudgetStatus } from "@/lib/ai/budget/check";
import { resolverModeloDoPonto } from "@/lib/ai/gateway-binding";
import { logInvocation } from "@/lib/ai/log-invocation";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";
import { processSentiment } from "@/workers/ai-sentiment-worker";

const ORG = "11111111-1111-4111-8111-111111111111";
const MSG = "22222222-2222-4222-8222-222222222222";
const CONV = "33333333-3333-4333-8333-333333333333";
const SESSAO = "44444444-4444-4444-8444-444444444444";
const AGENTE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ONTEM = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

type Linha = Record<string, unknown>;

/**
 * Mini-Postgres: `eq`/`is` filtram, `select(..., { count })` conta. A contagem
 * é o que o guard lê para saber se já houve aviso de orçamento no mês.
 */
function fazerAdmin(banco: Record<string, Linha[]>, rpcs: Linha[]) {
  const from = (tabela: string) => {
    const filtros: Array<[string, string, unknown]> = [];
    let conta = false;
    const resolver = () => {
      let linhas = [...(banco[tabela] ?? [])];
      for (const [op, col, val] of filtros) {
        if (op === "eq") linhas = linhas.filter((l) => l[col] === val);
        if (op === "is") linhas = linhas.filter((l) => (l[col] ?? null) === val);
      }
      return linhas;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = new Proxy(
      {},
      {
        get: (_a, prop: string) => {
          if (prop === "maybeSingle" || prop === "single") {
            return () => Promise.resolve({ data: resolver()[0] ?? null, error: null });
          }
          if (prop === "then") {
            return (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) =>
              Promise.resolve(
                conta
                  ? { data: null, count: resolver().length, error: null }
                  : { data: resolver(), error: null },
              ).then(ok, falha);
          }
          return (...args: unknown[]) => {
            if (prop === "eq" || prop === "is") filtros.push([prop, args[0] as string, args[1]]);
            if (prop === "select" && (args[1] as { count?: string } | undefined)?.count) conta = true;
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

function banco(o: { modo: string | null; avisosNoMes: number }): Record<string, Linha[]> {
  return {
    messages: [
      {
        id: MSG,
        organization_id: ORG,
        conversation_id: CONV,
        body: "estou esperando há uma semana e ninguém me responde",
        direction: "inbound",
        metadata: {},
      },
    ],
    // `organizations` é o embed que o portão de elegibilidade lê: sem status a
    // empresa não opera, e o worker pula antes de chegar ao teto (02a4a7832).
    conversations: [
      {
        id: CONV,
        organization_id: ORG,
        channel_session_id: SESSAO,
        active_ai_agent_id: null,
        organizations: { status: "active" },
      },
    ],
    ai_agents: [
      {
        id: AGENTE,
        organization_id: ORG,
        config: { sentiment_threshold: 0.3 },
        kind: "mcp_agent",
        is_active: true,
        is_default: true,
        priority: 0,
        created_at: "2026-01-01T00:00:00.000Z",
        published_version_id: "v1",
        archived_at: null,
        paused_at: null,
      },
    ],
    ai_agent_versions: [
      { id: "v1", organization_id: ORG, agent_id: AGENTE, channel_session_id: SESSAO, status: "published" },
    ],
    ai_budgets: o.modo === null ? [] : [{ organization_id: ORG, enforcement_mode: o.modo }],
    agent_inbox_items: Array.from({ length: o.avisosNoMes }, (_, i) => ({
      id: `aviso-${i}`,
      organization_id: ORG,
      kind: "budget_warning",
    })),
  };
}

function snapshot(modo: "avisar" | "bloquear"): BudgetStatus {
  return {
    organization_id: ORG,
    monthly_limit_cents: 1000,
    current_month_consumed_cents: 1500,
    pct: 150,
    alarm_threshold_pct: 80,
    enforcement_mode: modo,
    enforcement_effective_at: ONTEM,
    enforcement_env: "on",
    blocked_now: false,
    gasto_incompleto: false,
    current_period_start: "2026-10-01",
    last_alarm_sent_at: null,
    updated_at: new Date().toISOString(),
  };
}

const evento = {
  id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  organization_id: ORG,
  entity_id: MSG,
  payload: { message_id: MSG, conversation_id: CONV },
} as unknown as EventRow;

async function rodar(o: { modo: "avisar" | "bloquear" | "off" | null; avisosNoMes: number }) {
  const rpcs: Linha[] = [];
  vi.mocked(createAdminClient).mockReturnValue(
    fazerAdmin(banco(o), rpcs) as unknown as ReturnType<typeof createAdminClient>,
  );
  if (o.modo === "avisar" || o.modo === "bloquear") {
    vi.mocked(getBudgetStatus).mockResolvedValue(snapshot(o.modo));
  }
  const resultado = await processSentiment(evento);
  return { resultado, rpcs };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolverModeloDoPonto).mockResolvedValue({
    model: "modelo-dublê",
    modelId: "anthropic/claude-haiku-4-5",
  } as unknown as Awaited<ReturnType<typeof resolverModeloDoPonto>>);
  vi.mocked(generateObject).mockResolvedValue({
    object: { sentiment_score: 0.1, reasoning_short: "cliente irritado com a demora" },
    usage: { inputTokens: 10, outputTokens: 5 },
  } as unknown as Awaited<ReturnType<typeof generateObject>>);
});

describe("clima da conversa × teto de gasto de IA", () => {
  it("'parar a IA' + teto estourado + já avisado: NÃO chama o LLM e registra o motivo", async () => {
    const { resultado, rpcs } = await rodar({ modo: "bloquear", avisosNoMes: 1 });

    expect(resultado).toEqual({ skipped: true, reason: "orcamento_de_ia_estourado" });
    expect(generateObject, "o classificador foi cobrado com o teto estourado").not.toHaveBeenCalled();
    // Não houve chamada, então não há linha de custo — e nem alerta.
    expect(logInvocation).not.toHaveBeenCalled();
    expect(rpcs.filter((r) => r["p_event_type"] === "ai.sentiment_alert")).toHaveLength(0);
  });

  it("'só avisar' com o teto estourado CONTINUA medindo", async () => {
    const { resultado, rpcs } = await rodar({ modo: "avisar", avisosNoMes: 1 });

    expect(resultado.skipped).toBe(false);
    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(logInvocation).toHaveBeenCalled();
    expect(rpcs.filter((r) => r["p_event_type"] === "ai.sentiment_alert")).toHaveLength(1);
  });

  it("'parar a IA' sem aviso no mês ainda mede — ninguém é parado sem ter sido avisado", async () => {
    const { resultado } = await rodar({ modo: "bloquear", avisosNoMes: 0 });

    expect(resultado.skipped).toBe(false);
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  it("organização sem orçamento configurado mede, sem ler o snapshot completo", async () => {
    const { resultado } = await rodar({ modo: null, avisosNoMes: 0 });

    expect(resultado.skipped).toBe(false);
    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(getBudgetStatus).not.toHaveBeenCalled();
  });

  it("modo desligado mede, sem ler o snapshot completo", async () => {
    const { resultado } = await rodar({ modo: "off", avisosNoMes: 5 });

    expect(resultado.skipped).toBe(false);
    expect(getBudgetStatus).not.toHaveBeenCalled();
  });
});
