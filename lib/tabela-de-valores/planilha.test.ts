import { describe, expect, it } from "vitest";

import { traduzir } from "@/lib/i18n/dicionario";
import type { SheetMatrix } from "@/lib/planilha/ler-arquivo";
import {
  campoDoCabecalho,
  centavosDe,
  lerPlanilhaDaTabelaDeValores,
} from "@/lib/tabela-de-valores/planilha";

function planilha(headers: string[], rows: string[][], rowNumbers?: number[]): SheetMatrix {
  return { headers, rows, rowNumbers };
}

describe("centavosDe — o preço que a empresa digita", () => {
  it("aceita as duas convenções do Excel e o símbolo de moeda", () => {
    expect(centavosDe("R$ 120,00")).toBe(12_000);
    expect(centavosDe("1.234,56")).toBe(123_456);
    expect(centavosDe("1,234.56")).toBe(123_456);
    expect(centavosDe("45,5")).toBe(4_550);
    expect(centavosDe("30")).toBe(3_000);
    expect(centavosDe("US$ 36,00")).toBe(3_600);
    expect(centavosDe(" 10 USD ")).toBe(1_000);
    expect(centavosDe("\u00a0R$ 8,90\u00a0")).toBe(890);
  });

  it("ponto com exatamente três casas é milhar, não decimal", () => {
    expect(centavosDe("1.234")).toBe(123_400);
    expect(centavosDe("1.23")).toBe(123);
  });

  it("arredonda a quarta casa para o centavo mais próximo", () => {
    expect(centavosDe("30,0049")).toBe(3_000);
    expect(centavosDe("30,0050")).toBe(3_001);
  });

  it("recusa o que não é número — preço chutado é pior que linha faltando", () => {
    expect(centavosDe("a combinar")).toBeNull();
    expect(centavosDe("")).toBeNull();
    expect(centavosDe("-10,00")).toBeNull();
    expect(centavosDe("1.2.3")).toBeNull();
    expect(centavosDe("R$")).toBeNull();
  });
});

describe("campoDoCabecalho — a planilha é da empresa, não nossa", () => {
  it("reconhece código, descrição e observação com acento e caixa diferentes", () => {
    expect(campoDoCabecalho("Código")).toBe("codigo");
    expect(campoDoCabecalho("COD")).toBe("codigo");
    expect(campoDoCabecalho("Descrição")).toBe("descricao");
    expect(campoDoCabecalho("Descripción")).toBe("descricao");
    expect(campoDoCabecalho("Observações")).toBe("observacao");
    expect(campoDoCabecalho("Unidade")).toBe("unidade");
  });

  it("combina moeda e ponta; sem moeda, o valor é em reais", () => {
    expect(campoDoCabecalho("Valor de partida (R$)")).toBe("brl_partida");
    expect(campoDoCabecalho("Valor limite (R$)")).toBe("brl_limite");
    expect(campoDoCabecalho("Valor de partida (US$)")).toBe("us_partida");
    expect(campoDoCabecalho("Valor limite US$")).toBe("us_limite");
    expect(campoDoCabecalho("valor partida")).toBe("brl_partida");
    expect(campoDoCabecalho("Preço máximo")).toBe("brl_limite");
  });

  it("cabeçalho que não é campo nenhum volta nulo (vai para colunas ignoradas)", () => {
    expect(campoDoCabecalho("Porte")).toBeNull();
    expect(campoDoCabecalho("Valor")).toBeNull();
    expect(campoDoCabecalho("")).toBeNull();
  });
});

