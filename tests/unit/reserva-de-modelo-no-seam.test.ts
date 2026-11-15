/**
 * A reserva de modelo passando pelo `runModelCall` de verdade (#4600).
 *
 * Os testes da política (`reserva-de-modelo-configuravel.test.ts`) provam a
 * decisão. Este prova o seam: o principal falha por cota, a reserva assume com
 * o provedor, o modelo e o endereço DELA, e a reserva respeita a lista de
 * modelos que a empresa liberou.
 */
import { describe, expect, it, vi } from "vitest";
import { APICallError } from "ai";

vi.mock("@/lib/crypto/aes_gcm", () => ({
  byteaToBuffer: () => Buffer.from(""),
  decryptKey: () => "chave-da-empresa",
}));

import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";

const ORG = "11111111-1111-4111-8111-111111111111";
const ENDERECO_DO_PONTO = "https://gateway.do-principal.exemplo/v1";
const RESERVA = { provider: "anthropic", model: "claude-reserva-1" };

function poolFalso(opts: { enabledModels: string[] }) {
  const consultas: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    consultas.push({ sql, params });
    if (sql.includes("settings->'llm'")) {
      return {
        rows: [
          {
            llm: {
              provider: "anthropic",
              default_model: "claude-padrao-da-org",
              params: {},
              enabled_models: opts.enabledModels,
            },
          },
        ],
      };
    }
    if (sql.includes("from ai_purpose_bindings")) {
      return {
        rows: [
          {
            purpose: "stage_classifier",
            provider: "openrouter",
            credential_id: null,
            model_id: "acme/principal-1",
            base_url: ENDERECO_DO_PONTO,
            is_enabled: true,
          },
        ],
      };
    }
    if (sql.includes("from ai_provider_credentials")) {
      return { rows: [{ api_key_encrypted: "x", api_key_iv: "y", api_key_tag: "z" }] };
    }
    if (sql.includes("insert into llm_calls")) return { rows: [{ id: "call-1" }] };
    return { rows: [] };
  });
  return { pool: { query } as never, consultas };
}

/** O principal (openrouter) estoura a cota; a reserva (anthropic) responde. */
function registry() {
  const chamadas: Array<{ provider: string; modelId: string; baseUrl: string | undefined }> = [];
  const fabrica = (provider: string, falha: boolean) => (_apiKey: string, modelId: string, baseUrl?: string) => {
    chamadas.push({ provider, modelId, baseUrl });
    return {
      specificationVersion: "v3",
      provider,
      modelId,
      doGenerate: async () => {
        if (falha) {
          // Não retentável: o SDK não repete e o seam recebe o erro cru.
          // O caso embrulhado (RetryError) está em reserva-de-modelo-erro-embrulhado.
          throw new APICallError({
            message: "Rate limit exceeded",
            url: `${baseUrl ?? "https://api.exemplo"}/chat/completions`,
            requestBodyValues: {},
            statusCode: 429,
            isRetryable: false,
          });
        }
        return {
          content: [{ type: "text", text: "resposta da reserva" }],
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        };
      },
    } as never;
  };
  return {
    chamadas,
    registry: { openrouter: fabrica("openrouter", true), anthropic: fabrica("anthropic", false) },
  };
}

const cfg = {
  anthropicApiKey: "chave-anthropic-da-instalacao",
  openrouterApiKey: "chave-openrouter-da-instalacao",
  cacheTtl: "1h" as const,
};

function chamar(enabledModels: string[]) {
  const { pool, consultas } = poolFalso({ enabledModels });
  const { registry: reg, chamadas } = registry();
  const execucao = runModelCall(
    pool,
    cfg,
    {
      tenantId: ORG,
      purpose: "stage_classifier",
      messages: [{ role: "user", content: "oi" }],
      llmOverride: { reservaDeModelo: RESERVA },
    },
    { registry: reg, agora: new Date("2026-11-15T12:00:00.000Z") },
  );
  return { execucao, consultas, chamadas };
}

describe("a reserva de modelo no seam", () => {
  it("o principal estoura a cota e a reserva responde com o modelo dela", async () => {
    const { execucao, chamadas } = chamar([]);
    const r = await execucao;
    expect(r.result.text).toBe("resposta da reserva");
    expect(chamadas.map((c) => c.provider)).toEqual(["openrouter", "anthropic"]);
    expect(chamadas[1]!.modelId).toBe("claude-reserva-1");
    // A linha de llm_calls e a tela de Execuções dizem de onde veio a resposta.
    expect(r.provider).toBe("anthropic");
    expect(r.model).toBe("claude-reserva-1");
    expect(r.origem).toBe("reserva_do_modelo");
  });

  it("a reserva NÃO herda o endereço do ponto do principal", async () => {
    const { execucao, chamadas } = chamar([]);
    await execucao;
    expect(chamadas[0]!.baseUrl).toBe(ENDERECO_DO_PONTO);
    expect(chamadas[1]!.baseUrl).not.toBe(ENDERECO_DO_PONTO);
  });

  it("reserva fora da lista de modelos liberados não é chamada, e o erro original sobe", async () => {
    const { execucao, chamadas } = chamar(["acme/principal-1"]);
    await expect(execucao).rejects.toThrow(/Rate limit exceeded/);
    expect(chamadas.map((c) => c.provider)).toEqual(["openrouter"]);
  });
});
