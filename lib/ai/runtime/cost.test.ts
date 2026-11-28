/**
 * Custo de IA do runtime nativo (S-13.08, `lib/ai/runtime/cost.ts`).
 *
 * Issue #1931: ids do OpenRouter com ponto/variante (`anthropic/claude-haiku-4.5`,
 * sufixos `:beta`/`:free`) não casam a tabela, e o `return 0` do caminho de
 * preço desconhecido contava um modelo caro como "de graça". Este teste prova
 * os três caminhos exigidos:
 *
 *   1. id canônico casa (custo volta a ser contado);
 *   2. ponto/variante normaliza para o id canônico (custo volta a ser contado);
 *   3. custo desconhecido NÃO volta zero — volta `null`, que quem soma no teto
 *      coalesce para 0 mas quem reporta distingue de "grátis" (contrato do seam
 *      `pricing.ts` e da legacy `precoDoCatalogo`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  computeCostCents,
  normalizarModeloId,
  _resetRuntimeCostCacheForTests,
} from "@/lib/ai/runtime/cost";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

interface LinhaCatalogo {
  provider: string;
  model_id: string;
  input_price_per_million_cents: number | null;
  output_price_per_million_cents: number | null;
}

function adminComCatalogo(linhas: LinhaCatalogo[]) {
  return {
    from: () => ({
      select: () => Promise.resolve({ data: linhas, error: null }),
    }),
  };
}

const CATALOGO = [
  {
    provider: "anthropic",
    model_id: "claude-sonnet-5",
    input_price_per_million_cents: 200,
    output_price_per_million_cents: 1000,
  },
  {
    provider: "openrouter",
    model_id: "anthropic/claude-haiku-4-5",
    input_price_per_million_cents: 100,
    output_price_per_million_cents: 500,
  },
  {
    // Taxa por milhão do Haiku 5.5; o degrau acima de 100k é regra de cálculo
    // (#4123), não linha de catálogo — por isso a mesma linha serve aos dois.
    provider: "anthropic",
    model_id: "claude-haiku-5-5",
    input_price_per_million_cents: 100,
    output_price_per_million_cents: 500,
  },
] as LinhaCatalogo[];

beforeEach(() => {
  vi.mocked(createAdminClient).mockReset();
  _resetRuntimeCostCacheForTests();
});

describe("normalizarModeloId — o id chega em formas que a tabela não conhece", () => {
  it("id canônico bare passa intacto", () => {
    expect(normalizarModeloId("claude-sonnet-5")).toEqual(["claude-sonnet-5"]);
  });

  it("ponto na versão vira hífen — a grafia do catálogo", () => {
    expect(normalizarModeloId("anthropic/claude-haiku-4.5")).toContain(
      "anthropic/claude-haiku-4-5",
    );
    expect(normalizarModeloId("claude-haiku-4.5")).toContain("claude-haiku-4-5");
  });

  it("sufixo de variante do roteador é recortado", () => {
    expect(normalizarModeloId("anthropic/claude-haiku-4.5:beta:free")).toContain(
      "anthropic/claude-haiku-4-5",
    );
    // Só o primeiro candidato (o id cru) carrega o sufixo.
    const c = normalizarModeloId("anthropic/claude-haiku-4.5:beta:free");
    expect(c.slice(1).some((x) => x.includes(":"))).toBe(false);
  });

  it("candidatos saem do mais específico para o generalista — o exato vence", () => {
    // A ordem importa: o match tenta o primeiro. O listado mais específico é o
    // id CRU, com o sufixo, como chegou — `<m>:free` tem linha própria.
    const c = normalizarModeloId("anthropic/claude-haiku-4.5:free");
    expect(c[0]).toBe("anthropic/claude-haiku-4.5:free");
    expect(c[1]).toBe("anthropic/claude-haiku-4.5");
    expect(c).toContain("claude-haiku-4-5");
  });
});

describe("computeCostCents — três caminhos da issue #1931", () => {
  it("1) id canônico casa e o custo volta a ser contado", async () => {
    vi.mocked(createAdminClient).mockReturnValue(adminComCatalogo(CATALOGO) as never);
    const custo = await computeCostCents({
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    // 200 + 1000 centavos por milhão = 1200.
    expect(custo).toBe(1200);
  });

  it("2) ponto/variante normaliza para o canônico e o custo volta a ser contado", async () => {
    vi.mocked(createAdminClient).mockReturnValue(adminComCatalogo(CATALOGO) as never);
    const custo = await computeCostCents({
      provider: "openrouter",
      model: "anthropic/claude-haiku-4.5:beta",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    // O catálogo tem openrouter:anthropic/claude-haiku-4-5 (100/500) — 600.
    expect(custo).toBe(600);
  });

  it("2b) o fallback acha o id no catálogo de outro provider que divide o preço", async () => {
    // O mesmo `anthropic/claude-haiku-4-5` servido pela Requesty e pela
    // OpenRouter divide o preço; sem o fallback por id o match ficaria à mercê
    // do nome do provider guardado.
    vi.mocked(createAdminClient).mockReturnValue(
      adminComCatalogo([
        {
          provider: "requesty",
          model_id: "anthropic/claude-haiku-4-5",
          input_price_per_million_cents: 100,
          output_price_per_million_cents: 500,
        },
      ]) as never,
    );
    const custo = await computeCostCents({
      provider: "openrouter",
      model: "anthropic/claude-haiku-4-5",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(custo).toBe(600);
  });

  it("3) custo desconhecido NÃO volta zero — volta null, e não estoura o teto", async () => {
    vi.mocked(createAdminClient).mockReturnValue(adminComCatalogo(CATALOGO) as never);
    const custo = await computeCostCents({
      provider: "openrouter",
      model: "desconhecido/modelo-x:free",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    // null é o oposto de 0: quem soma no teto coalesce, mas não é "grátis".
    expect(custo).toBeNull();
    expect(custo).not.toBe(0);

    // E o budget guard do runtime: null não estoura o limite - o teto não leva
    // um número inventado que abortaria a chamada.
    const budget = 10;
    const estourou = custo !== null && custo > budget;
    expect(estourou).toBe(false);
  });

  it("catálogo que conhece o modelo mas não tem preço também é null, não 0", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminComCatalogo([
        {
          provider: "openrouter",
          model_id: "meta-llama/llama-3.3-70b-instruct",
          input_price_per_million_cents: null,
          output_price_per_million_cents: null,
        },
      ]) as never,
    );
    const custo = await computeCostCents({
      provider: "openrouter",
      model: "meta-llama/llama-3.3-70b-instruct",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(custo).toBeNull();
  });

  it("4) `<m>:free` com linha própria custa 0, e `<m>` segue custando o pago", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminComCatalogo([
        {
          provider: "openrouter",
          model_id: "meta-llama/llama-3.3-70b-instruct:free",
          input_price_per_million_cents: 0,
          output_price_per_million_cents: 0,
        },
        {
          provider: "openrouter",
          model_id: "meta-llama/llama-3.3-70b-instruct",
          input_price_per_million_cents: 13,
          output_price_per_million_cents: 40,
        },
      ]) as never,
    );
    const uso = { provider: "openrouter", inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(await computeCostCents({ ...uso, model: "meta-llama/llama-3.3-70b-instruct:free" })).toBe(0);
    expect(await computeCostCents({ ...uso, model: "meta-llama/llama-3.3-70b-instruct" })).toBe(53);
  });

  it("5) `:free` sem linha própria NÃO herda o preço do pago — nem pelo fallback de outro provider", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminComCatalogo([
        {
          provider: "openrouter",
          model_id: "anthropic/claude-haiku-4-5",
          input_price_per_million_cents: 100,
          output_price_per_million_cents: 500,
        },
        {
          provider: "requesty",
          model_id: "anthropic/claude-haiku-4.5",
          input_price_per_million_cents: 100,
          output_price_per_million_cents: 500,
        },
      ]) as never,
    );
    const custo = await computeCostCents({
      provider: "openrouter",
      model: "anthropic/claude-haiku-4.5:free",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(custo).toBeNull();
  });

  it("5b) `:free` com a linha paga SÓ sob outro provider também é null", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminComCatalogo([
        {
          provider: "requesty",
          model_id: "anthropic/claude-haiku-4-5",
          input_price_per_million_cents: 100,
          output_price_per_million_cents: 500,
        },
      ]) as never,
    );
    const custo = await computeCostCents({
      provider: "openrouter",
      model: "anthropic/claude-haiku-4.5:free",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(custo).toBeNull();
  });

  it("6) 0/0 é grátis de verdade: custa 0, não null", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminComCatalogo([
        {
          provider: "openrouter",
          model_id: "google/gemma-3-27b-it",
          input_price_per_million_cents: 0,
          output_price_per_million_cents: 0,
        },
      ]) as never,
    );
    const custo = await computeCostCents({
      provider: "openrouter",
      model: "google/gemma-3-27b-it",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(custo).toBe(0);
  });
});

/**
 * #4123 — o degrau do Haiku 5.5 (> 100 mil tokens de entrada = 5× pela chamada
 * inteira) é regra de CÁLCULO, num lugar só (`lib/ai/custo-escalonado.ts`).
 *
 * Taxa do Haiku 5.5 no catálogo de teste: 100/500 centavos por milhão — 100 mil
 * de entrada custam 10¢ e 10 mil de saída, 5¢.
 */
