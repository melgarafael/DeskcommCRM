/**
 * #4697 — O CUSTO NULO TEM DE DIZER POR QUÊ, E "SEM USO" NÃO É "SEM PREÇO".
 *
 * A PR anterior desta frente (a que fechou o #4700) unificou a ORDEM do preço
 * numa função só (`custo-da-chamada.ts`) e provou, no seam, que o mesmo
 * modelo/provedor/propósito grava o mesmo número no caminho primário e no da
 * reserva. Ficou de fora o outro lado do defeito, que é o que este arquivo
 * cobre:
 *
 *  1. `costCents` devolve `0` — não `null` — quando o modelo tem tarifa e a
 *     resposta veio SEM `usage` (tarifa × 0 token). Esse `0` entrava em
 *     `cost_cents` com cara de número medido e dizia "esta chamada foi de
 *     graça" ao painel de custo e ao teto, que somam `coalesce(cost_cents, 0)`.
 *     Zero é ausência de CUSTO; ausência de uso é ausência de DADO.
 *  2. O nulo que sobrava não dizia qual dos dois motivos era: "o provedor não
 *     mediu" (`sem_uso`) ou "ninguém sabe o preço" (`sem_preco`).
 *  3. A rota LEGADA (`computeCost`, dos workers `ai-response`/`ai-sentiment`)
 *     consultava `ai_pricing` primeiro; o seam consulta `pricing.ts`. O MESMO
 *     modelo podia sair com número numa rota e nulo na outra.
 *
 * Cada caso abaixo é um desses, pelo caminho de verdade (pool fingido + SDK
 * dublado no seam; função pura na rota legada).
 */
import { describe, expect, it, vi } from "vitest";

import { generateText, streamText, type ModelMessage } from "ai";

import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";
import { costCents } from "@/lib/agent-engine/edge/llm/pricing";
import { computeCost } from "@/lib/ai/cost";
import { providerDoModelo, provedorDaChamada } from "@/lib/ai/log-invocation";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("ai", () => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
  stepCountIs: () => () => false,
  asSchema: vi.fn(),
  tool: (t: unknown) => t,
}));
vi.mock("@/lib/supabase/admin", () => ({
  // Corrente permissiva: as consultas de catálogo/preço desta rota devolvem
  // VAZIO (nenhum preço cadastrado) — é o mundo que o custo por tabela mede.
  createAdminClient: vi.fn(() => {
    const vazio: Record<string, unknown> = {};
    const encadeavel: unknown = new Proxy(vazio, {
      get: (_t, prop) =>
        prop === "then"
          ? (resolve: (v: unknown) => void) => resolve({ data: [], error: null })
          : () => encadeavel,
    });
    return { from: () => encadeavel };
  }),
}));
vi.mock("@/lib/ai/credenciais/login-codex", () => ({
  renovarAssinaturaNoTurno: vi.fn(),
  lerLoginCodexRenovandoSeProxima: vi.fn(async () => ({
    access_token: "token-de-assinatura-de-teste",
    refresh_token: "refresh-de-teste",
    expires_at: Date.now() + 60_000,
  })),
}));

const ORG = "55555555-5555-4555-8555-555555555555";
const FITA: ModelMessage[] = [{ role: "assistant", content: [{ type: "text", text: "ok" }] }];

/** O uso que o provedor MEDIU — o caso em que o preço tem de sair. */
const COM_USO = {
  inputTokens: 1_000,
  outputTokens: 100,
  totalTokens: 1_100,
  inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
};

/** O mesmo modelo, resposta SEM `usage`: todo contador zerado. */
const SEM_USO = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
};

