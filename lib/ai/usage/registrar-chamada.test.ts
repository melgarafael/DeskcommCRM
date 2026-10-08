/**
 * `registrarChamadaDeIa` grava no MESMO formato de `logInvocation` (colunas,
 * provedor, código de erro) e nunca lança.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registrarChamadaDeIa } from "@/lib/ai/usage/registrar-chamada";
import { logger } from "@/lib/logger";

const ORG = "11111111-1111-4111-8111-111111111111";

function adminQueGrava(resposta: { error: { message: string } | null } = { error: null }) {
  const linhas: Array<{ tabela: string; row: Record<string, unknown> }> = [];
  const admin = {
    from: (tabela: string) => ({
      insert: async (row: Record<string, unknown>) => {
        linhas.push({ tabela, row });
        return resposta;
      },
    }),
  };
  return { admin: admin as never, linhas };
}

beforeEach(() => vi.clearAllMocks());

describe("registrarChamadaDeIa", () => {
  it("grava em llm_calls com as colunas de logInvocation", async () => {
    const { admin, linhas } = adminQueGrava();
    await registrarChamadaDeIa(admin, {
      organization_id: ORG,
      agent_id: "",
      purpose: "visao_de_imagem",
      model: "openai/gpt-4o-mini",
      input_tokens: 120.4,
      output_tokens: 30,
      cost_cents: 0.25,
      latency_ms: 812.6,
    });
    expect(linhas).toEqual([
      {
        tabela: "llm_calls",
        row: {
          organization_id: ORG,
          // `""` vira null — a mesma rede da issue #160.
          agent_id: null,
          contact_id: null,
          purpose: "visao_de_imagem",
          // Sem provider explícito, a régua de `logInvocation`.
          provider: "openai",
          model: "openai/gpt-4o-mini",
          input_tokens: 120,
          output_tokens: 30,
          cost_cents: 0.25,
          latency_ms: 813,
          status: "ok",
          error_code: null,
          error_message: null,
        },
      },
    ]);
  });

  it("falha vira status erro com o código canônico do motor", async () => {
    const { admin, linhas } = adminQueGrava();
    await registrarChamadaDeIa(admin, {
      organization_id: ORG,
      purpose: "transcricao_de_audio",
      provider: "openai",
      model: "whisper-1",
      input_tokens: 0,
      output_tokens: 0,
      cost_cents: 0,
      latency_ms: 10,
      erro: { message: "Incorrect API key provided", status: 401 },
    });
    const row = linhas[0]!.row;
    expect(row.status).toBe("erro");
    expect(row.error_message).toBe("Incorrect API key provided");
    expect(typeof row.error_code).toBe("string");
    expect(row.error_code).not.toBe("");
  });

  it("insert recusado pelo banco loga e não lança", async () => {
    const { admin } = adminQueGrava({ error: { message: "violates check" } });
    await expect(
      registrarChamadaDeIa(admin, {
        organization_id: ORG,
        purpose: "visao_de_imagem",
        model: "x",
        input_tokens: 0,
        output_tokens: 0,
        cost_cents: null,
        latency_ms: 0,
      }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("admin que lança não propaga", async () => {
    const admin = {
      from: () => {
        throw new Error("sem banco");
      },
    } as never;
    await expect(
      registrarChamadaDeIa(admin, {
        organization_id: ORG,
        purpose: "visao_de_imagem",
        model: "x",
        input_tokens: 0,
        output_tokens: 0,
        cost_cents: null,
        latency_ms: 0,
      }),
    ).resolves.toBeUndefined();
  });
});