describe("computeCostCents — degrau do Claude Haiku 5.5 (#4123)", () => {
  const uso = { provider: "anthropic", inputTokens: 100_000, outputTokens: 10_000 };

  beforeEach(() => {
    vi.mocked(createAdminClient).mockReturnValue(adminComCatalogo(CATALOGO) as never);
  });

  it("até 100 mil tokens de entrada o preço é o de sempre", async () => {
    expect(await computeCostCents({ ...uso, model: "claude-haiku-5-5" })).toBe(15);
    // O limite é "acima de", não "a partir de": 100.000 exatos continuam 1×.
    expect(await computeCostCents({ ...uso, model: "claude-haiku-5-5", inputTokens: 100_000 })).toBe(15);
  });

  it("100.001 tokens de entrada: a chamada inteira (entrada + saída) custa 5×", async () => {
    const custo = await computeCostCents({ ...uso, model: "claude-haiku-5-5", inputTokens: 100_001 });
    // (100.001 × 100 + 10.000 × 500) / 1.000.000 = 15,0001¢ — × 5 = 75,0005¢.
    // Fracionado: arredondar aqui seria o defeito que o `Math.ceil` já pagou.
    expect(custo).toBeCloseTo(75.0005, 10);
    expect(custo).not.toBe(75);
  });

  it("modelo que não é Haiku 5.5 não multiplica acima de 100k", async () => {
    // Sonnet 5 (200/1000): 100.001 de entrada + 10.000 de saída = 30,0002¢.
    expect(
      await computeCostCents({ ...uso, provider: "anthropic", model: "claude-sonnet-5", inputTokens: 100_001 }),
    ).toBeCloseTo(30.0002, 10);
    // O Haiku 4.5 NÃO tem essa faixa: multiplicá-lo cobraria 5× a mais.
    expect(
      await computeCostCents({ ...uso, provider: "openrouter", model: "anthropic/claude-haiku-4-5", inputTokens: 100_001 }),
    ).toBeCloseTo(15.0001, 10);
  });

  it("as três grafias do id passam pelo degrau", async () => {
    const acima = { ...uso, inputTokens: 100_001 };
    for (const model of ["claude-haiku-5-5", "claude-haiku-5.5", "anthropic/claude-haiku-5.5:beta"]) {
      expect(await computeCostCents({ ...acima, model }), model).toBeCloseTo(75.0005, 10);
    }
  });
});

