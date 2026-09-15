/**
 * CSV text extractor for the RAG ingestion pipeline.
 *
 * Reusa `decodificarCsv`/`parseCsv` de `lib/contacts/csv.ts` em vez de duplicar
 * charset e parsing: aquele arquivo já resolve o problema difícil (Excel pt-BR
 * exporta cp1252, detecção de delimitador, `.xlsx` renomeado para `.csv` que
 * chegaria como binário) e é o único lugar que deve saber disso. Duplicar aqui
 * criaria uma segunda verdade sobre "o que é um CSV válido" que envelhece sozinha.
 *
 * Por que não XLSX: mesma decisão de `lib/contacts/csv.ts` — o repo não carrega
 * SheetJS/exceljs para uma leitura que todo Excel já exporta como CSV. `.xlsx` é
 * recusado na BORDA (rota de upload), nunca chega até aqui.
 *
 * Formato de saída: cada linha de dado vira um bloco `Coluna: valor` (uma por
 * campo, pulando campo vazio ou sem cabeçalho), blocos separados por linha em
 * branco — o chunker (`lib/ai/rag/chunker.ts`) trata cada bloco como um
 * parágrafo, então cada linha da planilha vira uma unidade de busca própria em
 * vez de virar uma tabela ilegível depois de embedada.
 */

import { decodificarCsv, parseCsv } from "@/lib/contacts/csv";

export class CsvExtractError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CsvExtractError";
  }
}

/**
 * Defensivo: acima disso o material vira milhares de chunks embedados por um
 * envio só. Quem tem mais dado que isso é catálogo/import, não conhecimento —
 * as rotas de `lib/catalogo` e `lib/leads` continuam sendo o caminho certo.
 */
export const CSV_MAX_LINHAS_DE_DADOS = 2000;

/**
 * Extrai texto buscável de um buffer CSV.
 * Lança `CsvExtractError` com frase de gente em toda falha.
 */
export function extractCsvText(buffer: Buffer): string {
  const decodificado = decodificarCsv(buffer);
  if ("erro" in decodificado) {
    throw new CsvExtractError(decodificado.erro);
  }

  const linhas = parseCsv(decodificado.texto);
  if (linhas.length === 0) {
    throw new CsvExtractError("a planilha está vazia");
  }

  const [cabecalho, ...dados] = linhas as [string[], ...string[][]];
  if (dados.length === 0) {
    throw new CsvExtractError("a planilha só tem cabeçalho, sem linha de dado nenhuma");
  }
  if (dados.length > CSV_MAX_LINHAS_DE_DADOS) {
    throw new CsvExtractError(
      `a planilha tem ${dados.length} linhas de dado — o limite para material de conhecimento ` +
        `é ${CSV_MAX_LINHAS_DE_DADOS}. Divida em arquivos menores ou use o catálogo de produtos.`,
    );
  }

  const blocos = dados
    .map((linha) =>
      cabecalho
        .map((coluna, i) => {
          const nomeColuna = coluna.trim();
          const valor = (linha[i] ?? "").trim();
          if (!nomeColuna || !valor) return null;
          return `${nomeColuna}: ${valor}`;
        })
        .filter((campo): campo is string => campo !== null)
        .join("\n"),
    )
    .filter((bloco) => bloco.length > 0);

  if (blocos.length === 0) {
    throw new CsvExtractError("nenhuma linha tem conteúdo para indexar");
  }

  return blocos.join("\n\n");
}
