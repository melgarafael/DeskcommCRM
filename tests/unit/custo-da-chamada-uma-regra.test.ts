/**
 * A REGRA ÚNICA DO CUSTO — os quatro desfechos que a #4697 mediu no banco.
 *
 * O relato: em `llm_calls`, chamadas do MESMO provedor/modelo/propósito saíam
 * com `cost_cents` preenchido em umas e NULL em outras (271 de 457 turnos entre
 * 22/10 e 02/11/2026, `openai-assinatura` + `gpt-6-astra`), e o autor da issue
 * escreveu que não achou no código o que decidia gravar ou não. Não achou
 * porque a decisão estava em três `??` no meio do seam, e porque a linha de
 * FALHA grava nulo por um caminho diferente (`registrarFalha`), com a mesma
 * aparência na coluna.
 *
 * O que este arquivo prova, pelo seam inteiro (pool fingido + SDK dublado):
 *
 *   a) a MESMA chamada no caminho primário (assinatura) e no da reserva
 *      (chave OpenAI, depois de a assinatura estourar a janela de uso) grava o
 *      MESMO custo — a regra não depende de qual dos dois atendeu;
 *   b) modelo fora da tabela não vira nulo CALADO: o custo é nulo (nunca 0
 *      inventado) e o motivo sai no log como `custo_origem: 'sem_preco'`;
 *   d) chamada que falha ANTES do uso não inventa custo: a linha de erro
 *      carrega `cost_cents` nulo e `status: 'erro'`, e nada é cobrado.
 *
 * O caso (c) — transcrição com o provedor identificado — mora em
 * `tests/unit/midia-grava-custo-em-llm-calls.test.ts`, junto do dublê do
 * worker de mídia.
 */
import { describe, expect, it, vi } from "vitest";

import { generateText, streamText, type ModelMessage } from "ai";

import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";
import { lerLoginCodexRenovandoSeProxima } from "@/lib/ai/credenciais/login-codex";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("ai", () => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
  stepCountIs: () => () => false,
  asSchema: vi.fn(),
  tool: (t: unknown) => t,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/ai/credenciais/login-codex", () => ({
  renovarAssinaturaNoTurno: vi.fn(),
  // O seam relê a credencial depois de renovar; o dublê devolve um par válido.
  lerLoginCodexRenovandoSeProxima: vi.fn(async () => ({
    access_token: "token-de-assinatura-de-teste",
    refresh_token: "refresh-de-teste",
    expires_at: Date.now() + 60_000,
  })),
}));

const ORG = "44444444-4444-4444-8444-444444444444";
const FITA: ModelMessage[] = [{ role: "assistant", content: [{ type: "text", text: "ok" }] }];

const USO = {
  inputTokens: 1_000,
  outputTokens: 100,
  totalTokens: 1_100,
  inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
};

/**
 * `pg.Pool` fingido: distingue por trecho de SQL, como os testes vizinhos.
 * O catálogo (`ai_models`/`ai_pricing`) responde VAZIO de propósito — é o
 * mundo sem preço cadastrado, que é o que o caso (b) mede.
 */
