// @vitest-environment node
//
// Issue #102. Este arquivo existe porque `extractPdfText` estava mockado em TODOS
// os testes que o tocavam (`extractPdf: vi.fn(...)` em media-derive.test.ts), então
// nenhuma linha de pdfjs era executada pelo CI. O fallback ficou quebrado por um
// `GlobalWorkerOptions.workerSrc = ""` e o CI seguiu verde o tempo todo.
//
// O segundo teste é o que trava a regressão: ele força a falha do pdf-parse para
// exercitar o caminho do pdfjs — o mesmo caminho que estava morto.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const FIXTURE = join(process.cwd(), "tests/fixtures/sample-text.pdf");
const TEXTO_ESPERADO = "DeskcommCRM RAG fixture";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("pdf-parse");
});

describe("extractPdfText", () => {
  it("extrai texto de um PDF real", async () => {
    const { extractPdfText } = await import("@/lib/ai/rag/extractors/pdf");
    const texto = await extractPdfText(readFileSync(FIXTURE));
    expect(texto).toContain(TEXTO_ESPERADO);
  });

  it("cai no fallback do pdfjs quando o pdf-parse falha, e ainda extrai", async () => {
    // Sabota só o caminho primário. Se o fallback estiver quebrado, isto fica
    // vermelho — que é exatamente o que não acontecia antes desta correção.
    vi.doMock("pdf-parse", () => ({
      default: () => {
        throw new Error("pdf-parse sabotado de propósito");
      },
    }));
    vi.resetModules();

    const { extractPdfText } = await import("@/lib/ai/rag/extractors/pdf");
    const texto = await extractPdfText(readFileSync(FIXTURE));
    expect(texto).toContain(TEXTO_ESPERADO);
  });

  it("diz o que fazer quando o binário nativo do canvas falta", async () => {
    // O pdfjs 6 estoura no import sem @napi-rs/canvas. Sem esta tradução o
    // self-hoster vê "DOMMatrix is not defined" e não tem como ligar isso a uma
    // dependência opcional que ele nem sabe que existe.
    vi.doMock("pdf-parse", () => ({
      default: () => {
        throw new Error("pdf-parse sabotado de propósito");
      },
    }));
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
    await expect(extractPdfText(readFileSync(FIXTURE))).rejects.toThrow(PdfExtractError);
    await expect(extractPdfText(readFileSync(FIXTURE))).rejects.toThrow(/@napi-rs\/canvas/);
    vi.doUnmock("pdfjs-dist/legacy/build/pdf.mjs");
  });

  it("lança PdfExtractError quando o buffer não é PDF", async () => {
    const { extractPdfText, PdfExtractError } = await import("@/lib/ai/rag/extractors/pdf");
    await expect(extractPdfText(Buffer.from("isto não é um pdf"))).rejects.toBeInstanceOf(
      PdfExtractError,
    );
  });
});
