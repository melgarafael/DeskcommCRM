/**
 * UMA CONFERÊNCIA POR CORTE, NÃO DUAS — E PAUSAR CONTINUA CALANDO.
 *
 * Cada bolha do agente passa por `sendMessageHandler`, que confere a fronteira
 * de atendimento e a operação do agente em três pontos: na entrada, num corte
 * antes de escolher o transporte e no `beforeSend` do adapter, imediatamente
 * antes do POST ao canal. Dentro do escopo de execução de um job, os dois
 * cortes chamavam `guardServiceEffect()` (que relê as duas coisas pelo pg) e
 * em seguida reliam AS MESMAS pela REST: quatro idas ao banco por bolha para
 * repetir uma pergunta já respondida.
 *
 * A REST só é pulada quando o escopo carrega exatamente a mesma fronteira e a
 * mesma operação que o ctx — nunca por uma flag no ctx, que viraria atalho
 * para UI, MCP e automação. Este arquivo prende as duas metades:
 *
 *   - a economia: dentro do escopo, a REST é lida uma vez por bolha (entrada);
 *   - a segurança, que é a regressão cara: pausar o agente entre a 1ª e a 2ª
 *     bolha cala a 2ª; pausar ou trocar a fronteira entre o corte e o
 *     `beforeSend` ainda barra o POST; sem escopo, a REST confere nos 3 pontos.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import type { AgentOperationContext } from "@/lib/ai/agents/operation";
import { StaleServiceBoundaryError, type ServiceBoundary } from "@/lib/atendimento/fronteira";
import { setExecutionAgentOperation, withServiceJob } from "@/lib/atendimento/fronteira-server";
import type { JobRow, Queryable } from "@/lib/agent-engine/queue/queue";
import type { SendMessageInput } from "@/lib/schemas";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ storage: { from: () => ({ createSignedUrl: vi.fn() }) } }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const AGENT = "55555555-5555-4555-8555-555555555555";
const VERSION = "66666666-6666-4666-8666-666666666666";

const FRONTEIRA: ServiceBoundary = {
  organization_id: ORG,
  contact_id: CONTACT,
  conversation_id: CONV,
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
};
const OPERACAO: AgentOperationContext = {
  organizationId: ORG,
  agentId: AGENT,
  versionId: VERSION,
  revision: "3",
};

/**
 * O banco visto pelos dois lados — REST (dublê do handler) e pg (escopo do
 * job) — lê o MESMO estado, como na produção. `pausarNaLeitura` dispara a
 * pausa logo depois da N-ésima leitura do agente por aquele lado, que é como
 * se simula o dono clicando "Pausar" entre dois pontos do envio.
 */
function mundo() {
  const estado = { pausado: false, revisao: 1 };
  const gatilhos: {
    pausarNaLeituraPg?: number;
    trocarFronteiraNaLeituraPg?: number;
    pausarNaLeituraRest?: number;
  } = {};
  let leiturasPgAgente = 0;
  let leiturasRestAgente = 0;
  const agente = () => ({
    published_version_id: VERSION,
    operation_revision: "3",
    operation_mode: "automatic",
    paused_at: estado.pausado ? "2026-10-05T12:00:00Z" : null,
    archived_at: null,
  });
  const fronteira = () => ({
    ...FRONTEIRA,
    service_revision: estado.revisao,
    status: "open",
    demanda_fechada_em: null,
  });

  const db = {
    query: async (sql: string) => {
      if (sql.includes("from ai_agents")) {
        const linha = agente();
        leiturasPgAgente += 1;
        if (leiturasPgAgente === gatilhos.pausarNaLeituraPg) estado.pausado = true;
        if (leiturasPgAgente === gatilhos.trocarFronteiraNaLeituraPg) estado.revisao += 1;
        return { rows: [linha] };
      }
      if (sql.includes("from conversations c")) return { rows: [fronteira()] };
      throw new Error(`sql inesperado no escopo: ${sql.slice(0, 60)}`);
    },
  } as unknown as Queryable;

  const { supabase, capturas, mensagens } = criarDubleDoHandler({
    conversation: {
      id: CONV,
      organization_id: ORG,
      contact_id: CONTACT,
      channel_session_id: SESSION,
      is_group: false,
      group_chat_id: null,
      contacts: { phone_number: "+5531999998888", wa_identity: null, wa_lid: null, is_blocked: false },
      channel_sessions: { provider: "waha", waha_session_name: "default", status: "WORKING", archived_at: null, metadata: {} },
    },
    agente: () => {
      const linha = agente();
      leiturasRestAgente += 1;
      if (leiturasRestAgente === gatilhos.pausarNaLeituraRest) estado.pausado = true;
      return linha;
    },
    rpcData: () => fronteira(),
  });

  const restDaFronteira = () => capturas.rpcs.filter((r) => r.nome === "fn_service_boundary").length;
  const restDoAgente = () => capturas.selects.ai_agents!.length;
  return { estado, gatilhos, db, supabase, mensagens, restDaFronteira, restDoAgente };
}

const JOB = {
  id: "job-1",
  organization_id: ORG,
  contact_id: CONTACT,
  kind: "inbound_turn",
  payload: { service_boundary: FRONTEIRA },
} as unknown as JobRow;

