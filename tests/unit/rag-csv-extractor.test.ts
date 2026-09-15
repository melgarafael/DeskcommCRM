import { describe, expect, it } from "vitest";

import { CSV_MAX_LINHAS_DE_DADOS, CsvExtractError, extractCsvText } from "@/lib/ai/rag/extractors/csv";

describe("extractCsvText", () => {
  it("converte cada linha em um bloco 'Coluna: valor', separado por linha em branco", () => {
    const csv = "codigo,nome,preco\n1,Cadeira Gamer,599\n2,Mesa,899";
    expect(extractCsvText(Buffer.from(csv))).toBe(
      "codigo: 1\nnome: Cadeira Gamer\npreco: 599\n\ncodigo: 2\nnome: Mesa\npreco: 899",
    );
  });

  it("aceita ponto-e-vírgula (export pt-BR do Excel)", () => {
    const csv = "nome;cargo\nAna;Gerente";
    expect(extractCsvText(Buffer.from(csv))).toBe("nome: Ana\ncargo: Gerente");
  });

  it("preserva acentuação decodificando windows-1252 quando não é UTF-8 válido", () => {
    const cabecalho = Buffer.from("produto,descricao\n", "utf8");
    // "Promoção" em windows-1252 (ç=0xE7, ã=0xE3 fora do range ASCII)
    const linha = Buffer.from([0x50, 0x72, 0x6f, 0x6d, 0x6f, 0xe7, 0xe3, 0x6f, 0x2c, 0x78]);
    const buffer = Buffer.concat([cabecalho, linha]);
    expect(extractCsvText(buffer)).toBe("produto: Promoção\ndescricao: x");
  });

  it("pula campo vazio e campo sem nome de coluna", () => {
    const csv = "nome,,telefone\nAna,,\nBia,,+5511999998888";
    expect(extractCsvText(Buffer.from(csv))).toBe("nome: Ana\n\nnome: Bia\ntelefone: +5511999998888");
  });

  it("recusa arquivo vazio", () => {
    expect(() => extractCsvText(Buffer.from(""))).toThrow(CsvExtractError);
  });

  it("recusa arquivo só com cabeçalho", () => {
    expect(() => extractCsvText(Buffer.from("nome,telefone"))).toThrow(
      /só tem cabeçalho/,
    );
  });

  it("recusa quando nenhuma linha tem conteúdo", () => {
    expect(() => extractCsvText(Buffer.from("nome,telefone\n,\n,"))).toThrow(
      /nenhuma linha tem conteúdo/,
    );
  });

  it("recusa binário (ex.: .xlsx renomeado para .csv) com a mensagem que ensina a exportar", () => {
    // Bytes altos inválidos como UTF-8 (densos o bastante pra não passar por
    // "sujeira pontual") mais um byte de controle fora de TAB/CR/LF — a mesma
    // prova que `decodificarCsv` usa para pegar um .xlsx disfarçado de .csv.
    const binarioXlsx = Buffer.from([0xff, 0xff, 0xff, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    expect(() => extractCsvText(binarioXlsx)).toThrow(/CSV UTF-8/);
  });

  it("recusa acima do limite de linhas de dado", () => {
    const linhas = Array.from({ length: CSV_MAX_LINHAS_DE_DADOS + 1 }, (_, i) => `${i}`).join("\n");
    const csv = `id\n${linhas}`;
    expect(() => extractCsvText(Buffer.from(csv))).toThrow(
      new RegExp(`limite para material de conhecimento é ${CSV_MAX_LINHAS_DE_DADOS}`),
    );
  });

  it("aceita exatamente o limite de linhas de dado", () => {
    const linhas = Array.from({ length: CSV_MAX_LINHAS_DE_DADOS }, (_, i) => `${i}`).join("\n");
    const csv = `id\n${linhas}`;
    expect(() => extractCsvText(Buffer.from(csv))).not.toThrow();
  });
});
