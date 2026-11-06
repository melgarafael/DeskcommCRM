// O PAINEL DE PREVISÃO EM MÉTRICAS ESCREVE O VALOR NA RÉGUA DO NEGÓCIO (#1732)
// E MOSTRA ÚNICO E RECORRÊNCIA EM COLUNAS SEPARADAS (#3602, fatia 2).
//
// `ponderado_cents` e `bruto_cents` saem de `crm_leads.value_cents`
// (`lib/leads/previsao.ts`), que guarda o valor ×100 em QUALQUER moeda.
// `formatCents` lê unidades menores da moeda — e o guarani não tem subunidade,
// então o painel mostrava ₲125.000 como "Gs. 12.500.000". É o mesmo defeito que
// o #1727 (@jmpo) consertou no total da coluna do funil, com a mesma ponte:
// `formatValorDoNegocio`.
//
// A partir da fatia 2 da #3602 cada balde traz `unico` e `recorrente_mensal`; o
// painel mostra as duas em colunas próprias e NUNCA a soma delas — há um caso
// abaixo que falha se alguém voltar a somar (3.500 apareceria).
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

/** As duas parcelas de um balde; a recorrência é zerada quando não há. */
function parcelas(bruto: number, ponderado: number, n: number, recorrente = 0, recPonderado = 0, recN = 0) {
  return {
    unico: { bruto_cents: bruto, ponderado_cents: ponderado, n },
    recorrente_mensal: {
      bruto_cents: recorrente,
      ponderado_cents: recPonderado,
      n: recN,
    },
  };
}

function previsao(moeda: string, bruto: number, ponderado: number): PrevisaoDoFunil {
  const balde = { moeda, bruto_cents: bruto, ponderado_cents: ponderado, n: 2, ...parcelas(bruto, ponderado, 2) };
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
    // Colunas: mês, moeda, ÚNICO (ponderado + bruto), RECORRÊNCIA/MÊS
    // (ponderado + bruto) e negócios — as duas parcelas nunca somadas.
    expect(celulas).toEqual([
      "2026-10",
      "PYG",
      "Gs. 125.000 Gs. 250.000",
      "Gs. 0 Gs. 0",
      "2",
    ]);

    // Os dois baldes de fora do cronograma usam a mesma régua.
    const texto = semNbsp(document.body.textContent ?? "");
    expect(texto).toContain("PYG · 2 negócios");
    expect(texto).toContain(
      "Único: Gs. 125.000 (bruto Gs. 250.000) · Recorrência/mês: Gs. 0 (bruto Gs. 0)",
    );
    expect(texto).toContain("Único: Gs. 250.000 · Recorrência/mês: Gs. 0");
    expect(texto).not.toContain("12.500.000");
    expect(texto).not.toContain("25.000.000");
  });

  it("em real continua saindo em real, com centavos", () => {
    dados = previsao("BRL", 24_990, 12_495);
    render(<PrevisaoPanel />);

    const texto = semNbsp(document.body.textContent ?? "");
    expect(texto).toContain(
      "Único: R$ 124,95 (bruto R$ 249,90) · Recorrência/mês: R$ 0,00 (bruto R$ 0,00)",
    );
  });

  it("setup + mensalidade aparecem lado a lado, sem a soma (3.500 não existe)", () => {
    // 3.000 de setup + 500/mês de recorrência, ambos ponderados a 50%.
    const balde = {
      moeda: "BRL",
      bruto_cents: 300_000,
      ponderado_cents: 150_000,
      n: 2,
      ...parcelas(300_000, 150_000, 2, 50_000, 25_000, 1),
    };
    dados = {
      pipeline_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      fonte: "etapa",
      meses: [{ ...balde, mes: "2026-11" }],
      totais: [balde],
      sem_data: [],
      sem_probabilidade: [],
    };
    render(<PrevisaoPanel />);

    const linha = screen.getByText("2026-11").closest("tr");
    const celulas = Array.from(linha?.querySelectorAll("td") ?? []).map((td) =>
      semNbsp(td.textContent ?? ""),
    );
    expect(celulas).toEqual([
      "2026-11",
      "BRL",
      "R$ 1.500,00 R$ 3.000,00",
      "R$ 250,00 R$ 500,00",
      "2",
    ]);

    const texto = semNbsp(document.body.textContent ?? "");
    expect(texto).not.toContain("3.500");
    expect(texto).not.toContain("1.750");
  });
});
