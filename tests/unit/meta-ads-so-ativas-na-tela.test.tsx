/**
 * A CAIXA "SÓ ATIVAS" NA TELA (#4412).
 *
 * Prova que o filtro chega à tabela desenhada: desmarcado mostra tudo, marcado
 * deixa só `status === "ACTIVE"` sem mexer na ordem do seletor, e quando o
 * filtro esvazia a tabela aparece a frase do filtro — não a de conta vazia.
 *
 * Sem rede e sem i18n: `useT` é o dublê identidade, então o rótulo na tela é a
 * própria chave em português.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TabelaDeCampanhas } from "@/app/app/ads/meta/_components/TabelaDeCampanhas";
import type { LinhaDeCampanha } from "@/lib/plataformas-de-anuncio/types";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

afterEach(() => {
  cleanup();
  // A ordem escolhida é lembrada no navegador (#4480): um caso não herda a do outro.
  window.localStorage.clear();
});

function linha(
  campanhaId: string,
  criadaEm: string | null,
  ajustes: Partial<LinhaDeCampanha> = {},
): LinhaDeCampanha {
  return {
    campanhaId,
    nome: campanhaId,
    status: "ACTIVE",
    veiculacao: "ACTIVE",
    objetivo: "OUTCOME_LEADS",
    criadaEm,
    iniciadaEm: criadaEm,
    resultado: { valor: null, custoPorResultado: null, indicador: null },
    gasto: 10,
    impressoes: 100,
    alcance: 80,
    cpm: 5,
    ctr: 1,
    connectRate: null,
    frequencia: 1.2,
    cpc: 0.5,
    hookRate: null,
    thruPlays: null,
    ...ajustes,
  };
}

/** Os nomes no corpo da tabela, na ordem desenhada (vazio se não há tabela). */
function nomesNaTela(): string[] {
  const corpo = screen.queryAllByRole("rowgroup")[1];
  if (!corpo) return [];
  return within(corpo)
    .getAllByRole("row")
    .map((linha) => within(linha).getAllByRole("cell")[0]?.textContent?.trim() ?? "");
}

function caixa(): HTMLInputElement {
  return screen.getByLabelText("Só ativas") as HTMLInputElement;
}

const FRASE_DO_FILTRO = "Nenhuma campanha ativa neste período.";

/** Da mais antiga para a mais nova, como a plataforma entrega. */
const MISTURADAS = [
  linha("Captação: janeiro", "2024-01-09T11:00:00+0000", {
    status: "ARCHIVED",
    veiculacao: "ARCHIVED",
  }),
  linha("Cadastro: Agenda Cheia", "2026-03-02T08:15:00+0000", {
    status: "PAUSED",
    veiculacao: "PAUSED",
  }),
  linha("Engajamento: Astra Mídia", "2026-08-14T09:31:10+0000"),
  // Ativa, mas o conjunto está pausado: o filtro olha o status da CAMPANHA.
  linha("Remarketing: carrinho", "2026-09-20T10:00:00+0000", { veiculacao: "ADSET_PAUSED" }),
  linha("Sem status", "2026-10-01T10:00:00+0000", { status: null, veiculacao: null }),
];

describe('a caixa "Só ativas" da tabela de campanhas', () => {
  it("existe, desmarcada, e a tabela mostra tudo como antes", () => {
    render(<TabelaDeCampanhas linhas={MISTURADAS} moeda="BRL" />);

    expect(caixa().checked).toBe(false);
    expect(nomesNaTela()).toEqual([
      "Sem status",
      "Remarketing: carrinho",
      "Engajamento: Astra Mídia",
      "Cadastro: Agenda Cheia",
      "Captação: janeiro",
    ]);
  });

  it("marcada, deixa só as ACTIVE, na ordem do seletor", () => {
    render(<TabelaDeCampanhas linhas={MISTURADAS} moeda="BRL" />);

    fireEvent.click(caixa());

    expect(caixa().checked).toBe(true);
    expect(nomesNaTela()).toEqual(["Remarketing: carrinho", "Engajamento: Astra Mídia"]);
  });

  it("trocar a ordem com a caixa marcada reordena só as ativas", () => {
    render(<TabelaDeCampanhas linhas={MISTURADAS} moeda="BRL" />);

    fireEvent.click(caixa());
    fireEvent.change(screen.getByLabelText("Ordenar por"), { target: { value: "mais_antigas" } });

    expect(nomesNaTela()).toEqual(["Engajamento: Astra Mídia", "Remarketing: carrinho"]);
  });

  it("desmarcar devolve todas as linhas", () => {
    render(<TabelaDeCampanhas linhas={MISTURADAS} moeda="BRL" />);

    fireEvent.click(caixa());
    fireEvent.click(caixa());

    expect(nomesNaTela()).toHaveLength(MISTURADAS.length);
    expect(screen.queryByText(FRASE_DO_FILTRO)).toBeNull();
  });

  it("marcada e sem nenhuma ativa, mostra a frase do filtro e mantém a caixa à mão", () => {
    const semAtivas = MISTURADAS.filter((l) => l.status !== "ACTIVE");
    render(<TabelaDeCampanhas linhas={semAtivas} moeda="BRL" />);

    expect(screen.queryByText(FRASE_DO_FILTRO)).toBeNull();
    fireEvent.click(caixa());

    expect(screen.getByText(FRASE_DO_FILTRO)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(/Ou a conta ainda não tem campanhas/)).toBeNull();

    // A caixa continua na tela: desmarcar ali mesmo traz a tabela de volta.
    fireEvent.click(caixa());
    expect(nomesNaTela()).toHaveLength(semAtivas.length);
  });

  it("conta sem campanha nenhuma segue com a frase de conta vazia, não a do filtro", () => {
    render(<TabelaDeCampanhas linhas={[]} moeda="BRL" />);

    expect(screen.getByText(/Nenhuma campanha neste período/)).toBeTruthy();
    expect(screen.queryByText(FRASE_DO_FILTRO)).toBeNull();
  });
});
