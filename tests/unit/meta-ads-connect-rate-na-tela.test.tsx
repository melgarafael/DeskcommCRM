/**
 * A COLUNA CONNECT RATE NO DOM — a prova que o curl não dá.
 *
 * `meta-ads-tabela-de-campanhas.test.ts` prova a CONTA e
 * `meta-ads-connect-rate-no-pedido.test.ts` prova que os dois números chegam no
 * payload. Nenhum dos dois prova que existe uma coluna na tela: o componente
 * poderia ignorar o campo novo e a suíte ficaria verde. Este arquivo renderiza a
 * tabela de verdade e cobra o que quem usa vê — rótulo na posição certa,
 * percentual formatado como as vizinhas, e "—" onde não houve medição.
 *
 * O tradutor entra como identidade porque em pt-BR a chave do dicionário É o
 * texto — mesmo idioma do mock usado nas outras telas.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TabelaDeCampanhas } from "@/app/app/ads/meta/_components/TabelaDeCampanhas";
import type { LinhaDeCampanha } from "@/lib/plataformas-de-anuncio/types";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

afterEach(cleanup);

/** Uma linha da campanha que veiculou — números do fixture de sondagem. */
function linha(ajustes: Partial<LinhaDeCampanha> = {}): LinhaDeCampanha {
  return {
    campanhaId: "120254402954150350",
    nome: "Cadastro: Agenda Cheia",
    status: "ACTIVE",
    veiculacao: "ACTIVE",
    objetivo: "OUTCOME_LEADS",
    resultado: {
      valor: 13,
      custoPorResultado: 28.05,
      indicador: "actions:offsite_conversion.fb_pixel_lead",
    },
    gasto: 364.63,
    impressoes: 21281,
    alcance: 13894,
    cpm: 17.13,
    ctr: 2.02,
    connectRate: 70,
    frequencia: 1.53,
    cpc: 0.85,
    hookRate: 1.95,
    thruPlays: 7,
    ...ajustes,
  };
}

function rotulosDasColunas(): string[] {
  return screen.getAllByRole("columnheader").map((th) => (th.textContent ?? "").trim());
}

describe("Connect rate na tela", () => {
  it("nasce entre o CTR e a Frequência, e a tabela fica com 15 colunas", () => {
    render(<TabelaDeCampanhas linhas={[linha()]} moeda="BRL" />);

    const rotulos = rotulosDasColunas();
    // A coluna nova não empurrou nenhuma vizinha para fora.
    expect(rotulos).toHaveLength(15);
    expect(rotulos[10]).toBe("Connect rate");
    expect(rotulos[9]).toBe("CTR");
    expect(rotulos[11]).toBe("Frequência");
  });

  it("leva a fórmula no `title`, como o Hook Rate leva o numerador", () => {
    render(<TabelaDeCampanhas linhas={[linha()]} moeda="BRL" />);

    const coluna = screen
      .getAllByRole("columnheader")
      .find((th) => (th.textContent ?? "").includes("Connect rate"));

    expect(coluna?.getAttribute("title")).toBe("Visualizações da página ÷ cliques no link");
  });

  it("formata o percentual como as colunas de porcentagem vizinhas", () => {
    render(<TabelaDeCampanhas linhas={[linha({ connectRate: 70 })]} moeda="BRL" />);

    expect(screen.getByText("70,00%")).toBeTruthy();
  });

  it("mostra “—” quando não houve medição — nunca 0,00%", () => {
    render(<TabelaDeCampanhas linhas={[linha({ connectRate: null })]} moeda="BRL" />);

    const corpo = screen.getAllByRole("row")[1];
    if (!corpo) throw new Error("esperava a linha da campanha");
    const celulas = within(corpo).getAllByRole("cell");

    // Campanha, Status, Veiculação, Resultado, Custo por Resultado, Valor Gasto,
    // Impressões, Alcance, CPM, CTR → o Connect rate é a décima primeira.
    expect(celulas[10]?.textContent).toBe("—");
    expect(within(corpo).queryByText("0,00%")).toBeNull();
  });
});