function pool(opts: { provider: string; defaultModel: string }) {
  const inserts: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("settings->'llm'")) {
      return {
        rows: [
          {
            llm: {
              provider: opts.provider,
              default_model: opts.defaultModel,
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
    if (sql.includes("from ai_models") || sql.includes("from ai_pricing")) return { rows: [] };
    if (sql.includes("insert into llm_calls")) {
      inserts.push({ sql, params });
      return { rows: [{ id: "call-1" }] };
    }
    return { rows: [] };
  });
  return { pool: { query } as never, inserts, query };
}

const registry = {
  "openai-assinatura": () => ({
    specificationVersion: "v3",
    provider: "openai-assinatura",
    modelId: "gpt-6-astra",
    doGenerate: async () => ({ text: "ok", usage: {} }),
    doStream: async () => ({ stream: [] }),
  }),
  openai: () => ({
    specificationVersion: "v3",
    provider: "openai",
    modelId: "gpt-6-astra",
    doGenerate: async () => ({ text: "ok", usage: {} }),
    doStream: async () => ({ stream: [] }),
  }),
} as never;

function streamOk(uso: Record<string, unknown> = USO) {
  vi.mocked(streamText).mockReturnValue({
    text: Promise.resolve("ok"),
    usage: Promise.resolve(uso),
    response: Promise.resolve({ id: "r1" }),
    steps: Promise.resolve([]),
    responseMessages: Promise.resolve(FITA),
    toolCalls: Promise.resolve([]),
    finishReason: Promise.resolve("stop"),
  } as never);
}

/** A recusa REAL da assinatura: HTTP 400 com "usage limit" no corpo (#3371). */
function streamRecusadoPelaJanela() {
  const erro = Object.assign(new Error("The ChatGPT user has reached their Subscription Sharing usage limit"), {
    status: 400,
  });
  vi.mocked(streamText).mockReturnValue({
    text: Promise.reject(erro),
    usage: Promise.reject(erro),
    response: Promise.reject(erro),
    steps: Promise.reject(erro),
    responseMessages: Promise.reject(erro),
    toolCalls: Promise.reject(erro),
    finishReason: Promise.reject(erro),
  } as never);
}

function generateOk(uso: Record<string, unknown> = USO) {
  vi.mocked(generateText).mockResolvedValue({
    text: "ok",
    usage: uso,
    steps: [],
    response: { id: "r2" },
    responseMessages: FITA,
    toolCalls: [],
    finishReason: "stop",
  } as never);
}

/** A linha que foi para `llm_calls`: `params[11]` é `cost_cents` (ver o INSERT do seam). */
function linhaGravada(inserts: Array<{ params: unknown[] }>) {
  expect(inserts).toHaveLength(1);
  const p = inserts[0]!.params;
  return { provider: p[5] as string, model: p[6] as string, costCents: p[11] as number | null };
}

/** Logger dublê: o seam chama `info`/`warn`/`error`, e o `?.` não protege membro ausente. */
const logDuble = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const deps = (log: ReturnType<typeof logDuble>) => ({ registry, log });

describe("#4697 — uma regra só para o custo da chamada", () => {
  it("(a) a mesma chamada no primário (assinatura) e na reserva grava o MESMO custo", async () => {
    // 1) primário: a assinatura atende.
    streamOk();
    const primario = pool({ provider: "openai-assinatura", defaultModel: "gpt-6-astra" });
    await runModelCall(
      primario.pool,
      { anthropicApiKey: "ant", openaiApiKey: "openai-de-teste", cacheTtl: "1h" },
      { tenantId: ORG, purpose: "agent_turn", messages: [{ role: "user", content: "oi" }] },
      deps(logDuble()),
    );
    const naAssinatura = linhaGravada(primario.inserts);

    // 2) reserva: a assinatura estoura a janela de uso e a chave da empresa atende.
    streamRecusadoPelaJanela();
    generateOk();
    const comReserva = pool({ provider: "openai-assinatura", defaultModel: "gpt-6-astra" });
    await runModelCall(
      comReserva.pool,
      { anthropicApiKey: "ant", openaiApiKey: "openai-de-teste", cacheTtl: "1h" },
      { tenantId: ORG, purpose: "agent_turn", messages: [{ role: "user", content: "oi" }] },
      deps(logDuble()),
    );
    const naReserva = linhaGravada(comReserva.inserts);

    // A IDENTIDADE do caminho: o primeiro foi pela assinatura, o segundo caiu.
    expect(naAssinatura.provider).toBe("openai-assinatura");
    expect(naReserva.provider).toBe("openai");
    expect(vi.mocked(streamText)).toHaveBeenCalled();
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(1);

    // A REGRA: mesmo modelo, mesmo usage, mesmo número — nunca um preenchido e
    // o outro nulo, que é o defeito relatado.
    expect(naAssinatura.model).toBe("gpt-6-astra");
    expect(naReserva.model).toBe("gpt-6-astra");
    expect(naAssinatura.costCents).not.toBeNull();
    expect(naReserva.costCents).toBe(naAssinatura.costCents);
    // gpt-6-astra: 10 USD/MTok de entrada, 50 de saída → (1000×10 + 100×50)/1e6 USD
    expect(naAssinatura.costCents).toBeCloseTo(((1_000 * 10 + 100 * 50) / 1_000_000) * 100, 10);
  });

  it("(b) modelo fora da tabela e do catálogo: custo NULO com o motivo, nunca 0 inventado", async () => {
    streamOk();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const foraDaTabela = pool({ provider: "openai-assinatura", defaultModel: "gpt-6-astra-do-futuro" });
    const r = await runModelCall(
      foraDaTabela.pool,
      { anthropicApiKey: "ant", openaiApiKey: "openai-de-teste", cacheTtl: "1h" },
      { tenantId: ORG, purpose: "agent_turn", messages: [{ role: "user", content: "oi" }] },
      deps(log),
    );

    const linha = linhaGravada(foraDaTabela.inserts);
    expect(linha.model).toBe("gpt-6-astra-do-futuro");
    // Nulo é "não sei" — e 0 diria "grátis" ao painel e ao teto.
    expect(linha.costCents).toBeNull();
    expect(r.costCents).toBeNull();

    // O que impede o nulo de ser CALADO: o motivo viaja com a linha do log…
    const concluida = log.info.mock.calls.map((c) => c[1] as Record<string, unknown>).find((p) => p?.purpose === "agent_turn");
    expect(concluida).toMatchObject({ custo_origem: "sem_preco", cost_cents: null });
    // …e o catálogo diz em voz alta que não conhece o modelo.
    expect(log.warn).toHaveBeenCalledWith(
      "llm: modelo sem preço no motor nem no catálogo — a chamada grava custo nulo",
      expect.objectContaining({ model: "gpt-6-astra-do-futuro", provider: "openai-assinatura" }),
    );
  });

  it("(d) chamada que falha antes do uso grava custo NULO e status de erro — não inventa custo", async () => {
    const erroDoProvedor = Object.assign(new Error("401 Unauthorized"), { status: 401 });
    vi.mocked(generateText).mockRejectedValue(erroDoProvedor);
    const falha = pool({ provider: "openai", defaultModel: "gpt-6-astra" });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await expect(
      runModelCall(
        falha.pool,
        { anthropicApiKey: "ant", openaiApiKey: "openai-de-teste", cacheTtl: "1h" },
        { tenantId: ORG, purpose: "agent_turn", messages: [{ role: "user", content: "oi" }] },
        deps(log),
      ),
    ).rejects.toThrow();

    // A linha existe — a tabela que explica a falha não pode ficar vazia —, e
    // ela não carrega preço nenhum: a chamada não consumiu token. O INSERT de
    // falha é outro statement, com os quatro contadores e `cost_cents` em
    // LITERAL (`0, 0, 0, 0, null`): é o que impede a coluna de herdar o preço
    // de uma chamada que não aconteceu.
    expect(falha.inserts).toHaveLength(1);
    const { sql, params } = falha.inserts[0]!;
    expect(sql).toContain("'erro'");
    // Os contadores e o custo são literais no statement de falha — nenhum
    // parâmetro pode injetar preço numa chamada que não consumiu token.
    expect(sql).toContain("0, 0, 0, 0, null, $8");
    // A linha ainda diz de quem era a chamada e por que ela caiu.
    expect(params[4]).toBe("agent_turn");
    expect(params[5]).toBe("openai");
    expect(params[6]).toBe("gpt-6-astra");
    expect(params[8]).toBe("credencial_recusada");
    expect(params[9]).toContain("401");
  });
});
