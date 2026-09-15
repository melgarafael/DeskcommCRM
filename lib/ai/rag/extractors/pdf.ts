/**
 * PDF text extractor for the RAG ingestion pipeline.
 *
 * UMA engine: pdfjs-dist (build `legacy`, que é a que roda em Node).
 * Uma tentativa só. Se ela falhar, lança PdfExtractError — não há segunda.
 *
 * Este arquivo já teve duas tentativas (pdf-parse como primária, pdfjs como
 * fallback) e elas NÃO eram duas engines. O pdf-parse@1 vendoriza quatro cópias
 * completas do pdf.js da Mozilla dentro de si — 29 dos 29 MB do pacote estão em
 * `lib/` — e fixa a `v1.10.100`, de 2018. Ou seja: era o MESMO pdf.js duas vezes,
 * com 7 majors de distância, e a cópia velha rodava PRIMEIRO.
 *
 * Medido na issue #238: a v1.10.100 falha com "bad XRef entry" na própria fixture
 * deste repo (`tests/fixtures/sample-text.pdf`) e com "Illegal character: 41" num
 * PDF gerado pelo @react-pdf/renderer. A "primária" já estava morta há tempos e
 * quem extraía era o fallback — o teste verde media o caminho de baixo achando que
 * media o de cima. Redundância que não é redundante é código morto, e este arquivo
 * já pagou por isso uma vez (issue #102, no comentário lá embaixo).
 */

import type * as PdfjsDist from "pdfjs-dist";

export class PdfExtractError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "PdfExtractError";
  }
}

/**
 * Extrai texto puro de um buffer de PDF usando pdfjs-dist.
 * Lança `PdfExtractError` se o arquivo for ilegível ou não tiver texto algum.
 */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    const pdfjsLib = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as typeof PdfjsDist;

    // NÃO mexa em GlobalWorkerOptions.workerSrc aqui (issue #102).
    //
    // Havia um `workerSrc = ""` nesta linha, com a intenção de "desligar o worker
    // em Node". O efeito era o oposto: string vazia é falsy, e o getter
    // `PDFWorker.workerSrc` lança `No "GlobalWorkerOptions.workerSrc" specified.`
    // ANTES de ler um byte do arquivo — ou seja, a extração inteira era inalcançável,
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

      // A quebra de linha vem do `hasEOL` do próprio pdf.js, não de comparar o Y do
      // `transform`. Medido na issue #238 com um PDF que tem "10,00" + um "2"
      // sobrescrito na MESMA linha visual: agrupar por `transform[5]` (o que o
      // pdf-parse fazia) devolve `"Assinatura R$ 10,00\n2 \npor mes"` — três linhas
      // onde há uma —, enquanto `hasEOL` devolve `"Assinatura R$ 10,002 por mes"`.
      // O sobrescrito muda o Y sem terminar a linha; só a engine sabe disso.
      const pageText = content.items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
        .join("")
        .trim();
      if (pageText.length > 0) pageTexts.push(pageText);
    }

    const combined = pageTexts.join("\n\n").trim();
    if (combined.length === 0) {
      throw new PdfExtractError(
        "não consegui extrair texto deste PDF. Se ele for só imagens escaneadas, " +
          "não há letra nenhuma para ler — envie uma versão com texto selecionável.",
      );
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

    throw new PdfExtractError(
      `falhou ao ler o PDF: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
}
