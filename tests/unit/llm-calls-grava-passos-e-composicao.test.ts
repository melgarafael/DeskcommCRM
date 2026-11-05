/**
 * CADA CHAMADA DO SEAM DIZ QUANTOS PASSOS TEVE E DE QUE É FEITO O PEDIDO.
 *
 * `llm_calls` só tinha totais: o "2 passos de ~28,7 mil tokens" da investigação
 * de consumo teve de ser INFERIDO. A migration 9105 acrescenta sete colunas e
 * `runModelCall` passa a preenchê-las no INSERT — depois da resposta, fora de
 * `latency_ms`, e sem tocar no que foi ao provedor.
 *
 * Pelo SEAM inteiro, com o pool fingido e o `generateText` dublê (o mesmo molde
 * de `custo-do-provedor-personalizado-vem-do-catalogo.test.ts`). O ponto de
 * verdade são os parâmetros `$16..$22` do INSERT. As posições `$1..$15` não
 * mudam — o custo continua em `params[11]`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type * as ModuloAi from "ai";

vi.mock("@/lib/crypto/aes_gcm", () => ({
  byteaToBuffer: () => Buffer.from(""),
  decryptKey: () => "chave-da-empresa",
}));

// Só o `generateText` é dublê: `tool`, `jsonSchema` e `asSchema` são os reais,
// porque a medição serializa as ferramentas como o provedor as recebe.
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof ModuloAi>()),
  generateText: vi.fn(async () => ({
    text: "ok",
    usage: {
      inputTokens: 2100,
      outputTokens: 50,
      inputTokenDetails: { noCacheTokens: 2100, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    steps: [
      { usage: { inputTokens: 1000, outputTokens: 30 } },
      { usage: { inputTokens: 1100, outputTokens: 20 } },
    ],
  })),
}));

import { jsonSchema, tool, type ToolSet } from "ai";

import { _esquecerPrecosDoCatalogoParaTestes } from "@/lib/agent-engine/edge/llm/pricing-do-catalogo";
import { costCents } from "@/lib/agent-engine/edge/llm/pricing";
import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";
import { stablePrefixHash } from "@/lib/agent-engine/edge/llm/stable-prefix";
import type { Logger } from "@/lib/agent-engine/obs/logger";

const ORG = "11111111-1111-4111-8111-111111111111";
const MODELO = "claude-haiku-5-5";
const SISTEMA = "sou o sistema do teste";
const ANTES_DO_PRAZO = new Date("2026-09-20T00:00:00.000Z");

function poolFalso() {
  const inserts: unknown[][] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("insert into llm_calls")) {
      inserts.push(params);
      return { rows: [{ id: "call-1" }] };
    }
    if (sql.includes("settings->'llm'")) {
      return {
        rows: [
          {
            llm: { provider: "custom", default_model: MODELO, params: {}, enabled_models: [], monthly_budget_cents: null },
          },
        ],
      };
    }
    if (sql.includes("from ai_purpose_bindings")) return { rows: [] };
    if (sql.includes("base_url")) return { rows: [{ base_url: "https://api.groq.com/openai/v1" }] };
    if (sql.includes("api_key_encrypted")) {
      return { rows: [{ id: "cred-1", api_key_encrypted: "x", api_key_iv: "y", api_key_tag: "z" }] };
    }
    return { rows: [] };
  });
  return { pool: { query } as never, inserts };
}

function registry() {
  const fabrica = (provider: string) => (_apiKey: unknown, modelId: string) =>
    ({
      specificationVersion: "v3",
      provider,
      modelId,
      doGenerate: async () => {
        throw new Error("SENTINELA: o seam usou o SDK de verdade em vez do dublê");
      },
    }) as never;
  return { custom: fabrica("custom"), anthropic: fabrica("anthropic"), openai: fabrica("openai") };
}

function logEspiao() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger & {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };
}

async function rodar(tools: ToolSet, esquemaSemPadrao?: boolean) {
  const { pool, inserts } = poolFalso();
  const log = logEspiao();
  const resultado = await runModelCall(
    pool,
    { cacheTtl: "1h", ...(esquemaSemPadrao === undefined ? {} : { esquemaSemPadrao }) },
    {
      tenantId: ORG,
      purpose: "checkpoint",
      system: SISTEMA,
      messages: [{ role: "user", content: "oi" }],
      tools,
    },
    { registry: registry(), log, agora: ANTES_DO_PRAZO },
  );
  return { resultado, params: inserts[0]!, inserts, log };
}

beforeEach(() => _esquecerPrecosDoCatalogoParaTestes());

describe("llm_calls grava passos e composição do pedido", () => {
  it("os sete parâmetros novos chegam ao INSERT, e o custo continua onde estava", async () => {
    const { params, inserts, resultado } = await rodar({
      buscar: tool({ description: "Busca no catálogo.", inputSchema: z.object({ q: z.string() }) }),
    });

    expect(inserts).toHaveLength(1);
    expect(params).toHaveLength(22);
    expect(params[15]).toBe(2); // passos
    expect(params[16]).toBe(1000); // entrada do 1º passo, como o provedor informou
    expect(params[17]).toBe(SISTEMA.length); // chars_sistema
    expect(params[18] as number).toBeGreaterThan(0); // chars_ferramentas
    expect(params[19]).toBe("oi".length); // chars_mensagens
    expect(params[20]).toBe(0); // partes_de_midia
    expect(params[21]).toMatch(/^[0-9a-f]{64}$/); // prefixo_hash

    // A soma dos passos segue sendo o total gravado, e o custo não mudou de posição.
    expect(params[7]).toBe(2100);
    const esperado = costCents(MODELO, { inputTokens: 2100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(params[11]).toBeCloseTo(esperado!, 9);
    expect(resultado.costCents).toBeCloseTo(esperado!, 9);
  });

  it("o prefixo_hash é o do esquema que foi ao fio: com o knob ligado, o do esquema enxuto", async () => {
    const tools = { ver: tool({ description: "Lê um lead.", inputSchema: z.object({ lead_id: z.string().uuid() }) }) };
    const { params } = await rodar(tools, true);
    expect(params[21]).toBe(await stablePrefixHash({ system: SISTEMA, tools, esquemaSemPadrao: true }));
    expect(params[21]).not.toBe(await stablePrefixHash({ system: SISTEMA, tools, esquemaSemPadrao: false }));
  });

  it("medição que falha vira coluna nula com aviso — a chamada fecha `ok` e o INSERT sai", async () => {
    const { params, inserts, log } = await rodar({
      quebrada: tool({
        description: "Schema que estoura ao ser lido.",
        inputSchema: jsonSchema(() => {
          throw new Error("x");
        }),
      }),
    });

    expect(inserts).toHaveLength(1);
    expect(params[15]).toBe(2);
    expect(params[16]).toBe(1000);
    expect(params.slice(17, 22)).toEqual([null, null, null, null, null]);
    expect(log.warn).toHaveBeenCalledWith(
      "llm: composição do pedido não medida",
      expect.objectContaining({ organization_id: ORG, purpose: "checkpoint" }),
    );
  });

  it("o log da chamada leva passos e entrada do 1º passo — só números", async () => {
    const { log } = await rodar({});
    const concluida = log.info.mock.calls.find(([msg]) => msg === "llm: chamada concluída");
    expect(concluida![1]).toMatchObject({ passos: 2, entrada_do_primeiro_passo: 1000 });
  });
});
