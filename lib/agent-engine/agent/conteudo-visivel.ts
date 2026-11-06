/**
 * Texto sem nada visível é texto vazio para a bolha do cliente (spec 28).
 *
 * `trim()` tira espaço e quebra de linha, mas não tira caractere de formatação
 * invisível: `U+200E` (marca de direção), `U+200B` (espaço de largura zero),
 * `U+FEFF`, `U+2060` e afins. Uma resposta feita só disso passava pela trava
 * `corpo_vazio` e chegava ao WhatsApp como bolha em branco — medido em produção,
 * 26/10/2026, numa mensagem da IA de comprimento 1 contendo só `U+200E`.
 *
 * A régua é a categoria Unicode `Cf` (formatação), somada ao espaço em branco.
 * Qualquer outra coisa — inclusive um emoji — é conteúdo.
 */
export function semConteudoVisivel(texto: string | null | undefined): boolean {
  return /^[\s\p{Cf}]*$/u.test(texto ?? "");
}
