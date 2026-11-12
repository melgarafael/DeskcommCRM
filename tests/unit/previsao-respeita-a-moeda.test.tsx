// O PAINEL DE PREVISÃO EM MÉTRICAS ESCREVE O VALOR NA RÉGUA DO NEGÓCIO (#1732)
// E MOSTRA AS DUAS PARCELAS SEM SOMÁ-LAS (#3602).
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

/** Um balde com as duas parcelas: única e recorrência mensal, NUNCA somadas. */
function baldeDe(
  moeda: string,
  unicoBruto: number,
  unicoPonderado: number,
  mensalBruto = 0,
  mensalPonderado = 0,
) {
  return {
    moeda,
    bruto_cents: unicoBruto,
    ponderado_cents: unicoPonderado,
    n: 2,
    unico: { bruto_cents: unicoBruto, ponderado_cents: unicoPonderado },
    recorrente_mensal: { bruto_cents: mensalBruto, ponderado_cents: mensalPonderado },
  };
}

function previsao(balde: ReturnType<typeof baldeDe>): PrevisaoDoFunil {
  return {
    pipeline_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    fonte: "etapa",
    meses: [{ ...balde, mes: "2026-10" }],
    totais: [balde],
    sem_data: [balde],
    sem_probabilidade: [balde],
    recorrencia_nao_mensal: [],
  };
}

const celulasDa = (textoDoMes: string) => {
  const linha = screen.getByText(textoDoMes).closest("tr");
  return Array.from(linha?.querySelectorAll("td") ?? []).map((td) =>
    semNbsp(td.textContent ?? ""),
  );
};

describe("painel de previsão em Métricas", () => {
  it("⭐ em guarani: ₲250.000 brutos e ₲125.000 ponderados, não cem vezes mais", () => {
    // 25.000.000 na régua do negócio = ₲250.000 (dois pedidos de ₲125.000);
    // a mensalidade de 5.000.000 = ₲50.000, com o ponderado de ₲25.000.
    dados = previsao(baldeDe("PYG", 25_000_000, 12_500_000, 5_000_000, 2_500_000));
    render(<PrevisaoPanel />);

    expect(celulasDa("2026-10")).toEqual([
      "2026-10",
      "PYG",
      "Gs. 125.000",
      "Gs. 250.000",
      "Gs. 25.000",
      "Gs. 50.000",
      "2",
    ]);

    // O balde de fora do cronograma usa a mesma régua, e a recorrência aparece
    // nele também — à parte, com o rótulo do que é.
    const texto = semNbsp(document.body.textContent ?? "");
    expect(texto).toContain(
      "PYG: Gs. 125.000 · bruto Gs. 250.000 · 2 negócios · recorrência mensal: Ponderado Gs. 25.000 · Bruto Gs. 50.000",
    );
    expect(texto).toContain("PYG: Gs. 250.000 · 2 negócios");
    expect(texto).not.toContain("12.500.000");
    expect(texto).not.toContain("25.000.000");
  });

  it("⭐ as duas parcelas ficam LADO A LADO por mês e moeda, e a soma não aparece", () => {
    // R$ 3.000 de setup a 50% + R$ 500/mês a 50% (issue #3602).
    dados = previsao(baldeDe("BRL", 300_000, 150_000, 50_000, 25_000));
    render(<PrevisaoPanel />);

    expect(celulasDa("2026-10")).toEqual([
      "2026-10",
      "BRL",
      "R$ 1.500,00",
      "R$ 3.000,00",
      "R$ 250,00",
      "R$ 500,00",
      "2",
    ]);

    const texto = semNbsp(document.body.textContent ?? "");
    expect(texto).toContain("Valor único");
    expect(texto).toContain("Recorrência nova (mensal)");
    // 3.500 e 1.750 seriam a soma das duas parcelas: ela não existe na tela.
    expect(texto).not.toContain("R$ 3.500,00");
    expect(texto).not.toContain("R$ 1.750,00");
  });

  it("em real continua saindo em real, com centavos", () => {
    dados = previsao(baldeDe("BRL", 24_990, 12_495));
    render(<PrevisaoPanel />);

    const texto = semNbsp(document.body.textContent ?? "");
    expect(texto).toContain("BRL: R$ 124,95 · bruto R$ 249,90 · 2 negócios");
  });

  it("recorrência que não é mensal aparece à parte, com o valor — não vira parcela mensal", () => {
    dados = {
      ...previsao(baldeDe("BRL", 100_000, 50_000)),
      recorrencia_nao_mensal: [{ moeda: "BRL", bruto_cents: 120_000, ponderado_cents: 60_000, n: 1 }],
    };
    render(<PrevisaoPanel />);

    const texto = semNbsp(document.body.textContent ?? "");
    expect(texto).toContain("Recorrência fora do mensal — não entra na projeção por mês");
    expect(texto).toContain("BRL: R$ 1.200,00 · 1 negócios");
  });

  it("⭐ previsão de um recorte avisa na tela (#4322); a completa não ganha aviso", () => {
    dados = { ...previsao(baldeDe("BRL", 100_000, 50_000)), truncado: true };
    const { unmount } = render(<PrevisaoPanel />);
    expect(screen.getByTestId("previsao-truncada").textContent).toContain(
      "Os valores abaixo são parciais.",
    );
    unmount();

    dados = previsao(baldeDe("BRL", 100_000, 50_000));
    render(<PrevisaoPanel />);
    expect(screen.queryByTestId("previsao-truncada")).toBeNull();
  });
});
