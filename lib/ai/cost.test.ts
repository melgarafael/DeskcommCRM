/**
 * #4123 — o degrau do Claude Haiku 5.5 na rota LEGADA de custo
 * (`lib/ai/cost.ts`, a que grava `llm_calls.cost_cents` pelo `ai_pricing` e pelo
 * catálogo).
 *
 * A regra é uma só, em `lib/ai/custo-escalonado.ts`, e é a MESMA que o runtime
 * nativo aplica (`computeCostCents`, `lib/ai/runtime/cost.ts`). Este teste prova
 * as duas coisas que a divergência quebraria em silêncio:
 *
 *   1. a rota legada aplica o degrau (o custo estimado do painel é somado daqui);
 *   2. as duas rotas devolvem o MESMO número para o mesmo uso — se alguém
 *      copiar a regra para um dos lados, esta igualdade cai.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAdminClient } from "@/lib/supabase/admin";
import { computeCost, _resetPricingCacheForTests } from "@/lib/ai/cost";
import { computeCostCents, _resetRuntimeCostCacheForTests } from "@/lib/ai/runtime/cost";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

interface LinhaDoCatalogo {
  model_id: string;
  input_price_per_million_cents: number | null;
  output_price_per_million_cents: number | null;
}

interface ConsultaFalsa {
  select: (...args: unknown[]) => ConsultaFalsa;
  is: (...args: unknown[]) => ConsultaFalsa;
  in: (...args: unknown[]) => ConsultaFalsa;
  limit: (...args: unknown[]) => ConsultaFalsa;
  then: (resolve: (valor: { data: unknown[]; error: null }) => unknown) => unknown;
}

/**
 * Cliente falso: as duas consultas de preço (a tabela `ai_pricing` e o catálogo
 * `ai_models`) devolvem o que estiver no mapa e todo encadeamento devolve a si
 * mesmo — é assim que o PostgREST se comporta para quem só espera o resultado.
 */
function adminFalso(tabelas: Record<string, unknown[]>) {
  return {
    from: (tabela: string): ConsultaFalsa => {
      const linhas = tabelas[tabela] ?? [];
      const consulta = {} as ConsultaFalsa;
      const encadeia = () => consulta;
      consulta.select = encadeia;
      consulta.is = encadeia;
      consulta.in = encadeia;
      consulta.limit = encadeia;
      consulta.then = (resolve) => Promise.resolve({ data: linhas, error: null as null }).then(resolve);
      return consulta;
    },
  };
}

/** Catálogo de teste: 100/500 centavos por milhão, como o do runtime. */
const CATALOGO: Record<string, unknown[]> = {
  ai_pricing: [],
  ai_models: [
    {
      model_id: "claude-haiku-5-5",
      input_price_per_million_cents: 100,
      output_price_per_million_cents: 500,
    },
    {
      model_id: "claude-sonnet-5",
      input_price_per_million_cents: 200,
      output_price_per_million_cents: 1000,
    },
  ] satisfies LinhaDoCatalogo[],
};

beforeEach(() => {
  vi.mocked(createAdminClient).mockReset();
  vi.mocked(createAdminClient).mockReturnValue(adminFalso(CATALOGO) as never);
  _resetPricingCacheForTests();
  _resetRuntimeCostCacheForTests();
});

describe("computeCost — degrau do Claude Haiku 5.5 (#4123)", () => {
  it("até 100 mil tokens de entrada cobra o preço de sempre", async () => {
    const cents = await computeCost({
      model: "claude-haiku-5-5",
      promptTokens: 100_000,
      completionTokens: 10_000,
    });
    expect(cents).toBe(15); // 10 de entrada + 5 de saída
  });

  it("100.001 tokens de entrada multiplicam a chamada inteira por 5", async () => {
    const cents = await computeCost({
      model: "claude-haiku-5-5",
      promptTokens: 100_001,
      completionTokens: 10_000,
    });
    expect(cents).toBeCloseTo(75.0005, 10);
    // Fracionado: nenhum arredondamento por chamada foi introduzido junto.
    expect(cents).not.toBe(75);
  });

  it("o degrau vale para as três grafias do id", async () => {
    for (const model of ["claude-haiku-5-5", "claude-haiku-5.5", "anthropic/claude-haiku-5.5:beta"]) {
      expect(
        await computeCost({ model, promptTokens: 100_001, completionTokens: 10_000 }),
        model,
      ).toBeCloseTo(75.0005, 10);
    }
  });

  it("modelo fora da família (Sonnet 5) acima de 100k não multiplica", async () => {
    const cents = await computeCost({
      model: "claude-sonnet-5",
      promptTokens: 100_001,
      completionTokens: 10_000,
    });
    expect(cents).toBeCloseTo(30.0002, 10);
  });

  it("as duas rotas de custo devolvem o MESMO número para o mesmo uso", async () => {
    for (const promptTokens of [1_000, 100_000, 100_001, 250_000]) {
      const legado = await computeCost({
        model: "claude-haiku-5-5",
        promptTokens,
        completionTokens: 2_000,
      });
      const runtime = await computeCostCents({
        provider: "anthropic",
        model: "claude-haiku-5-5",
        inputTokens: promptTokens,
        outputTokens: 2_000,
      });
      expect(legado, `promptTokens=${promptTokens}`).toBeCloseTo(runtime as number, 10);
    }
  });

  it("a linha do `ai_pricing` também passa pelo degrau", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminFalso({
        ai_pricing: [
          {
            model: "claude-haiku-5-5",
            prompt_cents_per_million_tokens: 100,
            completion_cents_per_million_tokens: 500,
            embedding_cents_per_million_tokens: null,
          },
        ],
        ai_models: [],
      }) as never,
    );
    _resetPricingCacheForTests();
    expect(
      await computeCost({ model: "claude-haiku-5-5", promptTokens: 100_000, completionTokens: 10_000 }),
    ).toBe(15);
    _resetPricingCacheForTests();
    expect(
      await computeCost({ model: "claude-haiku-5-5", promptTokens: 100_001, completionTokens: 10_000 }),
    ).toBeCloseTo(75.0005, 10);
  });
});
