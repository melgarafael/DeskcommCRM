/**
 * A COLUNA "INÍCIO" NA TABELA DE CAMPANHAS (#3911).
 *
 * Quem compara campanhas quer saber desde quando cada uma está no ar sem abrir o
 * Gerenciador da Meta. A data já vinha na linha (`iniciadaEm`, o `start_time` da
 * plataforma); este arquivo prova que ela CHEGA à tela: no lugar combinado
 * (logo depois da Veiculação), no idioma de quem lê, no dia da CONTA de anúncios
 * (o mesmo do Gerenciador) e com "—" quando falta — nunca 01/01/1970, nunca a
 * tabela inteira caindo por uma data ilegível.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { TabelaDeCampanhas } from "@/app/app/ads/meta/_components/TabelaDeCampanhas";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import type { LinhaDeCampanha } from "@/lib/plataformas-de-anuncio/types";

afterEach(cleanup);

function linha(campanhaId: string, iniciadaEm: string | null): LinhaDeCampanha {
  return {
    campanhaId,
    nome: campanhaId,
    status: "ACTIVE",
    veiculacao: "ACTIVE",
    objetivo: "OUTCOME_LEADS",
    criadaEm: "2026-08-14T09:31:10+0000",
    iniciadaEm,
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
  };
}

function desenhar(linhas: LinhaDeCampanha[], idioma = "pt-BR") {
  render(
    <IdiomaProvider locale={idioma}>
      <TabelaDeCampanhas linhas={linhas} moeda="BRL" />
    </IdiomaProvider>,
  );
}

function rotulos(): string[] {
  return screen.getAllByRole("columnheader").map((th) => (th.textContent ?? "").trim());
}

/** O texto da coluna "Início" (a quarta) na linha da campanha `id`. */
function inicioDe(id: string): string {
  const corpo = screen.getAllByRole("rowgroup")[1];
  if (!corpo) throw new Error("esperava o corpo da tabela");
  const fileira = within(corpo)
    .getAllByRole("row")
    .find((r) => within(r).getAllByRole("cell")[0]?.textContent === id);
  if (!fileira) throw new Error(`esperava a linha ${id}`);
  return (within(fileira).getAllByRole("cell")[3]?.textContent ?? "").trim();
}

describe("coluna Início na tabela de campanhas", () => {
  it("vem logo depois da Veiculação", () => {
    desenhar([linha("Engajamento", "2026-08-14T12:00:00+0000")]);

    const r = rotulos();
    expect(r[2]).toBe("Veiculação");
    expect(r[3]).toBe("Início");
    expect(r[4]).toBe("Resultado");
  });

  it("mostra o start_time como dd/MM/yyyy", () => {
    desenhar([linha("Engajamento", "2026-08-14T12:00:00+0000")]);

    expect(inicioDe("Engajamento")).toBe("14/08/2026");
  });

  it("campanha sem start_time mostra “—”, e as vizinhas seguem com a data", () => {
    desenhar([linha("Sem data", null), linha("Com data", "2025-03-05T12:00:00-0300")]);

    expect(inicioDe("Sem data")).toBe("—");
    expect(inicioDe("Com data")).toBe("05/03/2025");
  });

  it("o dia é o da conta de anúncios, como no Gerenciador — não o do fuso de quem lê", () => {
    // Meia-noite em São Paulo é 03:00 UTC e 22:00 da véspera em Los Angeles.
    // Converter o instante para o fuso do navegador mostraria 09/01; a
    // plataforma diz 10/01, e é isso que o Gerenciador mostra.
    desenhar([
      linha("Meia-noite em SP", "2024-01-10T00:00:00-0300"),
      linha("Fim do dia em Tóquio", "2024-01-10T23:59:59+0900"),
    ]);

    expect(inicioDe("Meia-noite em SP")).toBe("10/01/2024");
    expect(inicioDe("Fim do dia em Tóquio")).toBe("10/01/2024");
  });

  it("data ilegível ou fora do calendário vira “—” em vez de derrubar a tabela", () => {
    // O `format` do date-fns lança com data inválida; sem a guarda, uma célula
    // levaria a tela inteira junto. E 31/02 não é 03/03.
    desenhar([
      linha("Formato novo", "não é data"),
      linha("Vazio", ""),
      linha("Fevereiro 31", "2026-02-31T00:00:00+0000"),
      linha("Mês 13", "2026-13-01T00:00:00+0000"),
    ]);

    expect(inicioDe("Formato novo")).toBe("—");
    expect(inicioDe("Vazio")).toBe("—");
    expect(inicioDe("Fevereiro 31")).toBe("—");
    expect(inicioDe("Mês 13")).toBe("—");
  });

  it("29/02 de ano bissexto é data de verdade", () => {
    desenhar([linha("Bissexto", "2024-02-29T10:00:00-0300")]);

    expect(inicioDe("Bissexto")).toBe("29/02/2024");
  });

  it("em espanhol, o cabeçalho é traduzido e a data continua a mesma", () => {
    desenhar([linha("Engajamento", "2026-08-14T12:00:00+0000")], "es");

    expect(rotulos()[3]).toBe("Inicio");
    expect(inicioDe("Engajamento")).toBe("14/08/2026");
  });
});
