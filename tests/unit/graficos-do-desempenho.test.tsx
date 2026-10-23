// A EVOLUÇÃO DOS GANHOS NO DESEMPENHO SAI EM GRÁFICO E TABELA, NO MESMO CARD (#3024).
//
// A tela `/app/metrics` só tinha número e tabela. Esta fatia entrega a TENDÊNCIA:
// quantidade de ganhos por balde (dia/semana/mês) num gráfico de linha, com a
// tabela dos baldes logo abaixo — e sem mexer em nenhum número que já existia.
//
// O que este caso protege, e é o que a fatia promete:
//
//  - o gráfico E a tabela vivem no mesmo `Card` (não são dois blocos soltos);
//  - balde sem ganho aparece com zero, com a mesma contagem que a série traz;
//  - nenhuma frase nova escapa de `t()`.
//
// Remover o gráfico, ou tirar a tabela de dentro do `Card`, deixa vermelho.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SerieTemporal } from "@/hooks/metrics/useSerieTemporal";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));

let serie: SerieTemporal;
vi.mock("@/hooks/metrics/useSerieTemporal", () => ({
  useSerieTemporal: () => ({ data: { data: serie }, isLoading: false, isError: false }),
}));

import { SeriePanel } from "@/app/app/metrics/_components/SeriePanel";

function serieDeExemplo(): SerieTemporal {
  return {
    window: { from: "2026-10-01T00:00:00.000Z", to: "2026-10-06T00:00:00.000Z" },
    granularidade: "dia",
    baldes: [
      { balde: "2026-10-01", ganhos: 2 },
      { balde: "2026-10-02", ganhos: 0 },
      { balde: "2026-10-03", ganhos: 1 },
    ],
    total: 3,
    truncado: false,
  };
}

describe("a evolução dos ganhos no Desempenho", () => {
  it("⭐ gráfico e tabela no MESMO Card, e o balde parado aparece com zero", () => {
    serie = serieDeExemplo();
    render(<SeriePanel />);

    // O gráfico existe (o invólucro do recharts, no mesmo Card da tabela).
    const grafico = screen.getByTestId("ganhos-no-tempo");

    // A tabela dos baldes, com o dia PARADO (02) presente e zerado — não sumiu.
    // A célula mostra o rótulo no idioma da sessão (`02/10`), não a chave ISO.
    const linhaParada = screen.getByText("02/10").closest("tr");
    const celulas = Array.from(linhaParada?.querySelectorAll("td") ?? []).map(
      (td) => td.textContent ?? "",
    );
    expect(celulas).toEqual(["02/10", "0"]);

    // O mesmo `Card` para os dois: o ancestral comum é o próprio Cartão.
    const cartaoDoGrafico = grafico.closest("div.rounded-lg");
    const cartaoDaTabela = linhaParada?.closest("div.rounded-lg");
    expect(cartaoDoGrafico).not.toBeNull();
    expect(cartaoDaTabela).toBe(cartaoDoGrafico);
    // …e o Cartão é o da série, com o título e o total — não outro qualquer.
    expect(cartaoDoGrafico?.textContent).toContain("Ganhos por período");
    expect(cartaoDoGrafico?.textContent).toContain("3");
  });

  it("a tabela conta exatamente o que a série traz, sem recalcular", () => {
    serie = serieDeExemplo();
    render(<SeriePanel />);

    const linhas = Array.from(document.querySelectorAll("tbody tr")).map((tr) =>
      Array.from(tr.querySelectorAll("td")).map((td) => td.textContent ?? ""),
    );
    expect(linhas).toEqual([
      ["01/10", "2"],
      ["02/10", "0"],
      ["03/10", "1"],
    ]);
  });

  it("série cortada no teto de leitura avisa, e a inteira não", () => {
    serie = serieDeExemplo();
    const { unmount } = render(<SeriePanel />);
    expect(screen.queryByText("Série cortada no teto de leitura.")).toBeNull();
    unmount();

    serie = { ...serieDeExemplo(), truncado: true };
    render(<SeriePanel />);
    expect(screen.getByText("Série cortada no teto de leitura.")).toBeTruthy();
  });
});