describe("lerPlanilhaDaTabelaDeValores", () => {
  it("erro estrutural: sem coluna de código, o arquivo inteiro não serve", () => {
    const r = lerPlanilhaDaTabelaDeValores(
      planilha(["Descrição", "Valor de partida"], [["Consulta", "120,00"]]),
    );
    expect("erro" in r && r.erro).toMatch(/CÓDIGO/);
  });

  it("erro estrutural: sem coluna de valor, idem", () => {
    const r = lerPlanilhaDaTabelaDeValores(planilha(["Código", "Descrição"], [["1010", "Consulta"]]));
    expect("erro" in r && r.erro).toMatch(/coluna de valor/);
  });

  it("recusa com motivo e número de linha, sem parar a leitura", () => {
    const r = lerPlanilhaDaTabelaDeValores(
      planilha(
        ["codigo", "descricao", "valor de partida", "valor limite"],
        [
          ["1010", "Consulta", "120,00", "180,00"],
          ["", "Sem código", "10,00", "20,00"],
          ["2020", "", "10,00", "20,00"],
          ["3030", "Sem valor"],
          ["4040", "Faixa pela metade", "10,00", ""],
          ["5050", "Preço inválido", "a combinar", "20,00"],
          ["6060", "Invertida", "180,00", "120,00"],
          ["1010", "Código repetido", "10,00", "20,00"],
        ],
        [2, 3, 4, 5, 6, 7, 8, 9],
      ),
    );
    if ("erro" in r) throw new Error(r.erro);

    expect(r.itens.map((l) => l.item.codigo)).toEqual(["1010"]);
    expect(r.fora.map((l) => [l.linha, l.codigo])).toEqual([
      [3, "sem_codigo"],
      [4, "sem_descricao"],
      [5, "sem_valor"],
      [6, "faixa_incompleta"],
      [7, "valor_invalido"],
      [8, "limite_menor_que_partida"],
      [9, "repetido_na_planilha"],
    ]);
    // A recusa por repetição aponta onde o código apareceu primeiro.
    expect(r.fora.at(-1)!.detalhe).toBe("já na linha 2");
  });

  it("as duas moedas na mesma linha, e o que não veio fica nulo (não zero)", () => {
    const r = lerPlanilhaDaTabelaDeValores(
      planilha(
        ["codigo", "descricao", "valor de partida (R$)", "valor limite (R$)", "valor de partida (US$)", "valor limite (US$)"],
        [["1010", "Consulta", "R$ 120,00", "R$ 180,00", "30,00", "36,00"]],
      ),
    );
    if ("erro" in r) throw new Error(r.erro);
    expect(r.itens[0]!.item).toEqual({
      codigo: "1010",
      descricao: "Consulta",
      valor_brl_partida_cents: 12_000,
      valor_brl_limite_cents: 18_000,
      valor_us_partida_cents: 3_000,
      valor_us_limite_cents: 3_600,
      unidade: null,
      observacao: null,
    });
  });

  it("coluna desconhecida não derruba a leitura: volta em colunasIgnoradas", () => {
    const r = lerPlanilhaDaTabelaDeValores(
      planilha(
        ["codigo", "descricao", "valor de partida", "valor limite", "Porte da empresa"],
        [["1010", "Consulta", "120,00", "180,00", "grande"]],
      ),
    );
    if ("erro" in r) throw new Error(r.erro);
    expect(r.colunasIgnoradas).toEqual(["Porte da empresa"]);
    expect(r.itens).toHaveLength(1);
  });
});

describe("as recusas da planilha que a rota passa por t() têm espanhol", () => {
  it("teto de linhas e planilha sem coluna de valor", () => {
    const muitas = lerPlanilhaDaTabelaDeValores(
      planilha(["codigo", "descricao", "valor de partida", "valor limite"], Array.from({ length: 2_001 }, () => ["1", "x", "1", "1"])),
    );
    const semValor = lerPlanilhaDaTabelaDeValores(planilha(["codigo", "descricao"], [["1", "x"]]));
    for (const lida of [muitas, semValor]) {
      if (!("erro" in lida)) throw new Error("a planilha devia ser recusada");
      // A chave do dicionário é a frase inteira: se o texto (ou o teto) mudar
      // sem a entrada mudar junto, o espanhol volta a sair em português.
      expect(traduzir(lida.erro, "es")).not.toBe(lida.erro);
    }
  });
});