/**
 * #5239 — o degrau do Haiku 5.5 é por REQUISIÇÃO, não pelo total do turno.
 *
 * A Anthropic cobra 5× a requisição que passou de 100 mil tokens de entrada;
 * somar os passos antes de aplicar o fator cobrava 5× de um turno inteiro que
 * nunca teve uma requisição acima do limite. Taxa do catálogo de teste:
 * 100 centavos por milhão de entrada.
 */
describe("computeCostCents — degrau do Haiku 5.5 POR PASSO (#5239)", () => {
  const passo = (inputTokens: number) => ({ inputTokens, outputTokens: 0 });

  beforeEach(() => {
    vi.mocked(createAdminClient).mockReturnValue(adminComCatalogo(CATALOGO) as never);
  });

  it("3 passos de 40 mil somam 120 mil, mas nenhum passa do limite: custo 1×", async () => {
    const custo = await computeCostCents({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      inputTokens: 120_000,
      outputTokens: 0,
      steps: [passo(40_000), passo(40_000), passo(40_000)],
    });
    // 40.000 × 100 / 1.000.000 = 4¢ por passo; 3 × 4 = 12¢. O total agregado
    // (120 mil) aplicaria 5× e daria 60¢ — a cobrança a mais que a issue mediu.
    expect(custo).toBe(12);
  });

  it("um passo de 100.001 tokens paga 5× naquele passo, e só nele", async () => {
    const custo = await computeCostCents({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      inputTokens: 110_001,
      outputTokens: 0,
      steps: [passo(100_001), passo(10_000)],
    });
    // 10,0001¢ × 5 + 1¢ = 51,0005¢. Pelo total (110.001) seriam 55,0005¢:
    // 5× também sobre os 10 mil do passo curto.
    expect(custo).toBeCloseTo(51.0005, 10);
  });

  it("caso misto (40 mil + 100.001): só o passo acima do limite recebe 5×", async () => {
    const custo = await computeCostCents({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      inputTokens: 140_001,
      outputTokens: 0,
      steps: [passo(40_000), passo(100_001)],
    });
    // 4¢ (1×) + 10,0001¢ × 5 = 54,0005¢. Pelo total (140.001): 70,0005¢.
    expect(custo).toBeCloseTo(54.0005, 10);
  });

  it("40 mil + 70 mil somam 110 mil, mas nenhum passo passa do limite: 1×", async () => {
    const custo = await computeCostCents({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      inputTokens: 110_000,
      outputTokens: 0,
      steps: [passo(40_000), passo(70_000)],
    });
    // 4¢ + 7¢ = 11¢. Pelo total: 11¢ × 5 = 55¢. O limite é a requisição: 70
    // mil sozinho não chega a 100 mil, então não há passo a 5× neste turno.
    expect(custo).toBe(11);
  });

  it("sem `steps` o cálculo segue o total do turno, idêntico ao de hoje", async () => {
    // Mesmo turno de 120 mil sem passos: o comportamento antigo (5×) continua
    // valendo para quem ainda não passa `steps` — e `steps: []` também cai aqui.
    const semPassos = await computeCostCents({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      inputTokens: 120_000,
      outputTokens: 0,
    });
    const listaVazia = await computeCostCents({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      inputTokens: 120_000,
      outputTokens: 0,
      steps: [],
    });
    expect(semPassos).toBe(60);
    expect(listaVazia).toBe(60);
  });

  it("passo único concorda com o total — o caminho por passo não muda o preço", async () => {
    const semPassos = await computeCostCents({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      inputTokens: 100_001,
      outputTokens: 0,
    });
    const comPasso = await computeCostCents({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      inputTokens: 100_001,
      outputTokens: 0,
      steps: [passo(100_001)],
    });
    expect(semPassos).toBeCloseTo(50.0005, 10);
    expect(comPasso).toBe(semPassos);
  });
});
