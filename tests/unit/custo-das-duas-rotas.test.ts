/**
 * Issue #5171 — as duas rotas de custo do repo têm de concordar.
 *
 * `lib/ai/cost.ts` (`computeCost`, grava `llm_calls`) aplica `costCentsComVirada`
 * ANTES de ler a tabela: os ids com promoção datada (Gemini 3.5/3.6/3.7/3.8
 * Flash) cobram 75/375 centavos por milhão até o instante anterior a
 * 2027-01-01T00:00:00Z e 150/750 a partir dele.
 *
 * `lib/ai/runtime/cost.ts` (`computeCostCents`, grava `ai_agent_runs.cost_cents`)
 * lia SÓ `ai_models`, cuja linha desses ids já é a tarifa POSTERIOR à promoção —
 * então o mesmo turno saía 2× na coluna de custo de IA → Agentes → Execuções e
 * na soma de `fn_gasto_de_ia_do_mes`.
 *
 * A medida é feita nos MESMOS ids e nos DOIS lados do corte. Medir só o dia de
 * hoje viraria enfeite quando a promoção expirasse: o teste passaria a comparar
 * 150/750 com 150/750 sem nunca exercitar a virada.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAdminClient } from "@/lib/supabase/admin";
import { computeCost } from "@/lib/ai/cost";
import { computeCostCents, _resetRuntimeCostCacheForTests } from "@/lib/ai/runtime/cost";
import { precoDoModelo } from "@/lib/agent-engine/edge/llm/pricing";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const MILHAO = 1_000_000;

/** O corte que `PROMOCOES` declara para os Gemini Flash (`ateMs`). */
const CORTE_DA_PROMOCAO = new Date("2027-01-01T00:00:00.000Z");
const ANTES_DO_CORTE = new Date("2026-11-23T12:00:00.000Z");
const DEPOIS_DO_CORTE = new Date("2027-01-01T00:00:00.000Z");

/** Linhas de `ai_models` como o `baseline.sql` as entrega: tarifa de 2027. */
const CATALOGO = [
  { provider: "google", model_id: "gemini-3.5-flash", input_price_per_million_cents: 150, output_price_per_million_cents: 750 },
  { provider: "google", model_id: "gemini-3.6-flash", input_price_per_million_cents: 150, output_price_per_million_cents: 750 },
  { provider: "google", model_id: "gemini-3.8-flash", input_price_per_million_cents: 150, output_price_per_million_cents: 750 },
  { provider: "anthropic", model_id: "claude-haiku-5-5", input_price_per_million_cents: 10, output_price_per_million_cents: 50 },
];

/** Linhas de `ai_pricing`, a tabela da rota legada (mesmos números do motor). */
const TABELA_LEGADA = [
  { model: "gemini-3.5-flash", prompt_cents_per_million_tokens: 150, completion_cents_per_million_tokens: 750, embedding_cents_per_million_tokens: null },
  { model: "gemini-3.6-flash", prompt_cents_per_million_tokens: 150, completion_cents_per_million_tokens: 750, embedding_cents_per_million_tokens: null },
  { model: "gemini-3.8-flash", prompt_cents_per_million_tokens: 150, completion_cents_per_million_tokens: 750, embedding_cents_per_million_tokens: null },
  { model: "claude-haiku-5-5", prompt_cents_per_million_tokens: 10, completion_cents_per_million_tokens: 50, embedding_cents_per_million_tokens: null },
];

type Consulta = Promise<{ data: unknown[]; error: null }> & {
  select: () => Consulta;
  is: () => Consulta;
  in: () => Consulta;
  limit: () => Consulta;
};

/** PostgREST falso: o mesmo cliente responde `ai_models` e `ai_pricing`. */
function consulta(dados: unknown[]): Consulta {
  const base = Promise.resolve({ data: dados, error: null }) as Consulta;
  base.select = () => base;
  base.is = () => base;
  base.in = () => base;
  base.limit = () => base;
  return base;
}

function adminComAsDuasTabelas() {
  return {
    from: (tabela: string) => consulta(tabela === "ai_models" ? CATALOGO : TABELA_LEGADA),
  };
}

beforeEach(() => {
  vi.mocked(createAdminClient).mockReset();
  vi.mocked(createAdminClient).mockReturnValue(adminComAsDuasTabelas() as never);
  _resetRuntimeCostCacheForTests();
});

const IDS_EM_PROMOCAO = ["gemini-3.5-flash", "gemini-3.6-flash", "gemini-3.8-flash"];

describe("o corte da promoção do Gemini Flash", () => {
  it.each(IDS_EM_PROMOCAO)("%s: a tarifa do motor vira exatamente no corte", (id) => {
    // A promoção vale até o instante ANTERIOR ao corte; nele, a tarifa da tabela
    // passa a valer. Se `PROMOCOES` mudar de data, este caso avisa antes de os
    // outros dois virarem decoração.
    expect(precoDoModelo(id, new Date(CORTE_DA_PROMOCAO.getTime() - 1))?.input).toBe(0.75);
    expect(precoDoModelo(id, CORTE_DA_PROMOCAO)?.input).toBe(1.5);
  });
});

describe.each([
  { instante: "antes do corte (23/11/2026)", em: ANTES_DO_CORTE, centavos: 450 },
  { instante: "no corte (01/01/2027T00:00Z)", em: DEPOIS_DO_CORTE, centavos: 900 },
])("1M de entrada + 1M de saída, $instante", ({ em, centavos }) => {
  it.each(IDS_EM_PROMOCAO)("%s: a rota do runtime cobra o mesmo que a rota legada", async (id) => {
    const legado = await computeCost({
      model: id,
      promptTokens: MILHAO,
      completionTokens: MILHAO,
      em,
    });
    const runtime = await computeCostCents({
      provider: "google",
      model: id,
      inputTokens: MILHAO,
      outputTokens: MILHAO,
      em,
    });

    expect(legado).toBe(centavos);
    expect(runtime).not.toBeNull();
    // A asserção que discrimina: as duas rotas, mesmo uso, mesmo instante.
    expect(runtime).toBeCloseTo(legado as number, 6);
  });
});

describe("o degrau do Haiku 5.5 continua valendo na rota do runtime", () => {
  it("acima de 100k de entrada a chamada inteira custa 5× nas duas rotas", async () => {
    const uso = { inputTokens: 200_000, outputTokens: 0 };
    const legado = await computeCost({
      model: "claude-haiku-5-5",
      promptTokens: uso.inputTokens,
      completionTokens: uso.outputTokens,
      em: ANTES_DO_CORTE,
    });
    const runtime = await computeCostCents({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      ...uso,
      em: ANTES_DO_CORTE,
    });

    // 200k × 10¢/1M = 2¢, ×5 (degrau) = 10¢ — o eixo escalonado não pode sumir.
    expect(runtime).toBeCloseTo(10, 6);
    expect(runtime).toBeCloseTo(legado as number, 6);
  });
});
