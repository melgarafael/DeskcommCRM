// O PAINEL DE PREVISÃO EM MÉTRICAS ESCREVE O VALOR NA RÉGUA DO NEGÓCIO (#1732).
//
// `ponderado_cents` e `bruto_cents` saem de `crm_leads.value_cents`
// (`lib/leads/previsao.ts`), que guarda o valor ×100 em QUALQUER moeda.
// `formatCents` lê unidades menores da moeda — e o guarani não tem subunidade,
// então o painel mostrava ₲125.000 como "Gs. 12.500.000". É o mesmo defeito que
// o #1727 (@jmpo) consertou no total da coluna do funil, com a mesma ponte:
// `formatValorDoNegocio`.
//
// Voltar a `formatCents` no painel faz este arquivo ficar vermelho.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PrevisaoDoFunil } from "@/hooks/metrics/usePrevisaoFunil";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

let dados: PrevisaoDoFunil;
vi.mock("@/hooks/metrics/usePrevisaoFunil", () => ({
  usePrevisaoFunil: () => ({ data: dados, isLoading: false, isError: false }),
}));

import { PrevisaoPanel } from "@/app/app/metrics/_components/PrevisaoPanel";

/** Os espaços que o `Intl` emite são NBSP (U+00A0) ou narrow NBSP (U+202F). */
const semNbsp = (s: string) => s.replace(/[\u00A0\u202F]/g, " ");

function previsao(moeda: string, bruto: number, ponderado: number): PrevisaoDoFunil {
  const balde = { moeda, bruto_cents: bruto, ponderado_cents: ponderado, n: 2 };
  return {
    pipeline_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    fonte: "etapa",
    meses: [{ ...balde, mes: "2026-10" }],
    totais: [balde],
    sem_data: [balde],
    sem_probabilidade: [balde],
  };
}

describe("painel de previsão em Métricas", () => {
  it("⭐ em guarani: ₲250.000 brutos e ₲125.000 ponderados, não cem vezes mais", () => {
    // 25.000.000 na régua do negócio = ₲250.000 (dois pedidos de ₲125.000).
    dados = previsao("PYG", 25_000_000, 12_500_000);
    render(<PrevisaoPanel />);

    const linha = screen.getByText("2026-10").closest("tr");
    const celulas = Array.from(linha?.querySelectorAll("td") ?? []).map((td) =>
      semNbsp(td.textContent ?? ""),
    );
    expect(celulas).toEqual(["2026-10", "PYG", "Gs. 125.000", "Gs. 250.000", "2"]);

    // Os dois baldes de fora do cronograma usam a mesma régua.
    const texto = semNbsp(document.body.textContent ?? "");
    expect(texto).toContain("PYG: Gs. 125.000 · bruto Gs. 250.000 · 2 negócios");
    expect(texto).toContain("PYG: Gs. 250.000 · 2 negócios");
    expect(texto).not.toContain("12.500.000");
    expect(texto).not.toContain("25.000.000");
  });

  it("em real continua saindo em real, com centavos", () => {
    dados = previsao("BRL", 24_990, 12_495);
    render(<PrevisaoPanel />);

    const texto = semNbsp(document.body.textContent ?? "");
    expect(texto).toContain("BRL: R$ 124,95 · bruto R$ 249,90 · 2 negócios");
  });
});
