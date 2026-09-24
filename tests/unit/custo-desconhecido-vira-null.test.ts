/**
 * CUSTO DESCONHECIDO VIRA NULL — NUNCA 0.
 *
 * ## O defeito medido
 * `computeCost` (`lib/ai/cost.ts`) e `computeCostCents`
 * (`lib/ai/runtime/cost.ts`) devolviam 0 quando o modelo não tinha preço no
 * catálogo. Zero significa "de graça"; desconhecido significa "não sei".
 * Confundir os dois fazia a tela de Execuções mostrar R$ 0,00 enquanto o
 * dinheiro saía, e fazia o budget guard do runtime deixar passar como grátis
 * um modelo novo que o catálogo ainda não conhece.
 *
 * ## O que este arquivo prova
 * 1. `computeCost` devolve `null` (não 0) quando o modelo não está em
 *    `ai_pricing` nem no catálogo `ai_models`.
 * 2. `computeCost` devolve `null` quando o catálogo conhece o modelo mas não
 *    tem preço para ele.
 * 3. `computeCostCents` devolve `null` (não 0) quando o modelo não está no
 *    catálogo, e quando o catálogo não tem preço.
 * 4. `computeCost`/`computeCostCents` continuam devolvendo número real quando
 *    há preço — `null` é só para desconhecido, não para tudo.
 * 5. `finalizeRun` grava `null` (não 0) no evento e no audit quando o custo é
 *    desconhecido.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { computeCost, _resetPricingCacheForTests } from "@/lib/ai/cost";
import { computeCostCents, _resetRuntimeCostCacheForTests } from "@/lib/ai/runtime/cost";
import { finalizeRun } from "@/lib/ai/runtime/finalize";

const adminMock = vi.mocked(createAdminClient);

function tabelaRetorna(data: unknown) {
  // Cadeia de query builder: from().select().is() / .in().is().limit()
  const final = { data, error: null };
  const comLimit = { limit: vi.fn(async () => final) };
  // Para ai_models: .in().is().limit()
  const comIn = { in: vi.fn(() => ({ is: vi.fn(() => comLimit) })) };
  return {
    from: vi.fn((tabela: string) => ({
      select: vi.fn(() => {
        if (tabela === "ai_models") return comIn;
        return { is: vi.fn(async () => final) };
      }),
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetPricingCacheForTests();
  _resetRuntimeCostCacheForTests();
});

describe("computeCost (legado)", () => {
  it("devolve null — não 0 — quando o modelo não está em ai_pricing nem no catálogo", async () => {
    adminMock.mockReturnValue(tabelaRetorna([]) as never);
    const custo = await computeCost({
      model: "provedor/modelo-novo-sem-preco",
      promptTokens: 1000,
      completionTokens: 500,
    });
    expect(custo).toBeNull();
  });

  it("devolve null quando o catálogo conhece o modelo mas não tem preço", async () => {
    adminMock.mockImplementation(
      (() => ({
        from: (tabela: string) => ({
          select: vi.fn(() => {
            if (tabela === "ai_models") {
              return {
                in: vi.fn(() => ({
                  is: vi.fn(() => ({
                    limit: vi.fn(async () => ({
                      data: [
                        {
                          model_id: "provedor/modelo-sem-preco",
                          input_price_per_million_cents: null,
                          output_price_per_million_cents: null,
                        },
                      ],
                      error: null,
                    })),
                  })),
                })),
              };
            }
            return { is: vi.fn(async () => ({ data: [], error: null })) };
          }),
        }),
      })) as never,
    );
    const custo = await computeCost({
      model: "provedor/modelo-sem-preco",
      promptTokens: 1000,
      completionTokens: 500,
    });
    expect(custo).toBeNull();
  });

  it("continua devolvendo número real quando há preço no catálogo", async () => {
    adminMock.mockImplementation(
      (() => ({
        from: (tabela: string) => ({
          select: vi.fn(() => {
            if (tabela === "ai_models") {
              return {
                in: vi.fn(() => ({
                  is: vi.fn(() => ({
                    limit: vi.fn(async () => ({
                      data: [
                        {
                          model_id: "provedor/modelo-com-preco",
                          input_price_per_million_cents: 300,
                          output_price_per_million_cents: 1500,
                        },
                      ],
                      error: null,
                    })),
                  })),
                })),
              };
            }
            return { is: vi.fn(async () => ({ data: [], error: null })) };
          }),
        }),
      })) as never,
    );
    const custo = await computeCost({
      model: "provedor/modelo-com-preco",
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    expect(custo).toBe(1800);
  });
});

describe("computeCostCents (runtime)", () => {
  it("devolve null — não 0 — quando o modelo não está no catálogo", async () => {
    adminMock.mockReturnValue(tabelaRetorna([]) as never);
    const custo = await computeCostCents({
      provider: "provedor",
      model: "modelo-novo",
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(custo).toBeNull();
  });

  it("devolve null quando o catálogo não tem preço para o modelo", async () => {
    adminMock.mockReturnValue(
      {
        from: vi.fn(() => ({
          select: vi.fn(async () => ({
            data: [
              {
                provider: "provedor",
                model_id: "modelo-sem-preco",
                input_price_per_million_cents: null,
                output_price_per_million_cents: null,
              },
            ],
            error: null,
          })),
        })),
      } as never,
    );
    const custo = await computeCostCents({
      provider: "provedor",
      model: "modelo-sem-preco",
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(custo).toBeNull();
  });

  it("continua devolvendo número real quando há preço", async () => {
    adminMock.mockReturnValue(
      {
        from: vi.fn(() => ({
          select: vi.fn(async () => ({
            data: [
              {
                provider: "provedor",
                model_id: "modelo-com-preco",
                input_price_per_million_cents: 300,
                output_price_per_million_cents: 1500,
              },
            ],
            error: null,
          })),
        })),
      } as never,
    );
    const custo = await computeCostCents({
      provider: "provedor",
      model: "modelo-com-preco",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(custo).toBe(1800);
  });
});

describe("finalizeRun", () => {
  it("grava null — não 0 — no evento e no audit quando o custo é desconhecido", async () => {
    let payloadDoEvento: Record<string, unknown> | undefined;
    adminMock.mockReturnValue(
      {
        from: vi.fn(() => ({
          update: vi.fn(() => ({
            eq: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })),
          })),
        })),
        rpc: vi.fn(async (_fn: string, args: Record<string, unknown>) => {
          payloadDoEvento = args.p_payload as Record<string, unknown>;
          return { data: null, error: null };
        }),
      } as never,
    );
    await finalizeRun({
      runId: "run-1",
      organizationId: "org-1",
      status: "completed",
      costCents: null,
    });
    expect(payloadDoEvento?.cost_cents).toBeNull();
    const auditMock = vi.mocked(audit);
    expect(auditMock).toHaveBeenCalled();
    const metadata = (auditMock.mock.calls[0]?.[0]?.metadata ?? {}) as Record<string, unknown>;
    expect(metadata.cost_cents).toBeNull();
  });

  it("grava 0 quando o custo é genuinamente zero (nenhuma chamada ao provedor)", async () => {
    let payloadDoEvento: Record<string, unknown> | undefined;
    adminMock.mockReturnValue(
      {
        from: vi.fn(() => ({
          update: vi.fn(() => ({
            eq: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })),
          })),
        })),
        rpc: vi.fn(async (_fn: string, args: Record<string, unknown>) => {
          payloadDoEvento = args.p_payload as Record<string, unknown>;
          return { data: null, error: null };
        }),
      } as never,
    );
    await finalizeRun({
      runId: "run-1",
      organizationId: "org-1",
      status: "handoff",
      costCents: 0,
    });
    expect(payloadDoEvento?.cost_cents).toBe(0);
  });
});
