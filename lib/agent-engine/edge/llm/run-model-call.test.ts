/**
 * O RAMO DA ASSINATURA ENTREGA A FITA DO TURNO — `responseMessages` no retorno.
 *
 * ## O defeito medido (#2657, 1.78.0)
 *
 * Na assinatura (`openai-assinatura`) o seam não usa `generateText`: o SIWC exige
 * Responses API em streaming com `store:false`, então `chamarCom` chama
 * `streamText` e MONTA À MÃO um objeto "com cara de `generateText`". Faltava o
 * campo `responseMessages` — e é ele que o motor lê:
 *
 *   `inbound-turn.ts`: `let mensagensDoTurno = turn.result.responseMessages;`
 *   → `toolPartsAsText(mensagensDoTurno)` → `for (const m of messages)` com
 *   `undefined` → `TypeError: e is not iterable`.
 *
 * Sintoma real: o modelo RESPONDE (4 chamadas `ok` em `llm_calls`, a última
 * `purpose=agent_preview`) e 100 ms depois o turno morre — o agente da
 * assinatura não completa UM turno em nenhuma instalação, prévia ou WhatsApp.
 * Qualquer outro provedor passa pelo `generateText` de verdade e traz o campo.
 *
 * ## O que este arquivo prova
 *
 * Pelo SEAM inteiro (pool fingido + `streamText` dublê), não por leitura de
 * fonte: o objeto que sai de `runModelCall` com a config da assinatura carrega
 * a MESMA fita que o stream devolveu — e essa fita atravessa a chamada de
 * fechamento (`toolPartsAsText`), que é o ponto exato onde o turno quebrava.
 */
import { describe, expect, it, vi } from "vitest";

import { generateText, streamText, type ModelMessage } from "ai";

import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";
import { toolPartsAsText } from "@/lib/agent-engine/agent/prune-tool-results";
import { lerLoginCodexRenovandoSeProxima } from "@/lib/ai/credenciais/login-codex";
import { createAdminClient } from "@/lib/supabase/admin";

// O SDK nunca é alcançado de verdade: o ramo da assinatura consome o stream e o
// dublê devolve as cinco promessas que `Promise.all` espera.
vi.mock("ai", () => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
  stepCountIs: () => () => false,
  asSchema: vi.fn(),
  tool: (t: unknown) => t,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/ai/credenciais/login-codex", () => ({
  lerLoginCodexRenovandoSeProxima: vi.fn(async () => ({
    access_token: "token-de-assinatura-de-teste",
    refresh_token: "refresh-de-teste",
    expires_at: Date.now() + 60_000,
  })),
}));

const ORG = "33333333-3333-4333-8333-333333333333";

/** A fita de um turno COM ferramenta — é ela que o fechamento re-serializa. */
const FITA_DO_STREAM: ModelMessage[] = [
  {
    role: "assistant",
    content: [
      { type: "text", text: "Vou consultar o horário." },
      { type: "tool-call", toolCallId: "call-1", toolName: "consultar_horario", input: { data: "2026-10-09" } },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "consultar_horario",
        output: { type: "text", value: "aberto das 9h às 18h" },
      },
    ],
  },
  { role: "assistant", content: [{ type: "text", text: "Estamos abertos das 9h às 18h." }] },
];

/**
 * `pg.Pool` fingido que responde às consultas do caminho — mesmo molde de
 * `tests/unit/seam-respeita-o-binding.test.ts`: distinguir por trecho do SQL é
 * frágil de propósito, para quebrar alto se o seam trocar a consulta.
 */
function poolDaAssinatura() {
  const inserts: Array<{ params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("settings->'llm'")) {
      return {
        rows: [
          {
            llm: {
              provider: "openai-assinatura",
              default_model: "gpt-5.6-luna",
              params: {},
              enabled_models: [],
              monthly_budget_cents: null,
            },
          },
        ],
      };
    }
    if (sql.includes("from ai_purpose_bindings")) return { rows: [] };
    if (sql.includes("from ai_provider_credentials")) return { rows: [] };
    if (sql.includes("insert into llm_calls")) {
      inserts.push({ params });
      return { rows: [{ id: "call-1" }] };
    }
    return { rows: [] };
  });
  return { pool: { query } as never, inserts };
}