function pool(opts: { provider: string; defaultModel: string }) {
  const inserts: Array<{ sql: string; params: unknown[] }> = [];
  const queries: string[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    queries.push(sql);
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
  return { pool: { query } as never, inserts, queries };
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

function streamOk(uso: Record<string, unknown> = COM_USO) {
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

const logDuble = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

async function chamar(opts: { provider: string; model: string }, log = logDuble()) {
  const p = pool({ provider: opts.provider, defaultModel: opts.model });
  const r = await runModelCall(
    p.pool,
    { anthropicApiKey: "ant", openaiApiKey: "openai-de-teste", cacheTtl: "1h" },
    {
      tenantId: ORG,
      purpose: "agent_turn",
      // `model` explícito: o caso é a REGRA DO CUSTO, não a resolução do modelo.
      model: opts.model,
      messages: [{ role: "user", content: "oi" }],
    },
    { registry, log },
  );
  const linha = p.inserts[0]!.params;
  return {
    resultado: r,
    // `params[11]` é `cost_cents` no INSERT de sucesso do seam.
    costCents: linha[11] as number | null,
    provider: linha[5] as string,
    model: linha[6] as string,
    inserts: p.inserts,
    queries: p.queries,
    log,
  };
}

const motivoDoLog = (log: ReturnType<typeof logDuble>) =>
  log.info.mock.calls
    .map((c) => c[1] as Record<string, unknown>)
    .find((p) => p?.purpose === "agent_turn")?.custo_origem;

describe("#4697 — o nulo tem motivo, e sem uso não vira zero", () => {
  it("(a) chamada com usage completo grava custo", async () => {
    streamOk(COM_USO);
    const c = await chamar({ provider: "openai-assinatura", model: "gpt-6-astra" });

    expect(c.costCents).not.toBeNull();
    expect(c.costCents).toBeGreaterThan(0);
    // gpt-6-astra: 10 USD/MTok de entrada, 50 de saída.
    expect(c.costCents).toBeCloseTo(((1_000 * 10 + 100 * 50) / 1_000_000) * 100, 10);
  });

  it("(b) chamada sem usage grava NULL com motivo 'sem_uso', distinguível de 'sem_preco'", async () => {
    // 1) O provedor não mediu. O modelo TEM tarifa: `preço × 0 token` daria 0.
    streamOk(SEM_USO);
    const semUso = await chamar({ provider: "openai-assinatura", model: "gpt-6-astra" });

    // Zero seria "não custou nada"; o que houve foi "não sabemos quanto consumiu".
    expect(semUso.costCents).toBeNull();
    expect(semUso.costCents).not.toBe(0);
    expect(motivoDoLog(semUso.log)).toBe("sem_uso");

    // 2) O preço é que não existe. Aqui o uso veio: o motivo é OUTRO.
    streamOk(COM_USO);
    const semPreco = await chamar({ provider: "openai-assinatura", model: "gpt-6-astra-do-futuro" });
    expect(semPreco.costCents).toBeNull();
    expect(motivoDoLog(semPreco.log)).toBe("sem_preco");

    // A coluna diz null nos dois casos, e é o MOTIVO que separa os dois mundos.
    expect(motivoDoLog(semUso.log)).not.toBe(motivoDoLog(semPreco.log));
  });

  it("(c) o mesmo provedor/modelo em duas rotas usa o MESMO critério", async () => {
    // Rota 1: o seam do motor.
    streamOk(COM_USO);
    const seam = await chamar({ provider: "openai-assinatura", model: "gpt-6-astra" });

    // Rota 2: a legada (`computeCost`), que é a dos workers ai-response/ai-sentiment.
    const legada = await computeCost({
      model: "gpt-6-astra",
      promptTokens: 1_000,
      completionTokens: 100,
    });

    expect(seam.costCents).not.toBeNull();
    expect(legada).not.toBeNull();
    // O MESMO número, não dois critérios: antes, `pricing.ts` mandava no seam e
    // `ai_pricing` na legada, e o mesmo modelo saía com preço numa e nulo na outra.
    expect(legada).toBeCloseTo(seam.costCents as number, 10);

    // E o critério de DADO também é o mesmo nas duas: sem uso, nulo nas duas.
    streamOk(SEM_USO);
    const seamSemUso = await chamar({ provider: "openai-assinatura", model: "gpt-6-astra" });
    const legadaSemUso = await computeCost({
      model: "gpt-6-astra",
      promptTokens: 0,
      completionTokens: 0,
    });
    expect(seamSemUso.costCents).toBeNull();
    expect(legadaSemUso).toBeNull();
  });

  it("(d) provedor conhecido não vira 'desconhecido' — o palpite é o último recurso", async () => {
    // O mecanismo do `whisper-large-v3-turbo`: o id não tem barra nem prefixo de
    // provedor, então o palpite por id NÃO tem como acertar…
    expect(providerDoModelo("whisper-large-v3-turbo")).toBe("desconhecido");
    // …e é por isso que quem sabe o provedor TEM de informá-lo. Informado, ele vence.
    expect(provedorDaChamada("openai", "whisper-large-v3-turbo")).toBe("openai");

    // E o seam grava o provedor da chamada, nunca o palpite, mesmo no caminho
    // em que não houve uso nenhum (é aí que o palpite seria mais tentador).
    streamOk(SEM_USO);
    const c = await chamar({ provider: "openai-assinatura", model: "whisper-large-v3-turbo" });
    expect(c.provider).toBe("openai-assinatura");
    expect(c.provider).not.toBe("desconhecido");
  });

  it("(e) valor já gravado não muda: a chamada com custo grava exatamente o da tabela, e nada é reescrito", async () => {
    streamOk(COM_USO);
    const c = await chamar({ provider: "openai-assinatura", model: "gpt-6-astra" });

    const esperado = costCents("gpt-6-astra", {
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(c.costCents).toBe(esperado);

    // A correção é só do caminho de ESCRITA novo: nenhuma linha existente é
    // reescrita (nada de UPDATE, nada de backfill) — o histórico fica como está.
    expect(c.queries.some((q) => /update\s+llm_calls/i.test(q))).toBe(false);
    expect(c.queries.filter((q) => /insert into llm_calls/i.test(q))).toHaveLength(1);
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
  });
});
