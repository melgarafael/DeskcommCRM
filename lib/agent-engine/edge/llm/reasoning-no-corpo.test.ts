/**
 * O esforço de raciocínio chega ao PROVIDER — não só à função pura.
 *
 * `esforco-de-raciocinio.test.ts` prova a decisão; este prova a entrega. Sem
 * ele, alguém pode renomear o campo, esquecer o spread ou mandá-lo para o
 * provider errado, e a suíte segue verde enquanto o cliente volta a esperar 50
 * segundos — presença de símbolo não é comportamento.
 *
 * O que este arquivo observa é o corpo que sai: `generateText` é interceptado e
 * o `providerOptions` é lido de lá.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const capturado: Array<Record<string, unknown>> = [];

vi.mock("ai", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  generateText: vi.fn(async (args: Record<string, unknown>) => {
    capturado.push(args);
    return {
      text: "ok",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      finishReason: "stop",
      response: { id: "r", modelId: "gpt-5-mini", timestamp: new Date() },
    };
  }),
}));

vi.mock("./credentials", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveOrgLlmConfig: vi.fn(async () => ({
    provider: "openai",
    apiKey: "sk-teste",
    defaultModel: "gpt-5-mini",
    params: {},
    enabledModels: [],
    orcamento: null,
  })),
}));

vi.mock("./binding-do-ponto", () => ({
  // Devolve o modelo que o call site pediu: quem manda no corpo é
  // `decisao.modelId`, e um mock que ignorasse isso não conseguiria exercitar
  // o caso do modelo que NÃO raciocina.
  decidirParaOSeam: vi.fn(async (_db: unknown, entrada: { modeloDoCallSite?: string }) => ({
    provider: "openai",
    modelId: entrada.modeloDoCallSite ?? "gpt-5-mini",
    credentialId: null,
    baseUrl: null,
    origem: "padrao_da_organizacao",
    avisos: [],
  })),
}));

vi.mock("./orcamento", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  assertBudget: vi.fn(async () => undefined),
  normalizarChaveDeOrcamento: () => "on",
}));

const poolFalso = () => ({ query: vi.fn(async () => ({ rows: [] })) }) as never;

/** Provider falso: o registry é injetável, então nenhuma rede é tocada. */
const registryFalso = { openai: () => ({ modelId: "gpt-5-mini" }) } as never;

async function chamar(cfgExtra: Record<string, unknown>, model = "gpt-5-mini") {
  const { runModelCall } = await import("./run-model-call");
  await runModelCall(
    poolFalso(),
    { openaiApiKey: "sk-teste", ...cfgExtra } as never,
    { tenantId: "org-1", model, messages: [{ role: "user", content: "oi" }] },
    { registry: registryFalso },
  );
  return capturado.at(-1)!;
}

describe("o esforço de raciocínio chega ao provider", () => {
  beforeEach(() => {
    capturado.length = 0;
    vi.clearAllMocks();
  });

  it("vai no corpo como providerOptions.openai.reasoningEffort", async () => {
    const args = await chamar({ reasoningEffort: "low" });
    expect(args.providerOptions).toEqual({ openai: { reasoningEffort: "low" } });
  });

  it("usa `low` quando a config não diz nada — o default do produto", async () => {
    // Este é o caso de TODA instalação que não editou `.env`: a correção só
    // vale se ela chegar sem ninguém configurar nada.
    const args = await chamar({});
    expect(args.providerOptions).toEqual({ openai: { reasoningEffort: "low" } });
  });

  it("NÃO vai no corpo quando o operador escolheu `provider`", async () => {
    const args = await chamar({ reasoningEffort: "provider" });
    expect(args.providerOptions).toBeUndefined();
  });

  it("NÃO vai no corpo para modelo que não raciocina", async () => {
    // gpt-4o com `reasoning_effort` é 400 na OpenAI — trocar lentidão por
    // falha seria pior que o defeito que este knob conserta.
    const args = await chamar({ reasoningEffort: "high" }, "gpt-4o");
    expect(args.providerOptions).toBeUndefined();
  });
});
