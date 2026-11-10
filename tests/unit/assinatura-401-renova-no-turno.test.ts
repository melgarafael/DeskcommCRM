/**
 * O 401 DO TURNO RENOVE ANTES DE CAIR (#3371, fatia 4).
 *
 * ## O que aconteceu em produção
 *
 * `chamarComRetryUnicoEm401` existia em `lib/ai/pontos/renovacao-da-assinatura.ts`
 * desde a fiação da assinatura e **não tinha chamador de produção** — só os
 * testes dele (`tests/unit/provedor-assinatura-login-pkce.test.ts`). No cliente
 * Obralivre, o `401 · Provided authentication token is expired` apareceu em 107
 * turnos seguidos: cada turno caía na política de reserva sem NUNCA tentar
 * renovar, e a IA ficou ~26 h calada com cota sobrando.
 *
 * ## O que este arquivo prova, pelo SEAM inteiro
 *
 *  1. `401 → renova → 200`: DOIS POSTs ao provedor, UMA renovação, turno entregue.
 *  2. `401 → renova → 401`: dois POSTs e ponto. `tentativas: 2` — nada de laço.
 *  3. Renovação recusada: continua sendo um retry só, e o motivo da recusa
 *     (fatia 3) fica no log, que é de onde a fatia 2 o lê.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { streamText } from "ai";

import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";
import {
  lerLoginCodexRenovandoSeProxima,
  renovarAssinaturaNoTurno,
} from "@/lib/ai/credenciais/login-codex";
import { chamarComRetryUnicoEm401 } from "@/lib/ai/pontos/renovacao-da-assinatura";
import { sincronizarAvisoDaAssinatura } from "@/lib/ai/credenciais/aviso-da-assinatura";

vi.mock("ai", () => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
  stepCountIs: () => () => false,
  asSchema: vi.fn(),
  tool: (t: unknown) => t,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/ai/credenciais/aviso-da-assinatura", () => ({
  sincronizarAvisoDaAssinatura: vi.fn(async () => "aberto"),
}));
vi.mock("@/lib/ai/credenciais/login-codex", () => ({
  lerLoginCodexRenovandoSeProxima: vi.fn(async () => ({
    access_token: "token-de-assinatura-de-teste",
    refresh_token: "refresh-de-teste",
    expires_at: Date.now() + 60_000,
  })),
  renovarAssinaturaNoTurno: vi.fn(),
}));

const ORG = "33333333-3333-4333-8333-333333333333";

/** O erro que o provedor devolve: 401 com sinal de expiração. */
function erro401(): Error {
  return Object.assign(new Error("Provided authentication token is expired"), {
    statusCode: 401,
    name: "AI_APICallError",
  });
}

function poolDaAssinatura() {
  const query = vi.fn(async (sql: string) => {
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
    // Sem chave `openai` cadastrada: não há reserva para onde cair — é o cenário
    // do cliente que ficou sem resposta.
    if (sql.includes("from ai_provider_credentials")) return { rows: [] };
    if (sql.includes("insert into llm_calls")) return { rows: [{ id: "call-401" }] };
    return { rows: [] };
  });
  return { query } as never;
}

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

function respostaBoa() {
  return {
    text: Promise.resolve("Estamos abertos das 9h às 18h."),
    usage: Promise.resolve({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
    }),
    response: Promise.resolve({ id: "resp-1", modelId: "gpt-5.6-luna" }),
    steps: Promise.resolve([]),
    responseMessages: Promise.resolve([]),
    toolCalls: Promise.resolve([]),
    finishReason: Promise.resolve("stop"),
  };
}

function respostaRecusada(erro: Error) {
  return {
    ...respostaBoa(),
    text: Promise.reject(erro),
  };
}

/**
 * O dublê do stream com um roteiro: a n-ésima chamada devolve o que o roteiro
 * manda. É o que permite "401 na primeira, 200 na segunda" sem inventar estado
 * fora do seam.
 */
function roteiroDoProvedor(passos: Array<"ok" | "401">) {
  let indice = 0;
  const erro = erro401();
  vi.mocked(streamText).mockImplementation(((opcoes: { onError?: (a: { error: unknown }) => void }) => {
    const passo = passos[indice] ?? "ok";
    indice += 1;
    if (passo === "401") {
      // O SDK entrega o erro original ao callback; é ele que o seam relança.
      opcoes.onError?.({ error: erro });
      return respostaRecusada(erro) as never;
    }
    return respostaBoa() as never;
  }) as never);
  return () => indice;
}

async function rodar() {
  return runModelCall(
    poolDaAssinatura(),
    { anthropicApiKey: "chave...te", openaiApiKey: "chave...te", cacheTtl: "1h" },
    {
      tenantId: ORG,
      purpose: "agent_turn",
      messages: [{ role: "user", content: "que horas abrem?" }],
    },
    { registry, log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never },
  );
}

