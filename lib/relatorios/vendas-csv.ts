/**
 * O ARQUIVO do relatório de vendas (#4802, item 5) — CSV com o formato das
 * exportações que já existem.
 *
 * ─── O formato, copiado e não inventado ─────────────────────────────────────
 *
 * Mesmo envelope da casa: `text/csv; charset=utf-8`, `Content-Disposition:
 * attachment` com nome datado, BOM na frente. BOM e `;` são a dupla que faz o
 * Excel em português abrir acento e colunas certos — a régua escrita em
 * `lib/prospecting/exportar.ts` e em `lib/contacts/exportar.ts`, que este
 * módulo segue em vez de criar um segundo jeito de exportar.
 *
 * `;` de separador, e não `,`: quem recebe este arquivo abre no Excel pt-BR, que
 * divide por ponto e vírgula; com `,` a planilha joga a linha inteira numa
 * coluna só. Pelo mesmo motivo o decimal sai com VÍRGULA (`1,5`) — é o que o
 * Excel em português lê como número. Com `;` de separador a vírgula decimal é
 * inequívoca: não há ambiguidade entre separador de campo e separador de
 * decimal.
 *
 * CRLF (RFC 4180) e quebra final, como o export de prospecção.
 *
 * ─── O que o cabeçalho diz ──────────────────────────────────────────────────
 *
 * Os nomes são os da TELA, em português: quem abre o arquivo reconhece a coluna
 * de onde copiou. `atendente` é a linha da tabela "Performance por atendente" —
 * o nome resolvido pela régua de `rotuloDoMembro` (nome → e-mail → "Atendente
 * <sufixo>"), nunca o uuid cru.
 *
 * Segundos, e não "2 min": o arquivo é para ANÁLISE externa; duração formatada
 * não soma nem ordena em planilha. O decimal é vírgula, e média/mediana não
 * medidas saem VAZIAS — `0` diria "respondeu na hora zero".
 */
import { neutralizarFormula } from "@/lib/csv/neutralizar-formula";
import {
  parametrosDaJanela,
  type DiasDoPeriodo,
  type JanelaIso,
} from "@/lib/metrics/periodo-do-desempenho";

/** O separador do Excel em pt-BR — o mesmo de `lib/prospecting/exportar.ts`. */
export const SEPARADOR = ";";

/**
 * As colunas, na ordem da tabela da tela (menos o uuid, que não é coluna).
 *
 * `ganhos`/`perdidos`/`conversas` são exatamente os números da tabela; as duas
 * últimas são o par "média / mediana" que a tela pinta na mesma célula.
 */
export const COLUNAS_DO_RELATORIO = [
  "atendente",
  "ganhos",
  "perdidos",
  "conversas",
  "primeira_resposta_media_segundos",
  "primeira_resposta_mediana_segundos",
] as const;

/** Uma linha do arquivo: o rótulo já resolvido + os números da tela. */
export interface LinhaDoRelatorio {
  /** O nome do atendente, resolvido pela régua de `rotuloDoMembro`. */
  atendente: string;
  won: number;
  lost: number;
  conversations_handled: number;
  avg_first_response_seconds: number | null;
  median_first_response_seconds: number | null;
}

/**
 * Segundos com vírgula decimal, no máximo duas casas e sem zero à toa:
 * `900` → `900`, `1.5` → `1,5`, `12.345` → `12,35`. `null` → vazio.
 */
export function segundosComVirgula(valor: number | null | undefined): string {
  if (valor === null || valor === undefined || !Number.isFinite(valor)) return "";
  const arredondado = Math.round(valor * 100) / 100;
  return String(arredondado).replace(".", ",");
}

/** RFC 4180 com `;`; célula que começa com fórmula vira texto (Excel). */
function celula(valor: unknown): string {
  if (valor === null || valor === undefined) return "";
  const texto = neutralizarFormula(String(valor).replace(/\s+/g, " ").trim());
  if (texto.includes(SEPARADOR) || texto.includes('"') || /[\n\r]/.test(texto)) {
    return `"${texto.replace(/"/g, '""')}"`;
  }
  return texto;
}

/** O arquivo inteiro: BOM + cabeçalho + uma linha por atendente. */
export function csvDoRelatorioDeVendas(linhas: readonly LinhaDoRelatorio[]): string {
  const corpo = [
    COLUNAS_DO_RELATORIO.join(SEPARADOR),
    ...linhas.map((linha) =>
      [
        linha.atendente,
        linha.won,
        linha.lost,
        linha.conversations_handled,
        segundosComVirgula(linha.avg_first_response_seconds),
        segundosComVirgula(linha.median_first_response_seconds),
      ]
        .map(celula)
        .join(SEPARADOR),
    ),
  ];
  return `\uFEFF${corpo.join("\r\n")}\r\n`;
}

/**
 * `vendas-por-atendente-AAAA-MM-DD_a_AAAA-MM-DD.csv`.
 *
 * O nome diz O QUE É e QUAL É O PERÍODO — sem acento, espaço nem dois-pontos,
 * que o navegador e o sistema de arquivos tratam mal. Os dois recortes vêm da
 * JANELA EXPORTADA (não do dia de hoje): um arquivo de 30 dias baixado hoje e o
 * mesmo recorte baixado amanhã não podem se chamar igual na pasta de downloads.
 */
export function nomeDoArquivoDoRelatorio({ de, ate }: DiasDoPeriodo): string {
  return `vendas-por-atendente-${de}_a_${ate}.csv`;
}

/**
 * A URL do arquivo a partir do filtro da tela (`null` = todos os atendentes).
 *
 * A query é a MESMA que a rota lê (`owner_user_id`), e é ela que faz o arquivo
 * sair com o recorte visível em vez do mundo inteiro. Puro para o botão poder
 * ser medido sem navegador.
 */
export function urlDaExportacao(ownerUserId?: string | null, janela?: JanelaIso): string {
  const busca = parametrosDaJanela(janela);
  if (ownerUserId) busca.set("owner_user_id", ownerUserId);
  return `/api/v1/reports/vendas/export${busca.size ? `?${busca}` : ""}`;
}
