/**
 * O arquivo do relatório de vendas — a parte pura (#4802, item 5).
 *
 * O que se mede aqui é FORMATO, não número: BOM, `;`, CRLF, decimal com vírgula,
 * célula com separador entre aspas, fórmula neutralizada e o nome datado. A
 * igualdade com a tela é medida na rota
 * (`app/api/v1/reports/vendas/export/route.test.ts`), comparando as duas
 * respostas.
 */
import { describe, expect, it } from "vitest";

import {
  COLUNAS_DO_RELATORIO,
  SEPARADOR,
  csvDoRelatorioDeVendas,
  nomeDoArquivoDoRelatorio,
  segundosComVirgula,
  urlDaExportacao,
  type LinhaDoRelatorio,
} from "./vendas-csv";

function linha(parcial: Partial<LinhaDoRelatorio> = {}): LinhaDoRelatorio {
  return {
    atendente: "Ana Souza",
    won: 4,
    lost: 1,
    conversations_handled: 9,
    avg_first_response_seconds: 900,
    median_first_response_seconds: 120,
    ...parcial,
  };
}

describe("o CSV do relatório de vendas", () => {
  it("sai com BOM, `;`, CRLF e as colunas da tela", () => {
    const csv = csvDoRelatorioDeVendas([linha()]);

    expect(csv.startsWith("\uFEFF")).toBe(true);
    const [cabecalho, dados] = csv.replace(/^\uFEFF/, "").split("\r\n");
    expect(cabecalho).toBe(COLUNAS_DO_RELATORIO.join(SEPARADOR));
    expect(cabecalho).toContain("ganhos");
    expect(cabecalho).toContain("perdidos");
    expect(dados).toBe("Ana Souza;4;1;9;900;120");
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("decimal com VÍRGULA — é o que o Excel em português lê como número", () => {
    expect(segundosComVirgula(1.5)).toBe("1,5");
    expect(segundosComVirgula(12.345)).toBe("12,35");
    expect(segundosComVirgula(900)).toBe("900");
    // Não medida é VAZIA, nunca 0: zero diria "respondeu na hora zero".
    expect(segundosComVirgula(null)).toBe("");
    expect(segundosComVirgula(undefined)).toBe("");
  });

  it("célula que começa com fórmula vira texto — a planilha não executa", () => {
    const csv = csvDoRelatorioDeVendas([linha({ atendente: '=HYPERLINK("http://x")' })]);

    expect(csv).toContain("'=HYPERLINK");
  });

  it("nome com `;` sai entre aspas, senão a linha ganharia uma coluna", () => {
    const csv = csvDoRelatorioDeVendas([linha({ atendente: "Silva; Ana" })]);

    expect(csv).toContain('"Silva; Ana";4;1;9;900;120');
  });

  it("lista vazia devolve só o cabeçalho — quem decide recusar é a rota", () => {
    const csv = csvDoRelatorioDeVendas([]);

    expect(csv.replace(/^\uFEFF/, "")).toBe(`${COLUNAS_DO_RELATORIO.join(SEPARADOR)}\r\n`);
  });
});

describe("o nome do arquivo", () => {
  it("diz O QUE É e QUAL é o período, sem acento nem espaço", () => {
    const nome = nomeDoArquivoDoRelatorio({
      from: new Date("2026-09-01T00:00:00.000Z"),
      to: new Date("2026-10-01T00:00:00.000Z"),
    });

    expect(nome).toBe("vendas-por-atendente-2026-09-01_a_2026-10-01.csv");
    expect(nome).not.toMatch(/[^\w.-]/);
  });
});

describe("a URL que o botão da tela abre", () => {
  it("sem filtro é o conjunto inteiro; com filtro, o atendente viaja na query", () => {
    expect(urlDaExportacao()).toBe("/api/v1/reports/vendas/export");
    expect(urlDaExportacao(null)).toBe("/api/v1/reports/vendas/export");
    expect(urlDaExportacao("33333333-3333-4333-8333-333333333333")).toBe(
      "/api/v1/reports/vendas/export?owner_user_id=33333333-3333-4333-8333-333333333333",
    );
  });
});