function ctxDoAgente(serviceBoundary: ServiceBoundary | undefined, n: number): HandlerCtx {
  return {
    organization_id: ORG,
    actor: { type: "ai_agent", id: "agent-engine", role: "manager" },
    requestId: `req-${n}`,
    serviceBoundary,
    agentOperation: OPERACAO,
  };
}
const bolha = (n: number) => ({ conversation_id: CONV, type: "text", body: `bolha ${n}` }) as SendMessageInput;

let postsAoCanal = 0;
function canalNoAr() {
  postsAoCanal = 0;
  vi.stubEnv("WAHA_API_BASE_URL", "http://localhost:3030");
  vi.stubEnv("WAHA_API_KEY", "hash123");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      if (String(url).includes("/api/sendText")) postsAoCanal += 1;
      return new Response(JSON.stringify({ id: { id: `3EB0${postsAoCanal}` } }), { status: 200 });
    }),
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("envio do agente dentro do escopo do job", () => {
  it("lê a REST uma vez por bolha (na entrada), não três", async () => {
    canalNoAr();
    const m = mundo();
    await withServiceJob(m.db, JOB, async () => {
      setExecutionAgentOperation(OPERACAO);
      await sendMessageHandler(m.supabase, ctxDoAgente(FRONTEIRA, 1), bolha(1));
      await sendMessageHandler(m.supabase, ctxDoAgente(FRONTEIRA, 2), bolha(2));
    });
    expect(postsAoCanal).toBe(2);
    expect(m.restDaFronteira(), "fn_service_boundary relida pela REST nos cortes que o pg já conferiu").toBe(2);
    expect(m.restDoAgente(), "ai_agents relido pela REST nos cortes que o pg já conferiu").toBe(2);
  });

  it("⭐ pausar o agente entre a 1ª e a 2ª bolha cala a 2ª", async () => {
    canalNoAr();
    const m = mundo();
    await expect(
      withServiceJob(m.db, JOB, async () => {
        setExecutionAgentOperation(OPERACAO);
        await sendMessageHandler(m.supabase, ctxDoAgente(FRONTEIRA, 1), bolha(1));
        m.estado.pausado = true;
        await sendMessageHandler(m.supabase, ctxDoAgente(FRONTEIRA, 2), bolha(2));
      }),
    ).rejects.toBeInstanceOf(StaleServiceBoundaryError);
    expect(postsAoCanal, "a 2ª bolha saiu com o agente pausado").toBe(1);
    expect(m.mensagens.map((r) => r.body)).toEqual(["bolha 1"]);
  });

  it("pausar entre o corte e o beforeSend ainda barra o POST", async () => {
    canalNoAr();
    const m = mundo();
    // 1ª leitura pg do agente = corte antes do transporte; a 2ª é o beforeSend.
    m.gatilhos.pausarNaLeituraPg = 1;
    await expect(
      withServiceJob(m.db, JOB, async () => {
        setExecutionAgentOperation(OPERACAO);
        await sendMessageHandler(m.supabase, ctxDoAgente(FRONTEIRA, 1), bolha(1));
      }),
    ).rejects.toBeInstanceOf(StaleServiceBoundaryError);
    expect(postsAoCanal).toBe(0);
  });

  it("fronteira trocada entre o corte e o beforeSend ainda gera StaleServiceBoundaryError", async () => {
    canalNoAr();
    const m = mundo();
    m.gatilhos.trocarFronteiraNaLeituraPg = 1;
    await expect(
      withServiceJob(m.db, JOB, async () => {
        setExecutionAgentOperation(OPERACAO);
        // Sem fronteira no ctx: o handler herda a do escopo, como o agente faz.
        await sendMessageHandler(m.supabase, ctxDoAgente(undefined, 1), bolha(1));
      }),
    ).rejects.toBeInstanceOf(StaleServiceBoundaryError);
    expect(postsAoCanal).toBe(0);
  });

  it("escopo sem a operação do agente: a REST do agente continua nos 3 pontos", async () => {
    canalNoAr();
    const m = mundo();
    await withServiceJob(m.db, JOB, async () => {
      await sendMessageHandler(m.supabase, ctxDoAgente(FRONTEIRA, 1), bolha(1));
    });
    expect(m.restDoAgente()).toBe(3);
    expect(m.restDaFronteira()).toBe(1);
  });
});

describe("envio sem escopo de execução (UI, MCP, automação)", () => {
  it("confere pela REST na entrada, no corte e no beforeSend", async () => {
    canalNoAr();
    const m = mundo();
    await sendMessageHandler(m.supabase, ctxDoAgente(FRONTEIRA, 1), bolha(1));
    expect(postsAoCanal).toBe(1);
    expect(m.restDaFronteira()).toBe(3);
    expect(m.restDoAgente()).toBe(3);
  });

  it("pausar entre o corte e o beforeSend barra o POST pela REST", async () => {
    canalNoAr();
    const m = mundo();
    // REST: 1ª leitura = entrada, 2ª = corte, 3ª = beforeSend.
    m.gatilhos.pausarNaLeituraRest = 2;
    await expect(sendMessageHandler(m.supabase, ctxDoAgente(FRONTEIRA, 1), bolha(1))).rejects.toBeInstanceOf(
      StaleServiceBoundaryError,
    );
    expect(postsAoCanal).toBe(0);
  });
});
