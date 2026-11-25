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
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { generateText, streamText, type ModelMessage } from "ai";

import { costCents } from "@/lib/agent-engine/edge/llm/pricing";
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
  // #3371, fatia 4: o seam passou a renovar no 401 — o dublê do módulo tem de
  // cobrir o símbolo novo, senão o import das duas funções quebra o teste.
  renovarAssinaturaNoTurno: vi.fn(),
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
function poolDaAnthropic(provider = "anthropic", model = "claude-sonnet-5", baseUrlDoPonto?: string) {
  const inserts: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    // O endereço próprio do ponto, como o painel de provedores grava.
    if (baseUrlDoPonto !== undefined && sql.includes("from ai_purpose_bindings")) {
      return {
        rows: [{ purpose: "agent_turn", provider, credential_id: null, model_id: model, base_url: baseUrlDoPonto, is_enabled: true }],
      };
    }
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
      inserts.push({ sql, params });
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
  return { resultado, custoGravado: inserts[0]?.params[11], inserts };
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

  /**
   * O defeito da #5020: o seam JÁ separa 1 h de 5 min para cobrar, mas só gravava o
   * total — a auditoria do `cost_cents` pelo banco não conseguia provar a parcela de
   * 1 h. O teste é o da issue: 3.000 a 1 h + 500 a 5 min.
   */
  it("⭐ 3000 a 1 h e 500 a 5 min: grava 3500 no total E 3000 na coluna nova, e a recontagem bate", async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: "ok",
      usage: {
        inputTokens: 3_500,
        outputTokens: 0,
        inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 3_500 },
      },
      response: { id: "cache-1h-test", modelId: "claude-sonnet-5-5" },
      steps: [
        {
          usage: {
            raw: {
              cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 3_000 },
            },
          },
        },
      ],
      responseMessages: [],
      toolCalls: [],
      finishReason: "stop",
    } as never);
    const { pool, inserts } = poolDaAnthropic("anthropic", "claude-sonnet-5-5");
    const resultado = await runModelCall(
      pool,
      { anthropicApiKey: "chave-ant-de-teste", cacheTtl: "1h" },
      { tenantId: ORG, purpose: "agent_preview", messages: [{ role: "user", content: "oi" }] },
      { registry: registryDaAnthropic },
    );

    expect(inserts).toHaveLength(1);
    const { sql, params } = inserts[0]!;
    // A coluna entra no MESMO insert do total; sem ela o banco não guarda a
    // parcela de 1 h e a auditoria continua sem prova (issue #5020).
    expect(sql).toContain("cache_write_1h_tokens");
    // params: input_tokens=7, output=8, cache_read=9, cache_write=10, cost=11;
    // a coluna nova entra antes de `preview_run_id`, que segue a última.
    expect(params[10]).toBe(3_500);
    expect(params[11]).toBeCloseTo(1.325, 9); // 3000×4,00 + 500×2,50, por milhão, em centavos.
    expect(params[22]).toBe(3_000);

    // A mesma fórmula de duas tarifas, com os dois números que o banco agora guarda.
    const recontagem = costCents("claude-sonnet-5-5", {
      inputTokens: 3_500,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 3_500,
      cacheWrite1hTokens: 3_000,
    });
    expect(recontagem).toBeCloseTo(1.325, 9);
    expect(resultado.costCents).toBeCloseTo(recontagem!, 9);
  });

  it("sem a divisão, a coluna nova fica NULA — não medido não é 0", async () => {
    const { inserts } = await rodarPelaAnthropic([null], 1_000);
    expect(inserts[0]!.params[22]).toBeNull();
  });

  it("com a divisão explícita em zero, a coluna nova é 0 — aí foi medido", async () => {
    const { inserts } = await rodarPelaAnthropic([{ cincoMin: 0, umaHora: 0 }], 0);
    expect(inserts[0]!.params[22]).toBe(0);
  });

  it("só o campo de 5 min: a parcela de 1 h é 0, e é 0 que vai para a coluna", async () => {
    // `gravacaoDeUmaHora` trata campo ausente como 0 quando ALGUM passo trouxe
    // `cache_creation`; o custo usa esse mesmo 0, então a coluna grava 0 (não
    // nulo). Nulo fica só para quando nenhum passo trouxe a divisão.
    vi.mocked(generateText).mockResolvedValue({
      text: "ok",
      usage: {
        inputTokens: 500,
        outputTokens: 0,
        inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 500 },
      },
      response: { id: "cache-so-5m", modelId: "claude-sonnet-5-5" },
      steps: [{ usage: { raw: { cache_creation: { ephemeral_5m_input_tokens: 500 } } } }],
      responseMessages: [],
      toolCalls: [],
      finishReason: "stop",
    } as never);
    const { pool, inserts } = poolDaAnthropic("anthropic", "claude-sonnet-5-5");
    await runModelCall(
      pool,
      { anthropicApiKey: "chave-ant-de-teste", cacheTtl: "1h" },
      { tenantId: ORG, purpose: "agent_preview", messages: [{ role: "user", content: "oi" }] },
      { registry: registryDaAnthropic },
    );
    expect(inserts[0]!.params[22]).toBe(0);
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

/**
 * O degrau do Haiku 5.5 (#5017): acima de 100 mil tokens de entrada NUMA
 * requisição (contando leitura e escrita de cache), a Anthropic cobra 5× aquela
 * requisição. Cada passo do laço de ferramentas é uma requisição: o fator vale
 * por passo, nunca pela soma do turno.
 */
describe("o degrau do Haiku 5.5 é cobrado por passo do seam", () => {
  type Passo = { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  async function custoDoTurno(model: string, passos: Passo[]) {
    const soma = (k: keyof Passo) => passos.reduce((t, p) => t + (p[k] ?? 0), 0);
    vi.mocked(generateText).mockResolvedValue({
      text: "ok",
      usage: {
        inputTokens: soma("inputTokens"),
        outputTokens: soma("outputTokens"),
        inputTokenDetails: { cacheReadTokens: soma("cacheReadTokens"), cacheWriteTokens: soma("cacheWriteTokens") },
      },
      steps: passos.map((p) => ({
        usage: {
          inputTokens: p.inputTokens,
          outputTokens: p.outputTokens,
          inputTokenDetails: { cacheReadTokens: p.cacheReadTokens ?? 0, cacheWriteTokens: p.cacheWriteTokens ?? 0 },
        },
      })),
      response: { id: "degrau-test", modelId: model },
      responseMessages: [],
      toolCalls: [],
      finishReason: "stop",
    } as never);
    const { pool, inserts } = poolDaAnthropic("anthropic", model);
    const resultado = await runModelCall(
      pool,
      { anthropicApiKey: "chave-ant-de-teste", cacheTtl: "1h" },
      { tenantId: ORG, purpose: "agent_preview", messages: [{ role: "user", content: "oi" }] },
      { registry: registryDaAnthropic },
    );
    expect(inserts[0]?.params[11]).toBeCloseTo(resultado.costCents ?? NaN, 9);
    return resultado.costCents;
  }

  // 120 mil de entrada, dos quais só 20 mil sem cache: o degrau conta leitura e escrita.
  const passoLongo: Passo = { inputTokens: 120_000, outputTokens: 1_000, cacheReadTokens: 60_000, cacheWriteTokens: 40_000 };
  const passoCurto: Passo = { inputTokens: 30_000, outputTokens: 1_000 };

  it("⭐ passos de 120 mil e 30 mil: 5× só no primeiro", async () => {
    const longo = costCents("claude-haiku-5-5", { ...passoLongo, cacheReadTokens: 60_000, cacheWriteTokens: 40_000 })!;
    const curto = costCents("claude-haiku-5-5", { ...passoCurto, cacheReadTokens: 0, cacheWriteTokens: 0 })!;
    // 1× do passo longo: 20k×0,1 + 60k×0,01 + 40k×0,2 + 1k×0,5 = US$ 0,0111.
    expect(longo).toBeCloseTo(1.11, 9);
    expect(curto).toBeCloseTo(0.35, 9);
    expect(await custoDoTurno("claude-haiku-5-5", [passoLongo, passoCurto])).toBeCloseTo(5 * 1.11 + 0.35, 9);
  });

  it("três passos de 40 mil (120 mil no turno): 1× nos três", async () => {
    const passo: Passo = { inputTokens: 40_000, outputTokens: 0 };
    expect(await custoDoTurno("claude-haiku-5-5", [passo, passo, passo])).toBeCloseTo(3 * 0.4, 9);
  });

  it("o mesmo turno no Sonnet 5.5 não muda", async () => {
    // 20k×2 + 60k×0,1 + 40k×4 + 1k×10 = US$ 0,216; 30k×2 + 1k×10 = US$ 0,07.
    expect(await custoDoTurno("claude-sonnet-5-5", [passoLongo, passoCurto])).toBeCloseTo(21.6 + 7, 9);
  });
});


it("grava o custo do Luna com um passo longo e um passo curto", async () => {
  const modelo = "gpt-6-luna";
  vi.mocked(generateText).mockResolvedValue({
    text: "ok",
    usage: {
      inputTokens: 450_000,
      outputTokens: 200_000,
      inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    steps: [
      { usage: { inputTokens: 300_000, outputTokens: 100_000 } },
      { usage: { inputTokens: 150_000, outputTokens: 100_000 } },
    ],
    response: { id: "luna-test", modelId: modelo },
    responseMessages: [],
    toolCalls: [],
    finishReason: "stop",
  } as never);
  const { pool, inserts } = poolDaAnthropic("openai", modelo);
  const resultado = await runModelCall(
    pool,
    { openaiApiKey: "sk-de-teste" },
    { tenantId: ORG, purpose: "agent_preview", messages: [{ role: "user", content: "oi" }] },
    {
      registry: {
        openai: () => ({ modelId: modelo, provider: "openai.responses", specificationVersion: "v3" }),
      } as never,
    },
  );
  // 13,5 centavos no passo longo e 6,5 no curto.
  expect(resultado.costCents).toBeCloseTo(20);
  expect(inserts[0]?.params[11]).toBeCloseTo(20);
});

/**
 * CLAUDE PELA OPENROUTER, PELO SEAM INTEIRO.
 *
 * O seam decide o cache (4º argumento da fábrica) e o corpo da resposta (o
 * `include` do generateText) com a MESMA origem de endereço, e grava em
 * `cost_cents` o que a OpenRouter cobrou (`usage.cost` de cada passo).
 */
const AGENTE = "44444444-4444-4444-8444-444444444444";

function registryQueAnota() {
  const fabrica = vi.fn((...args: unknown[]) => ({
    specificationVersion: "v3",
    provider: "openai.chat",
    modelId: String(args[1]),
    doGenerate: async () => {
      throw new Error("SENTINELA: o dublê do generateText não foi usado");
    },
    doStream: async () => {
      throw new Error("SENTINELA: stream fora do dublê");
    },
  }));
  return { fabrica, registry: { openrouter: fabrica, openai: fabrica } as never };
}

/** Passos com o corpo cru que a OpenRouter devolve; `null` = passo sem `usage.cost`. */
function generateTextDaOpenRouter(custos: Array<number | null>, corpoEmTexto = false) {
  const corpo = (cost: number | null) => {
    const json = {
      provider: "Anthropic",
      usage: cost === null ? { prompt_tokens: 10 } : { prompt_tokens: 10, cost, is_byok: false },
    };
    return corpoEmTexto ? JSON.stringify(json) : json;
  };
  vi.mocked(generateText).mockResolvedValue({
    text: "ok",
    usage: {
      inputTokens: 1_000_000,
      outputTokens: 0,
      totalTokens: 1_000_000,
      inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    response: { id: "resp-or", modelId: "anthropic/claude-sonnet-5", body: corpo(custos.at(-1) ?? null) },
    steps: custos.map((c) => ({ usage: {}, response: { body: corpo(c) } })),
    responseMessages: [],
    toolCalls: [],
    finishReason: "stop",
  } as never);
}

async function rodarPelaOpenRouter(opts: {
  provider?: string;
  model?: string;
  purpose?: string;
  maxSteps?: number;
  custos?: Array<number | null>;
  baseUrlDoPonto?: string;
  corpoEmTexto?: boolean;
} = {}) {
  generateTextDaOpenRouter(opts.custos ?? [0.0123, 0.0007], opts.corpoEmTexto);
  const { pool, inserts } = poolDaAnthropic(
    opts.provider ?? "openrouter",
    opts.model ?? "anthropic/claude-sonnet-5",
    opts.baseUrlDoPonto,
  );
  const { fabrica, registry } = registryQueAnota();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const resultado = await runModelCall(
    pool,
    { openrouterApiKey: "sk-or-teste", openaiApiKey: "sk-teste", cacheTtl: "1h" },
    {
      tenantId: ORG,
      agentId: AGENTE,
      purpose: (opts.purpose ?? "agent_turn") as never,
      messages: [{ role: "user", content: "oi" }],
      ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
    },
    // Antes do prazo da recusa de endereço próprio com a chave da instalação:
    // o caso aqui é o custo, não essa recusa.
    { registry, log: log as never, agora: new Date("2026-10-01T00:00:00Z") },
  );
  const chamada = vi.mocked(generateText).mock.lastCall?.[0] as Record<string, unknown> | undefined;
  return { resultado, inserts, fabrica, chamada, log };
}

describe("o seam e a OpenRouter oficial (T7)", () => {
  it("⭐ a fábrica recebe o cache da chamada, e o generateText pede o corpo da resposta", async () => {
    const { fabrica, chamada } = await rodarPelaOpenRouter({ maxSteps: 5 });
    const args = fabrica.mock.lastCall ?? [];
    expect(args.slice(0, 3)).toEqual(["sk-or-teste", "anthropic/claude-sonnet-5", undefined]);
    expect(args[3]).toEqual({ ttl: "1h", cauda: true, sessao: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(chamada?.include).toEqual({ responseBody: true });
    // Nenhuma opção do SDK escreve campo no corpo (o `prompt_cache_key` iria até para gateway).
    expect((chamada?.providerOptions as Record<string, unknown> | undefined)?.openai).toBeUndefined();
  });

  it("sem laço, a cauda não vai; a sessão é um hash estável que muda com o propósito", async () => {
    const a = (await rodarPelaOpenRouter()).fabrica.mock.lastCall?.[3] as { cauda: boolean; sessao: string };
    const b = (await rodarPelaOpenRouter()).fabrica.mock.lastCall?.[3] as { sessao: string };
    const c = (await rodarPelaOpenRouter({ purpose: "agent_preview" })).fabrica.mock.lastCall?.[3] as { sessao: string };
    expect(a.cauda).toBe(false);
    expect(a.sessao).toBe(b.sessao);
    expect(c.sessao).not.toBe(a.sessao);
    expect(a.sessao).not.toContain(ORG.replace(/-/g, "").slice(0, 8));
  });

  it("a OpenAI direta não pede o corpo da resposta", async () => {
    const { chamada } = await rodarPelaOpenRouter({ provider: "openai", model: "gpt-6.1-terra" });
    expect(chamada).toBeDefined();
    expect(chamada?.include).toBeUndefined();
  });

  it("as duas decisões leem o MESMO endereço da chamada (o código-fonte)", () => {
    const fonte = readFileSync("lib/agent-engine/edge/llm/run-model-call.ts", "utf8");
    expect(fonte).toContain("fabrica(cfgUsada.apiKey, model, baseUrlDaChamada,");
    expect(fonte).toContain("corpoDaOpenRouterNoResultado(cfgUsada.provider, baseUrlDaChamada)");
  });
});

describe("o custo gravado na OpenRouter é o que ela cobrou (T8)", () => {
  it("⭐ soma o usage.cost dos passos, em centavos, e o log diz de onde veio", async () => {
    const { resultado, inserts, log } = await rodarPelaOpenRouter({ maxSteps: 5 });
    expect(resultado.costCents).toBeCloseTo(1.3, 6);
    expect(inserts[0]?.params[11]).toBeCloseTo(1.3, 6);
    const concluida = log.info.mock.calls.find(([msg]) => msg === "llm: chamada concluída")?.[1];
    expect(concluida).toMatchObject({ custo_origem: "informado_pelo_provedor", provedor_de_origem: "Anthropic" });
  });

  it("corpo em texto JSON: o custo e o provedor de origem são lidos do mesmo jeito", async () => {
    const { resultado, log } = await rodarPelaOpenRouter({ maxSteps: 5, corpoEmTexto: true });
    expect(resultado.costCents).toBeCloseTo(1.3, 6);
    const concluida = log.info.mock.calls.find(([msg]) => msg === "llm: chamada concluída")?.[1];
    expect(concluida).toMatchObject({ custo_origem: "informado_pelo_provedor", provedor_de_origem: "Anthropic" });
  });

  it("gateway do operador cadastrado como openrouter não informa o próprio custo: vale a tabela", async () => {
    // Um gateway que devolvesse `usage.cost` 0 (ou negativo) furaria o teto
    // mensal e a cota do plano. O corpo chega até aqui de propósito: quem barra
    // é o critério do endereço, não a ausência do corpo.
    const gateway = "https://meu-gateway.exemplo/v1";
    const { resultado, inserts, fabrica, chamada, log } = await rodarPelaOpenRouter({ baseUrlDoPonto: gateway, custos: [0, 0] });
    expect(fabrica.mock.lastCall?.[2], "controle: a chamada foi ao gateway").toBe(gateway);
    expect(chamada?.include).toBeUndefined();
    const tabela = costCents(
      "anthropic/claude-sonnet-5",
      { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      "1h",
    );
    expect(tabela).toBeGreaterThan(0);
    expect(resultado.costCents).toBeCloseTo(tabela!, 6);
    expect(inserts[0]?.params[11]).toBeCloseTo(tabela!, 6);
    const concluida = log.info.mock.calls.find(([msg]) => msg === "llm: chamada concluída")?.[1];
    expect(concluida).not.toHaveProperty("custo_origem");
  });

  it("o custo informado lê o endereço da chamada que RODOU (o código-fonte)", () => {
    const fonte = readFileSync("lib/agent-engine/edge/llm/run-model-call.ts", "utf8");
    expect(fonte).toContain("baseUrlDaChamadaEfetiva = baseUrlDaChamada;");
    expect(fonte).toMatch(
      /config\.provider === 'openrouter' && ehOpenRouterOficial\(baseUrlDaChamadaEfetiva\)\s*\?\s*custoInformadoPeloOpenRouter\(result\)/,
    );
  });

  it("um passo sem usage.cost: vale a tabela, como antes, sem custo_origem", async () => {
    const { resultado, log } = await rodarPelaOpenRouter({ custos: [0.0123, null] });
    const tabela = costCents(
      "anthropic/claude-sonnet-5",
      { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      "1h",
    );
    expect(tabela).not.toBeNull();
    expect(resultado.costCents).toBeCloseTo(tabela!, 6);
    const concluida = log.info.mock.calls.find(([msg]) => msg === "llm: chamada concluída")?.[1];
    expect(concluida).not.toHaveProperty("custo_origem");
  });
});

/**
 * O ELO QUE DEIXA A PRÉVIA FECHAR COM O CUSTO DELA (#4664).
 *
 * `llm_calls.preview_run_id` é o que liga a chamada ao run de `ai_agent_runs` —
 * é por ele que a rota de teste soma tokens e custo do PRÓPRIO teste, e é por
 * ele que a aba "Execuções" acha a pergunta e a resposta (#4426). O turno real
 * usa `job_id` e nasce sem este elo.
 *
 * Sem este caso, apagar o `preview_run_id` do INSERT não derrubava teste
 * nenhum: a coluna ficaria nula, a prévia fecharia em zero e o defeito voltaria
 * com outra roupa.
 */
describe("a chamada de prévia aponta para o run que a causou (#4664)", () => {
  const RUN_DA_PREVIA = "55555555-5555-4555-8555-555555555555";

  function respostaDoModelo() {
    vi.mocked(generateText).mockResolvedValue({
      text: "ok",
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      steps: [],
      response: { id: "resp-elo", modelId: "gpt-6.1-terra" },
      responseMessages: [],
      toolCalls: [],
      finishReason: "stop",
    } as never);
  }

  const registryTerra = {
    openai: () => ({
      modelId: "gpt-6.1-terra",
      provider: "openai.responses",
      specificationVersion: "v3",
    }),
  } as never;

  it("⭐ o INSERT de llm_calls leva `preview_run_id` igual ao run do teste", async () => {
    respostaDoModelo();
    const { pool, inserts } = poolDaAnthropic("openai", "gpt-6.1-terra");

    await runModelCall(
      pool,
      { openaiApiKey: "sk-de-teste", cacheTtl: "1h" },
      {
        tenantId: ORG,
        purpose: "agent_preview",
        previewRunId: RUN_DA_PREVIA,
        messages: [{ role: "user", content: "que horas abrem?" }],
      },
      { registry: registryTerra },
    );

    expect(inserts).toHaveLength(1);
    // `preview_run_id` é a ÚLTIMA coluna da instrução — o valor tem de ser o id
    // do run, e não nulo: é a chave que a soma do fechamento usa.
    expect(inserts[0]?.params.at(-1)).toBe(RUN_DA_PREVIA);
  });

  it("o turno real continua sem o elo — `job_id` é a chave dele, não esta", async () => {
    respostaDoModelo();
    const { pool, inserts } = poolDaAnthropic("openai", "gpt-6.1-terra");

    await runModelCall(
      pool,
      { openaiApiKey: "sk-de-teste", cacheTtl: "1h" },
      {
        tenantId: ORG,
        purpose: "agent_turn",
        messages: [{ role: "user", content: "que horas abrem?" }],
      },
      { registry: registryTerra },
    );

    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.params.at(-1)).toBeNull();
  });
});

