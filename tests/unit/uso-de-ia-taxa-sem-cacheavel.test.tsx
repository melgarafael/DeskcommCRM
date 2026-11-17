/**
 * O cartão "Taxa de cache" sem chamada cacheável no recorte (#4362, prova de
 * tela do #4585, item 3).
 *
 * A régua do agregado devolve `cache_hit_rate = 0` quando o denominador é zero.
 * Na tela, porém, "0%" leria como "o cache está quebrado", e esse é justamente
 * o falso alarme que o #4362 tira da tela. Com `cacheable_invocations = 0`, o
 * cartão mostra "—" e diz por quê. Com chamada cacheável, mostra a porcentagem.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const uso = vi.hoisted(() => ({ totals: {} as Record<string, number | null> }));

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/components/ai/UsageFilters", () => ({ UsageFilters: () => null }));
vi.mock("@/components/ai/UsageChart", () => ({ UsageChart: () => null }));
vi.mock("@/hooks/ai/useAiUsage", () => ({
  useAiUsage: () => ({
    isLoading: false,
    data: {
      range: { from: "2026-11-01", to: "2026-11-15" },
      totals: uso.totals,
      series: { cost_cents: [], total_tokens: [], p50_latency_ms: [] },
      by_kind: {},
    },
  }),
}));

import { UsageDashboardClient } from "@/app/app/ai/usage/_client";

function totais(over: Record<string, number | null>): Record<string, number | null> {
  return {
    cost_cents: 8,
    total_tokens: 1000,
    invocations: 318,
    input_tokens: 254400,
    cache_read_tokens: 0,
    cache_hit_rate: 0,
    cacheable_input_tokens: 0,
    cacheable_cache_read_tokens: 0,
    cacheable_invocations: 0,
    agent_turns: 0,
    avg_cost_per_turn_cents: null,
    p50_latency_ms: 800,
    p95_latency_ms: 1500,
    handoff_rate: 0,
    ...over,
  };
}

function cartaoDaTaxa(): HTMLElement {
  const rotulo = screen.getByText("Taxa de cache");
  // O rótulo é o primeiro <p> do StatCard: o pai dele é o cartão inteiro, e
  // nada dos cartões vizinhos (o "0.00%" da passagem) entra na conferência.
  const cartao = rotulo.parentElement;
  expect(cartao).toBeTruthy();
  return cartao as HTMLElement;
}

describe("cartão Taxa de cache sem chamada cacheável (#4362)", () => {
  it("sem chamada cacheável no recorte, mostra '—' e não '0%'", () => {
    uso.totals = totais({ cacheable_invocations: 0, cache_hit_rate: 0 });
    render(<UsageDashboardClient agents={[]} initial={{}} />);

    const cartao = cartaoDaTaxa();
    expect(cartao).toHaveTextContent("—");
    expect(cartao).not.toHaveTextContent("0%");
    expect(cartao).toHaveTextContent(
      "nenhuma chamada no período passa do tamanho que o provedor guarda em cache",
    );
  });

  it("controle: com chamada cacheável, mostra a porcentagem", () => {
    uso.totals = totais({ cacheable_invocations: 10, cache_hit_rate: 0.5 });
    render(<UsageDashboardClient agents={[]} initial={{}} />);

    const cartao = cartaoDaTaxa();
    expect(cartao).toHaveTextContent("50%");
    expect(cartao).not.toHaveTextContent("—");
  });
});