beforeEach(() => {
  vi.mocked(streamText).mockReset();
  vi.mocked(renovarAssinaturaNoTurno).mockReset();
  vi.mocked(renovarAssinaturaNoTurno).mockResolvedValue({
    ok: true,
    tokens: {
      access_token: "at-renovado",
      refresh_token: "rt-renovado",
      expires_at: Date.now() + 3_600_000,
    },
  });
  vi.mocked(lerLoginCodexRenovandoSeProxima).mockClear();
});

describe("401 → renova → 200: o turno é entregue", () => {
  it("⭐ dois POSTs, UMA renovação, e a resposta chega", async () => {
    roteiroDoProvedor(["401", "ok"]);

    const resultado = await rodar();

    expect(vi.mocked(renovarAssinaturaNoTurno), "o 401 não renovou nada").toHaveBeenCalledTimes(1);
    expect(vi.mocked(renovarAssinaturaNoTurno).mock.calls[0]?.[0]).toMatchObject({ orgId: ORG });
    expect(vi.mocked(streamText), "não repetiu a chamada depois de renovar").toHaveBeenCalledTimes(2);
    expect(resultado.result.text).toBe("Estamos abertos das 9h às 18h.");
    expect(resultado.provider).toBe("openai-assinatura");
  });
});

describe("401 → renova → 401: dois POSTs e ponto (sem laço)", () => {
  it("⭐ a chamada falha DEPOIS de uma renovação e de uma repetição — nunca uma terceira", async () => {
    roteiroDoProvedor(["401", "401"]);

    await expect(rodar()).rejects.toThrow("Provided authentication token is expired");

    expect(vi.mocked(renovarAssinaturaNoTurno)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(streamText), "insistiu além do retry único").toHaveBeenCalledTimes(2);
  });

  it("⭐ a recusa VIRA aviso na Central, com o motivo — não fica só no log", async () => {
    vi.mocked(renovarAssinaturaNoTurno).mockResolvedValue({
      ok: false,
      motivo: "falha",
      motivoDetalhe: "refresh_token_revoked",
    });
    roteiroDoProvedor(["401", "401"]);

    await expect(rodar()).rejects.toThrow();

    // A Central de avisos do cliente Obralivre ficou VAZIA em ~26 h de 401. O
    // turno que falha é quem abre o item — e o motivo vem da fatia 3.
    expect(vi.mocked(sincronizarAvisoDaAssinatura), "a recusa não virou aviso").toHaveBeenCalledTimes(1);
    expect(vi.mocked(sincronizarAvisoDaAssinatura).mock.calls[0]?.[1]).toMatchObject({
      organizationId: ORG,
      conectada: false,
      recusa: "falha:refresh_token_revoked",
    });
  });

  it("⭐ `em_curso` (outro processo renovando) NÃO abre aviso de conta desconectada", async () => {
    vi.mocked(renovarAssinaturaNoTurno).mockResolvedValue({ ok: false, motivo: "em_curso" });
    vi.mocked(sincronizarAvisoDaAssinatura).mockClear();
    roteiroDoProvedor(["401", "401"]);

    await expect(rodar()).rejects.toThrow();

    // A conta não desconectou: só a trava estava com outro processo.
    expect(vi.mocked(sincronizarAvisoDaAssinatura)).not.toHaveBeenCalled();
  });

  it("renovação RECUSADA também não vira laço: mesma renovação, mesma repetição", async () => {
    vi.mocked(renovarAssinaturaNoTurno).mockResolvedValue({
      ok: false,
      motivo: "falha",
      motivoDetalhe: "refresh_token_revoked",
    });
    roteiroDoProvedor(["401", "401"]);

    await expect(rodar()).rejects.toThrow("Provided authentication token is expired");

    expect(vi.mocked(renovarAssinaturaNoTurno)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(2);
  });
});

describe("o contrato do retry único, na função que agora tem chamador", () => {
  it("devolve `tentativas: 2` nos DOIS desfechos", async () => {
    const renovar = vi.fn(async () => undefined);

    const primeiro200 = vi
      .fn()
      .mockResolvedValueOnce({ status: 401, corpo: "recusado" })
      .mockResolvedValueOnce({ status: 200, corpo: "ok" });
    expect(await chamarComRetryUnicoEm401({ tentar: primeiro200, renovarApos401: renovar })).toEqual({
      status: 200,
      corpo: "ok",
      tentativas: 2,
    });

    const dois401 = vi
      .fn()
      .mockResolvedValueOnce({ status: 401, corpo: "recusado" })
      .mockResolvedValueOnce({ status: 401, corpo: "recusado de novo" });
    expect(await chamarComRetryUnicoEm401({ tentar: dois401, renovarApos401: renovar })).toEqual({
      status: 401,
      corpo: "recusado de novo",
      tentativas: 2,
    });

    // Um status que não é 401 não gasta renovação nem repetição.
    const outroErro = vi.fn().mockResolvedValue({ status: 500, corpo: "fora do ar" });
    expect(await chamarComRetryUnicoEm401({ tentar: outroErro, renovarApos401: renovar })).toEqual({
      status: 500,
      corpo: "fora do ar",
      tentativas: 1,
    });
    expect(renovar).toHaveBeenCalledTimes(2);
  });
});