/** Fábrica da assinatura: o modelo instanciado nunca fala — o dublê do stream sim. */
const registry = {
  "openai-assinatura": () => ({
    specificationVersion: "v3",
    provider: "openai-assinatura",
    modelId: "gpt-5.6-luna",
    doGenerate: async () => {
      throw new Error("SENTINELA: o ramo da assinatura usou generateText");
    },
    doStream: async () => {
      throw new Error("SENTINELA: o stream foi consumido fora do dublê");
    },
  }),
} as never;

function streamDuble() {
  vi.mocked(streamText).mockReturnValue({
    text: Promise.resolve("Estamos abertos das 9h às 18h."),
    usage: Promise.resolve({
      inputTokens: 42,
      outputTokens: 7,
      totalTokens: 49,
      inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
    }),
    response: Promise.resolve({ id: "resp-1", modelId: "gpt-5.6-luna" }),
    steps: Promise.resolve([]),
    responseMessages: Promise.resolve(FITA_DO_STREAM),
    toolCalls: Promise.resolve([
      { type: "tool-call", toolCallId: "call-9", toolName: "propor_mudancas", input: { campo: "valor" } },
    ]),
  } as never);
}

async function rodarPelaAssinatura() {
  streamDuble();
  const { pool, inserts } = poolDaAssinatura();
  const resultado = await runModelCall(
    pool,
    { anthropicApiKey: "chave-ant-de-teste", openaiApiKey: "chave-openai-de-teste", cacheTtl: "1h" },
    { tenantId: ORG, purpose: "agent_preview", messages: [{ role: "user", content: "que horas abrem?" }] },
    { registry },
  );
  return { resultado, inserts };
}

describe("o ramo da assinatura (#2657): o modelo responde E o turno fecha", () => {
  it("⭐ devolve responseMessages — a fita que o motor reenvia no fechamento", async () => {
    const { resultado, inserts } = await rodarPelaAssinatura();

    // A identidade do caminho: este caso só prova alguma coisa se o stream for
    // o que respondeu (sem ele a reserva `openai` assumiria e o campo existiria
    // por acaso).
    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
    // A credencial veio do LOGIN por assinatura — sem ele o resolvedor cai na
    // reserva `openai` e o campo existiria por acaso, pelo generateText de lá.
    expect(vi.mocked(lerLoginCodexRenovandoSeProxima)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createAdminClient)).toHaveBeenCalledTimes(1);
    expect(inserts, "a chamada nem gravou llm_calls — não foi pela assinatura").toHaveLength(1);

    // O defeito: `undefined` aqui é o `e is not iterable` de 100 ms depois da
    // resposta, e é por isso que o turno nunca fechava.
    expect(resultado.result.responseMessages).toBeDefined();
    expect(resultado.result.responseMessages).toEqual(FITA_DO_STREAM);
  });

  it("a fita atravessa a chamada de fechamento sem 'e is not iterable'", async () => {
    const { resultado } = await rodarPelaAssinatura();

    // O ponto exato do crash: `inbound-turn` faz
    // `toolPartsAsText(turn.result.responseMessages)`. Sem o campo, esta linha
    // morre com `TypeError: undefined is not iterable`.
    const fechamento = toolPartsAsText(resultado.result.responseMessages);
    expect(fechamento.map((m) => m.role)).toEqual(["assistant", "assistant"]);
    expect(JSON.stringify(fechamento)).toContain("consultar_horario");
    expect(JSON.stringify(fechamento)).toContain("aberto das 9h às 18h");
  });

  it("texto e usage do stream chegam inteiros — acrescentar o campo não cobrou o resto", async () => {
    const { resultado } = await rodarPelaAssinatura();
    expect(resultado.result.text).toBe("Estamos abertos das 9h às 18h.");
    expect(resultado.usage).toMatchObject({ inputTokens: 42, outputTokens: 7 });
    expect(resultado.provider).toBe("openai-assinatura");
  });

  it("devolve toolCalls — quem pede UMA ferramenta (propostas, valor da conversa) lê o campo do topo", async () => {
    // Sem o campo, `result.toolCalls?.find(...)` devolve null calado: a IA
    // "não sugeriu nada" na assinatura, embora o modelo tenha chamado a ferramenta.
    const { resultado } = await rodarPelaAssinatura();
    const chamada = resultado.result.toolCalls?.find((c) => c.toolName === "propor_mudancas");
    expect(chamada?.input).toEqual({ campo: "valor" });
  });
});
