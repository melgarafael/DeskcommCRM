/**
 * A LEGENDA SÓ EXISTE ONDE O CANAL A LEVA (#3151).
 *
 * Áudio é o ÚNICO tipo que não leva texto: todos os adaptadores de canal em
 * `lib/channels/` mandam a nota de voz SEM `caption` — ao contrário de imagem,
 * vídeo e documento, que levam. Pedir legenda de um áudio é escrever um texto
 * que nunca chega.
 *
 * A régua mora aqui, num módulo puro, porque DOIS lugares precisam da MESMA
 * resposta: o diálogo de prévia (para mostrar ou esconder o campo) e o envio do
 * compositor (para saber com QUAL anexo da fila a legenda viaja). Regra
 * duplicada em duas telas divergiria na primeira mudança.
 */
export function anexoLevaLegenda(file: File): boolean {
  return !file.type.startsWith("audio/");
}

/**
 * O índice do anexo que leva a legenda: o PRIMEIRO que a aceita, porque é ele
 * que abre a mensagem. `-1` quando nenhum leva (fila só de áudio) — e aí a
 * legenda não sai com anexo nenhum, em vez de viajar com um áudio que a
 * descarta em silêncio.
 *
 * Não é sempre o 0: uma fila [áudio, imagem] leva a legenda na imagem.
 */
export function indiceDaLegenda(files: File[]): number {
  return files.findIndex(anexoLevaLegenda);
}
