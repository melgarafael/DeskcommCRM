// @vitest-environment node
//
// Issue #102. Este arquivo nasceu porque `extractPdfText` estava mockado em TODOS
// os testes que o tocavam (`extractPdf: vi.fn(...)` em media-derive.test.ts), então
// nenhuma linha de pdfjs era executada pelo CI. A extração ficou quebrada por um
// `GlobalWorkerOptions.workerSrc = ""` e o CI seguiu verde o tempo todo.
//
// Issue #238. O arquivo tinha um teste "cai no fallback do pdf-parse", e ele não
// media o que dizia medir: o pdf-parse@1 falha com "bad XRef entry" na fixture
// `sample-text.pdf` deste repo, então o caminho primário JÁ estava morto e quem
// extraía era o fallback — nos dois testes. Hoje há uma engine só (pdfjs-dist), e
// as asserções abaixo são de igualdade EXATA de propósito: é isso que faz uma troca
// de engine, ou de estratégia de junção de linhas, ficar vermelha aqui.
//
// As fixtures são PDFs 1.4 escritos à mão (texto puro, `cat`-áveis), sem compressão
// e sem gerador — determinísticas byte a byte.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const raiz = process.cwd();
const fixture = (nome: string) => readFileSync(join(raiz, "tests/fixtures", nome));

afterEach(() => {
  vi.resetModules();
});

describe("extractPdfText", () => {
  it("extrai texto de um PDF real", async () => {
    const { extractPdfText } = await import("@/lib/ai/rag/extractors/pdf");
    expect(await extractPdfText(fixture("sample-text.pdf"))).toBe("DeskcommCRM RAG fixture");
  });

  it("preserva a acentuação do português", async () => {
    // Acentuação é o primeiro lugar onde uma troca de engine estraga texto sem
    // quebrar teste nenhum — o PDF codifica em WinAnsi e alguém tem de decodificar.
    const { extractPdfText } = await import("@/lib/ai/rag/extractors/pdf");
    expect(await extractPdfText(fixture("sample-acentos.pdf"))).toBe(
      "Ação de vendas: café, órgão, três.",
    );
  });

  it("preserva quebra de linha dentro da página e separa páginas por linha em branco", async () => {
    // O chunker do RAG corta por estrutura; se a extração achatar tudo numa linha só,
    // o texto continua "certo" e a recuperação piora em silêncio.
    const { extractPdfText } = await import("@/lib/ai/rag/extractors/pdf");
    expect(await extractPdfText(fixture("sample-multipagina.pdf"))).toBe(
      "Pagina um linha um\nPagina um linha dois\n\nPagina dois linha um\nPagina dois linha dois",
    );
  });

  it("lança PdfExtractError quando o PDF é válido mas não tem texto algum", async () => {
    // O caso "PDF digitalizado / só imagem": a fixture abre sem erro nenhum, tem uma
    // página e zero itens de texto. É o único caminho em que a engine trabalha até o
    // fim e mesmo assim não há o que ingerir — sem esta fixture, a guarda de texto
    // vazio não é exercitada por teste nenhum.
    const { extractPdfText, PdfExtractError } = await import("@/lib/ai/rag/extractors/pdf");
    await expect(extractPdfText(fixture("sample-sem-texto.pdf"))).rejects.toBeInstanceOf(
      PdfExtractError,
    );
    await expect(extractPdfText(fixture("sample-sem-texto.pdf"))).rejects.toThrow(
      /imagens escaneadas/,
    );
  });

  it("lança PdfExtractError quando o buffer não é PDF", async () => {
    const { extractPdfText, PdfExtractError } = await import("@/lib/ai/rag/extractors/pdf");
    await expect(extractPdfText(Buffer.from("isto não é um pdf"))).rejects.toBeInstanceOf(
      PdfExtractError,
    );
  });

  it("lança PdfExtractError quando o PDF tem cabeçalho válido mas corpo corrompido", async () => {
    // Pior que o buffer aleatório: começa com %PDF-, então passa por qualquer
    // checagem de assinatura e só morre dentro da engine.
    const { extractPdfText, PdfExtractError } = await import("@/lib/ai/rag/extractors/pdf");
    await expect(extractPdfText(fixture("sample-corrompido.pdf"))).rejects.toBeInstanceOf(
      PdfExtractError,
    );
  });

  it("diz o que fazer quando o binário nativo do canvas falta", async () => {
    // O pdfjs 6 estoura no import sem @napi-rs/canvas. Sem esta tradução o
    // self-hoster vê "DOMMatrix is not defined" e não tem como ligar isso a uma
    // dependência opcional que ele nem sabe que existe.
    //
    // Na VPS o erro nasce no IMPORT do módulo. Aqui ele nasce no getDocument, e é
    // fiel ao que importa: o branch decide pela MENSAGEM, não pelo ponto de origem.
    // (Mockar o factory para lançar não serve — o vitest reembrulha e a mensagem some.)
    vi.doMock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
      GlobalWorkerOptions: {},
      getDocument: () => {
        throw new Error("DOMMatrix is not defined");
      },
    }));
    vi.resetModules();

    const { extractPdfText, PdfExtractError } = await import("@/lib/ai/rag/extractors/pdf");
    await expect(extractPdfText(fixture("sample-text.pdf"))).rejects.toThrow(PdfExtractError);
    await expect(extractPdfText(fixture("sample-text.pdf"))).rejects.toThrow(/@napi-rs\/canvas/);
    vi.doUnmock("pdfjs-dist/legacy/build/pdf.mjs");
  });

  it("tem uma engine só: pdf-parse não volta como dependência", async () => {
    // O pdf-parse@1 carrega 29 MB de pdf.js vendorizado (quatro cópias) e fixa a de
    // 2018 — 7 majors atrás da que já está aqui. Isso é peso na imagem Docker do
    // self-host em troca de uma engine PIOR. Se alguém readicionar, este teste conta.
    const pkg = JSON.parse(readFileSync(join(raiz, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const todas = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(todas)).not.toContain("pdf-parse");
    expect(Object.keys(todas)).not.toContain("@types/pdf-parse");
  });
});
