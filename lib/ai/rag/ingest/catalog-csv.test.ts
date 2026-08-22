import { describe, it, expect } from "vitest";

import { parseCatalogCsv } from "./catalog-csv";

describe("parseCatalogCsv", () => {
  it("converte linha válida em pergunta/resposta com preço em MZN", () => {
    const csv = "nome,preco,sku,categoria\nCamisa social azul,1500,CAM-AZ-001,Vestuário";
    const { items, errors } = parseCatalogCsv(csv);
    expect(errors).toEqual([]);
    expect(items).toHaveLength(1);
    expect(items[0]?.question).toBe("Quanto custa Camisa social azul?");
    expect(items[0]?.answer).toContain("MTn");
    expect(items[0]?.answer).toContain("SKU: CAM-AZ-001");
    expect(items[0]?.answer).toContain("Categoria: Vestuário");
    expect(items[0]?.tags).toEqual(["Vestuário"]);
  });

  it("aceita cabeçalhos com variação de acento e sinônimo (produto/preço)", () => {
    const csv = "Produto,Preço\nSapato,349,90";
    // "349,90" tem vírgula: parseReaisToCents lê como decimal -> 34990 centavos.
    const { items, errors } = parseCatalogCsv(csv);
    expect(errors).toEqual([]);
    expect(items[0]?.question).toBe("Quanto custa Sapato?");
  });

  it("usa a moeda da coluna quando presente, em vez da moeda padrão", () => {
    const csv = "nome,preco,moeda\nCaneca importada,10,USD";
    const { items } = parseCatalogCsv(csv, "MZN");
    expect(items[0]?.answer).toContain("USD");
    expect(items[0]?.answer).not.toContain("MTn");
  });

  it("reporta erro por linha sem derrubar as outras", () => {
    const csv = ["nome,preco", "Produto A,100", "Produto B,não é número", ",50", "Produto D,200"].join("\n");
    const { items, errors } = parseCatalogCsv(csv);
    expect(items.map((i) => i.question)).toEqual([
      "Quanto custa Produto A?",
      "Quanto custa Produto D?",
    ]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toEqual({ row: 3, reason: 'Preço "não é número" não é um valor válido.' });
    expect(errors[1]).toEqual({ row: 4, reason: "Sem nome do produto." });
  });

  it("recusa planilha sem as colunas obrigatórias", () => {
    const csv = "categoria,sku\nVestuário,ABC";
    const { items, errors } = parseCatalogCsv(csv);
    expect(items).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.reason).toContain("nome");
  });

  it("devolve erro único para planilha vazia", () => {
    const { items, errors } = parseCatalogCsv("");
    expect(items).toEqual([]);
    expect(errors).toEqual([{ row: 1, reason: "Planilha vazia." }]);
  });

  it("detecta e aceita colagem separada por TAB (copiar/colar do Excel/Sheets)", () => {
    const csv = "nome\tpreco\tsku\nCamisa azul\t1500\tCAM-01";
    const { items, errors } = parseCatalogCsv(csv);
    expect(errors).toEqual([]);
    expect(items[0]?.question).toBe("Quanto custa Camisa azul?");
    expect(items[0]?.answer).toContain("SKU: CAM-01");
  });

  it("respeita campo entre aspas com vírgula interna", () => {
    const csv = 'nome,preco,variantes\n"Kit 3, 6 e 12 meses",250,"P, M, G"';
    const { items } = parseCatalogCsv(csv);
    expect(items[0]?.question).toBe("Quanto custa Kit 3, 6 e 12 meses?");
    expect(items[0]?.answer).toContain("Opções: P, M, G.");
  });
});
