import { describe, expect, it } from "vitest";

import type { SheetMatrix } from "@/lib/planilha/ler-arquivo";
import { chaveDoArquivo, montarPrevia } from "@/lib/tabela-de-valores/importacao";
import { lerPlanilhaDaTabelaDeValores } from "@/lib/tabela-de-valores/planilha";
import type { LeituraDaTabelaDeValores } from "@/lib/tabela-de-valores/tipos";

function ler(headers: string[], rows: string[][]): LeituraDaTabelaDeValores {
  const sheet: SheetMatrix = { headers, rows };
  const r = lerPlanilhaDaTabelaDeValores(sheet);
  if ("erro" in r) throw new Error(r.erro);
  return r;
}

const PLANILHA = ler(
  ["codigo", "descricao", "valor de partida", "valor limite"],
  [
    ["1010", "Consulta", "120,00", "180,00"],
    ["2020", "Radiografia", "45,50", "70,00"],
    ["3030", "Urgência", "300,00", "250,00"],
  ],
);

describe("montarPrevia — a prévia é pura e a classificação é uma só", () => {
  it("separa o que entra do que não entra, com o resumo por motivo", () => {
    const previa = montarPrevia(PLANILHA, { chave_do_arquivo: "abc" });

    expect(previa.entram.map((l) => l.item.codigo)).toEqual(["1010", "2020"]);
    expect(previa.fora.map((l) => l.codigo)).toEqual(["limite_menor_que_partida"]);
    expect(previa.total_linhas).toBe(3);
    expect(previa.chave_do_arquivo).toBe("abc");
    // Zero incluído: a tela não esconde a coluna de um motivo que não ocorreu.
    expect(Object.keys(previa.resumo)).toHaveLength(8);
    expect(previa.resumo.sem_codigo).toBe(0);
    expect(previa.resumo.limite_menor_que_partida).toBe(1);
  });

  it("código que já está na tabela vira recusa, e não sobrescrita", () => {
    const previa = montarPrevia(PLANILHA, {
      chave_do_arquivo: "abc",
      codigos_na_tabela: new Set(["1010"]),
    });
    expect(previa.entram.map((l) => l.item.codigo)).toEqual(["2020"]);
    expect(previa.fora.map((l) => [l.codigo, l.codigo_do_procedimento])).toEqual([
      ["ja_existe_na_tabela", "1010"],
      ["limite_menor_que_partida", "3030"],
    ]);
    // Ordenada pela linha da planilha, para a tela falar a língua do Excel.
    expect(previa.fora.map((l) => l.linha)).toEqual([2, 4]);
  });

  it("o motivo da própria linha vem ANTES do 'já existe': o defeito é do arquivo", () => {
    const previa = montarPrevia(PLANILHA, {
      chave_do_arquivo: "abc",
      codigos_na_tabela: new Set(["3030"]),
    });
    const daInvertida = previa.fora.find((l) => l.codigo_do_procedimento === "3030");
    expect(daInvertida?.codigo).toBe("limite_menor_que_partida");
  });

  it("a chave do arquivo é o SHA-256 dos bytes", () => {
    const bytes = new TextEncoder().encode("codigo;descricao\n1010;Consulta\n");
    expect(chaveDoArquivo(bytes)).toBe(
      "fa5e1084d4945c7a8a47065e61abf54c86e560ea4532337fbb169e8b48de5be4",
    );
    expect(chaveDoArquivo(new TextEncoder().encode("outro"))).not.toBe(chaveDoArquivo(bytes));
  });
});
