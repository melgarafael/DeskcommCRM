/**
 * PDF text extractor for the RAG ingestion pipeline.
 *
 * Primary: pdf-parse (fast, handles most PDFs).
 * Fallback: pdfjs-dist legacy build (handles layout-heavy/scanned PDFs).
 * Both fail → throws PdfExtractError.
 */

import type * as PdfjsDist from "pdfjs-dist";

export class PdfExtractError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "PdfExtractError";
  }
}

/**
 * Extracts plain text from a PDF buffer.
 * Tries pdf-parse first; falls back to pdfjs-dist on failure.
 * Throws `PdfExtractError` if both strategies fail.
 */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  // --- Primary: pdf-parse ---
  try {
    const pdfParse = (await import("pdf-parse")).default;
    const result = await pdfParse(buffer);
    const text = (result.text ?? "").trim();
    if (text.length > 0) return text;
    // Empty text from pdf-parse — may be an image-only PDF; fall through to pdfjs
    console.warn("[pdf-extract] pdf-parse returned empty text — trying pdfjs fallback");
  } catch (err) {
    console.warn("[pdf-extract] pdf-parse failed, trying pdfjs-dist fallback:", err);
  }

  // --- Fallback: pdfjs-dist legacy build ---
  try {
    const pdfjsLib = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as typeof PdfjsDist;

    // NÃO mexa em GlobalWorkerOptions.workerSrc aqui (issue #102).
    //
    // Havia um `workerSrc = ""` nesta linha, com a intenção de "desligar o worker
    // em Node". O efeito era o oposto: string vazia é falsy, e o getter
    // `PDFWorker.workerSrc` lança `No "GlobalWorkerOptions.workerSrc" specified.`
    // ANTES de ler um byte do arquivo — ou seja, o fallback inteiro era inalcançável,
    // e o erro chegava ao usuário como a mensagem genérica lá de baixo.
    //
    // Em Node o pdf.js já se auto-configura; as três linhas sobrescreviam justamente
    // o que a lib tinha preparado. Medido nas versões 4.10.38 e 6.2.108: com
    // `workerSrc = ""` falha nas duas; sem tocar, extrai nas duas.
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
    const pdfDocument = await loadingTask.promise;

    const pageTexts: string[] = [];
    for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
      const page = await pdfDocument.getPage(pageNum);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .trim();
      if (pageText.length > 0) pageTexts.push(pageText);
    }

    const combined = pageTexts.join("\n\n").trim();
    if (combined.length === 0) {
      throw new PdfExtractError("pdfjs-dist extracted no text (possibly image-only PDF)");
    }
    return combined;
  } catch (err) {
    if (err instanceof PdfExtractError) throw err;

    // O pdfjs 6 faz `new DOMMatrix()` no topo do módulo e depende do
    // `@napi-rs/canvas` (optionalDependency) para o polyfill. Sem esse binário —
    // plataforma sem binding publicado, registry corporativo sem os artefatos, ou
    // instalação com optional deps podadas — ele estoura no IMPORT, antes de ler o
    // arquivo. A versão 4 só avisava e extraía o texto assim mesmo.
    //
    // Sem esta mensagem, quem instalou vê "DOMMatrix is not defined" e não tem como
    // ligar isso a uma dependência que ele nem sabe que existe. O diagnóstico custa
    // 4 linhas; a caçada custa uma tarde.
    if (err instanceof Error && /DOMMatrix|@napi-rs\/canvas/.test(err.message)) {
      throw new PdfExtractError(
        "Extração de PDF indisponível: o binário nativo @napi-rs/canvas não foi instalado " +
          "nesta plataforma. Reinstale as dependências SEM podar as opcionais " +
          "(`pnpm install`, não `--no-optional`). Até lá, PDFs não são lidos.",
        err,
      );
    }

    throw new PdfExtractError("Both pdf-parse and pdfjs-dist failed to extract text", err);
  }
}
