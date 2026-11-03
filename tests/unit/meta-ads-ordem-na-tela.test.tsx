/**
 * O CONTROLE DE ORDEM NA TELA (#3911).
 *
 * O teste de lib (`meta-ads-ordem-das-campanhas.test.ts`) prova a ordenação; este
 * prova que ela CHEGA à tabela: que a tela abre na ordem padrão e que trocar o
 * `select` reordena o que está desenhado. Sem este caso, um `select` ligado em
 * nada — ou um `useMemo` com a dependência faltando — passaria com a lib verde.
 *
 * Sem rede e sem i18n: `useT` é o dublê identidade, então o rótulo na tela é a
 * própria chave em português.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TabelaDeCampanhas } from "@/app/app/ads/meta/_components/TabelaDeCampanhas";
import type { LinhaDeCampanha } from "@/lib/plataformas-de-anuncio/types";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

afterEach(cleanup);

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

/** A ordem em que os nomes aparecem no corpo da tabela. */
function nomesNaTela(): string[] {
  const corpo = screen.getAllByRole("rowgroup")[1];
  if (!corpo) throw new Error("esperava o corpo da tabela");
  return within(corpo)
    .getAllByRole("row")
    .map((linha) => (linha.textContent ?? "").trim());
}

/** As três como a plataforma entrega: da mais antiga para a mais nova. */
const LINHAS_NA_ORDEM_DA_API = [
  linha("Captação: janeiro", "2024-01-09T11:00:00+0000", { veiculacao: "PAUSED" }),
  linha("Cadastro: Agenda Cheia", "2026-03-02T08:15:00+0000", { veiculacao: "PAUSED" }),
  linha("Engajamento: Astra Mídia", "2026-08-14T09:31:10+0000"),
];

describe("a tabela de campanhas abre na campanha mais recente", () => {
  it("mostra primeiro a mais nova, mesmo recebendo a ordem da plataforma", () => {
    render(<TabelaDeCampanhas linhas={LINHAS_NA_ORDEM_DA_API} moeda="BRL" />);

    const [primeira] = nomesNaTela();
    expect(primeira).toContain("Engajamento: Astra Mídia");
    expect(nomesNaTela()[2]).toContain("Captação: janeiro");
  });

  it("o controle existe, com as três ordens", () => {
    render(<TabelaDeCampanhas linhas={LINHAS_NA_ORDEM_DA_API} moeda="BRL" />);

    const seletor = screen.getByLabelText("Ordenar por") as HTMLSelectElement;
    expect(seletor.value).toBe("mais_recentes");
    expect([...seletor.options].map((o) => o.value)).toEqual([
      "mais_recentes",
      "mais_antigas",
      "status",
    ]);
  });

  it("trocar para `mais_antigas` reordena o que está desenhado", () => {
    render(<TabelaDeCampanhas linhas={LINHAS_NA_ORDEM_DA_API} moeda="BRL" />);

    fireEvent.change(screen.getByLabelText("Ordenar por"), { target: { value: "mais_antigas" } });

    const [primeira] = nomesNaTela();
    expect(primeira).toContain("Captação: janeiro");
    expect(nomesNaTela()[2]).toContain("Engajamento: Astra Mídia");
  });

  it("trocar para `status` põe quem está entregando primeiro", () => {
    render(<TabelaDeCampanhas linhas={LINHAS_NA_ORDEM_DA_API} moeda="BRL" />);

    fireEvent.change(screen.getByLabelText("Ordenar por"), { target: { value: "status" } });

    const [primeira] = nomesNaTela();
    // Só a de agosto está ACTIVE; as outras duas estão pausadas.
    expect(primeira).toContain("Engajamento: Astra Mídia");
  });
});
