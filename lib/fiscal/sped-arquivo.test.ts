import { describe, expect, it } from "vitest";

import { formatoEfd, gerarEfd, quantidadeEfd, type GerarEfdEntrada } from "./sped-arquivo";

function entradaBase(): GerarEfdEntrada {
  return {
    emitente: {
      nome: "Empresa Teste LTDA",
      cnpj: "12.345.678/0001-90",
      ie: "123456789",
      uf: "SP",
      codigo_municipio: "3550308",
      crt: "1",
    },
    ano: 2026,
    mes: 8,
    cfopPadrao: "5102",
    equivalentes: { "5102": "5101" },
    notas: [
      {
        serie: "1",
        numero: 4371,
        chave: "35260812345678000100550010000437101234567890",
        emissao: "2026-08-09T10:00:00.000Z",
        cliente_nome: "Cliente Um",
        cliente_documento: "111.222.333-44",
        total_cents: 84340,
        desconto_cents: 0,
        frete_cents: 0,
        itens: [
          {
            codigo: "P1",
            descricao: "Produto Um",
            ncm: "84713012",
            cfop: "5102",
            unidade: "UN",
            quantidade: 2,
            preco_cents: 42170,
            desconto_cents: 0,
          },
        ],
      },
      {
        serie: "1",
        numero: 4315,
        chave: "35260812345678000100550010000431501234567890",
        emissao: "2026-08-24T10:00:00.000Z",
        cliente_nome: "Cliente Um",
        cliente_documento: "111.222.333-44",
        total_cents: 18400,
        desconto_cents: 0,
        frete_cents: 0,
        itens: [
          {
            codigo: "P2",
            descricao: "Produto Dois",
            ncm: null,
            cfop: null,
            unidade: null,
            quantidade: 1,
            preco_cents: 18400,
            desconto_cents: 0,
          },
        ],
      },
    ],
  };
}

describe("sped-arquivo (Gera Arquivo)", () => {
  it("formata dinheiro com vírgula decimal, sem milhar", () => {
    expect(formatoEfd(556130)).toBe("5561,30");
    expect(formatoEfd(84340)).toBe("843,40");
    expect(formatoEfd(0)).toBe("0,00");
  });

  it("formata quantidade sem zeros à toa", () => {
    expect(quantidadeEfd(2)).toBe("2");
    expect(quantidadeEfd(1.5)).toBe("1,5");
  });

  it("9999 conta todas as linhas e C990 fecha o bloco C", () => {
    const saida = gerarEfd(entradaBase());
    const linhas = saida.arquivo.trim().split("\r\n");
    expect(linhas.length).toBe(saida.linhas);
    expect(linhas[linhas.length - 1]).toBe(`|9999|${saida.linhas}|`);

    const c990 = linhas.find((l) => l.startsWith("|C990|"));
    const qtdC = linhas.filter((l) => l.startsWith("|C")).length;
    expect(c990).toBe(`|C990|${qtdC}|`);

    // 9900 lista o 9001 e a si mesmo com a contagem certa.
    const l9900 = linhas.filter((l) => l.startsWith("|9900|"));
    const self = l9900.find((l) => l === `|9900|9900|${l9900.length}|`);
    expect(self).toBeDefined();
    expect(l9900.some((l) => l === "|9900|9001|1|")).toBe(true);
  });

  it("aplica o de/para de CFOP equivalentes no C170 e no C190", () => {
    const saida = gerarEfd(entradaBase());
    // P1 tinha CFOP 5102 -> equivalente 5101; P2 sem CFOP -> padrão 5102 -> 5101.
    expect(saida.arquivo).not.toMatch(/\|5102\|/);
    expect(saida.arquivo).toMatch(/\|5101\|/);
  });

  it("um cliente com duas notas vira um 0150 só", () => {
    const saida = gerarEfd(entradaBase());
    const participantes = saida.arquivo.trim().split("\r\n").filter((l) => l.startsWith("|0150|"));
    expect(participantes.length).toBe(1);
  });

  it("sem notas, blocos de movimento nascem vazios mas contadores fecham", () => {
    const saida = gerarEfd({ ...entradaBase(), notas: [] });
    expect(saida.arquivo).toContain("|0001|1|");
    expect(saida.arquivo).toContain("|C001|1|");
    const linhas = saida.arquivo.trim().split("\r\n");
    expect(linhas[linhas.length - 1]).toBe(`|9999|${linhas.length}|`);
  });

  it("avisa o que o contador precisa completar no PVA", () => {
    const saida = gerarEfd(entradaBase());
    expect(saida.pendencias.length).toBeGreaterThan(0);
    expect(saida.pendencias.join(" ")).toMatch(/CSOSN/);
  });
});
