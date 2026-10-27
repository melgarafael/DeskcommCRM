/**
 * A régua de FORMA das strings que viram CSS — o ÚNICO lugar destas regexes.
 *
 * Extraída de `lib/branding/css.ts` para que ela possa ser reusada por outros
 * emissores de custom property (o gancho de tema de extensão) sem arrastar a
 * cadeia de importação do branding — `css.ts` puxa `rampa.ts`/`resolve.ts`,
 * que um pacote declarativo não deve precisar conhecer.
 *
 * Duas definições de "que forma é segura" divergem, e a que perde é sempre a
 * que ninguém está olhando. Uma só régua, aqui, para todo texto que o
 * navegador vai executar.
 */

/** `--nome-do-token`. Sem maiúscula, sem escape, sem espaço. */
const NOME_DE_TOKEN = /^--[a-z][a-z0-9-]*$/;

/**
 * As três formas de valor que este produto emite. Ancoradas nas duas pontas
 * (`^`/`$`) de propósito: sem âncora, `#ff0000; } body { x` casaria o prefixo e
 * passaria com o resto pendurado.
 */
const FORMAS_DE_VALOR: readonly RegExp[] = [
  /^#[0-9a-f]{3}$/i,
  /^#[0-9a-f]{6}$/i,
  /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/,
  /^rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(?:0|1|0?\.\d{1,4})\s*\)$/,
  /^var\(--[a-z][a-z0-9-]*\)$/,
];

export function ehNomeDeToken(valor: string): boolean {
  return NOME_DE_TOKEN.test(valor);
}

export function ehFormaDeValorPermitida(valor: string): boolean {
  return FORMAS_DE_VALOR.some((forma) => forma.test(valor));
}