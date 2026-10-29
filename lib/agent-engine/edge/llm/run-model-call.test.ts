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

/**
 * O CUSTO GRAVADO em `llm_calls.cost_cents` pelo caminho da Anthropic: a divisão
 * da gravação de cache por TTL vem do `usage` CRU de cada passo
 * (`cache_creation.ephemeral_{5m,1h}_input_tokens`), e não do knob `cacheTtl`.
 */
function poolDaAnthropic(provider = "anthropic", model = "claude-sonnet-5") {
  const inserts: Array<{ params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("settings->'llm'")) {
      return {
        rows: [
          {
            llm: {
              provider,
              default_model: model,
              params: {},
              enabled_models: [],
              monthly_budget_cents: null,
            },
          },
        ],
      };
    }
    if (sql.includes("insert into llm_calls")) {
      inserts.push({ params });
      return { rows: [{ id: "call-2" }] };
    }
    return { rows: [] };
  });
  return { pool: { query } as never, inserts };
}

const registryDaAnthropic = {
  anthropic: () => ({
    specificationVersion: "v3",
    provider: "anthropic.messages",
    modelId: "claude-sonnet-5",
    doGenerate: async () => {
      throw new Error("SENTINELA: o dublê do generateText não foi usado");
    },
    doStream: async () => {
      throw new Error("SENTINELA: stream fora do dublê");
    },
  }),
} as never;

/** Dois passos do laço de ferramentas, cada um com a divisão que a Anthropic manda. */
function generateTextDuble(passos: Array<{ cincoMin: number; umaHora: number } | null>, gravado: number) {
  vi.mocked(generateText).mockResolvedValue({
    text: "Estamos abertos das 9h às 18h.",
    usage: {
      inputTokens: 1_000_000,
      outputTokens: 0,
      totalTokens: 1_000_000,
      inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: gravado },
    },
    response: { id: "resp-2", modelId: "claude-sonnet-5" },
    steps: passos.map((p) => ({
      usage: {
        raw: p
          ? { cache_creation: { ephemeral_5m_input_tokens: p.cincoMin, ephemeral_1h_input_tokens: p.umaHora } }
          : { input_tokens: 10 },
      },
    })),
    responseMessages: [],
    toolCalls: [],
    finishReason: "stop",
  } as never);
}

async function rodarPelaAnthropic(passos: Array<{ cincoMin: number; umaHora: number } | null>, gravado = 1_000_000) {
  generateTextDuble(passos, gravado);
  const { pool, inserts } = poolDaAnthropic();
  const resultado = await runModelCall(
    pool,
    { anthropicApiKey: "chave-ant-de-teste", cacheTtl: "1h" },
    { tenantId: ORG, purpose: "agent_preview", messages: [{ role: "user", content: "que horas abrem?" }] },
    { registry: registryDaAnthropic },
  );
  // `cost_cents` é o 12º valor do insert (ver a lista de colunas no seam).
  return { resultado, custoGravado: inserts[0]?.params[11] };
}

describe("o custo gravado lê a divisão da gravação de cache que a Anthropic informa", () => {
  it("⭐ 800 mil a 5 min e 200 mil a 1 h, em dois passos: cada parcela pela sua tarifa, com o knob em 1h", async () => {
    const { resultado, custoGravado } = await rodarPelaAnthropic([
      { cincoMin: 500_000, umaHora: 200_000 },
      { cincoMin: 300_000, umaHora: 0 },
    ]);
    expect(vi.mocked(generateText)).toHaveBeenCalled();
    // Gravação: 0,8 × US$ 2,50 + 0,2 × US$ 4,00 = US$ 2,80; a entrada inteira foi gravada.
    // Cobrando tudo a 1 h (o knob) seriam US$ 4,00.
    expect(resultado.costCents).toBeCloseTo(280, 6);
    expect(custoGravado).toBeCloseTo(280, 6);
  });

  it("sem a divisão em passo nenhum, vale o knob para a gravação inteira — o comportamento de antes", async () => {
    // Outro provedor, ou o campo sumiu: o milhão gravado vai todo a 1 h = US$ 4,00.
    const { resultado } = await rodarPelaAnthropic([null]);
    expect(resultado.costCents).toBeCloseTo(400, 6);
  });
});

describe("Terra grava custo real por passo do seam", () => {
  it("não confunde o total do tool loop com contexto longo e conserva cache cru", async () => {
    const passo = {inputTokens:200_000,outputTokens:0,inputTokenDetails:{cacheReadTokens:100_000,cacheWriteTokens:0},raw:{input_tokens_details:{cached_tokens:100_000,cache_write_tokens:100_000}}};
    vi.mocked(generateText).mockResolvedValue({text:"ok",usage:{inputTokens:400_000,outputTokens:0,inputTokenDetails:{cacheReadTokens:200_000,cacheWriteTokens:0}},steps:[{usage:passo},{usage:passo}],response:{id:"terra-test",modelId:"gpt-6.1-terra"},responseMessages:[],toolCalls:[],finishReason:"stop"} as never);
    const {pool,inserts}=poolDaAnthropic("openai","gpt-6.1-terra");
    const resultado = await runModelCall(pool,{openaiApiKey:"sk-de-teste",cacheTtl:"1h"},{tenantId:ORG,purpose:"agent_preview",messages:[{role:"user",content:"oi"}]},{registry:{openai:()=>({modelId:"gpt-6.1-terra",provider:"openai.responses",specificationVersion:"v3"})} as never});
    expect(resultado.costCents).toBeCloseTo(26);
    expect(inserts[0]?.params[11]).toBeCloseTo(26);
  });
});
