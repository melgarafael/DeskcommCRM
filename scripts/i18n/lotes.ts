/**
 * OS LOTES DE TRADUÇÃO DE UM CATÁLOGO — as funções puras.
 *
 * Um catálogo inteiro (~10 mil frases) não se traduz de uma vez: ele é partido
 * em lotes (`lotes-para-traduzir.ts`), cada lote é traduzido à parte, e os lotes
 * voltam por uma porta só (`juntar-lotes.ts`), que recusa o que quebraria a tela.
 *
 * Moram aqui, sem I/O, para que `tests/unit/i18n-lotes-de-traducao` as cubra:
 * `tsconfig.typecheck.json` exclui `scripts/**`, e só o que um teste importa
 * passa pelo `tsc`. Os dois comandos são casca fina de leitura e escrita.
 */

/** O mesmo desenho de `tests/unit/catalogo-de-idioma-tem-forma`: `{x}` e `{{x}}`. */
const PLACEHOLDER = /\{\{?[A-Za-z_][A-Za-z0-9_]*\}?\}/g;

/** Os placeholders de um texto, na ordem em que aparecem. */
export function placeholdersDe(texto: string): string[] {
  return texto.match(PLACEHOLDER) ?? [];
}

/**
 * As chaves que ainda pedem tradução: a união das chaves das fontes, menos as
 * que já têm tradução não vazia. Em ordem, para os lotes saírem iguais a cada
 * rodada e um lote refeito substituir exatamente o anterior.
 */
export function chavesParaTraduzir(
  fontes: readonly Readonly<Record<string, unknown>>[],
  jaTraduzidas: Readonly<Record<string, string>>,
): string[] {
  const todas = new Set<string>();
  for (const fonte of fontes) for (const chave of Object.keys(fonte)) todas.add(chave);
  return [...todas].filter((chave) => !jaTraduzidas[chave]?.trim()).sort();
}

/**
 * As chaves de um lote traduzido que não podem entrar: valor vazio, ou
 * placeholders diferentes dos da chave. A ORDEM pode mudar (o turco põe o
 * complemento antes), o conjunto não: `{{nome}}` que vira `{nome}` deixa o
 * `.replace` sem alvo e a tela mostra a chave crua.
 *
 * O espaço das pontas também é da chave: `" (personalizada)"` é um pedaço que a
 * tela cola depois de outra palavra, e a tradução sem o espaço gruda as duas.
 */
export function validarLote(lote: Readonly<Record<string, string>>): string[] {
  const conjunto = (texto: string) => placeholdersDe(texto).sort().join();
  const pontas = (texto: string) => `${/^\s*/.exec(texto)?.[0]}|${/\s*$/.exec(texto)?.[0]}`;
  return Object.entries(lote)
    .filter(
      ([chave, valor]) =>
        typeof valor !== "string" ||
        !valor.trim() ||
        conjunto(chave) !== conjunto(valor) ||
        pontas(chave) !== pontas(valor),
    )
    .map(([chave]) => chave);
}

/**
 * As chaves de um lote traduzido que não estão no lote de origem. A chave é o
 * texto da tela: o tradutor que "corrige" uma aspa ou um espaço dela cria uma
 * entrada que nenhuma tela pede, e a frase de verdade continua em português.
 */
export function chavesForaDaOrigem(
  lote: Readonly<Record<string, string>>,
  origem: Readonly<Record<string, unknown>>,
): string[] {
  return Object.keys(lote).filter((chave) => !Object.prototype.hasOwnProperty.call(origem, chave));
}

/** O catálogo com os lotes por cima: o lote posterior vence, as chaves em ordem. */
export function juntarCatalogo(
  atual: Readonly<Record<string, string>>,
  lotes: readonly Readonly<Record<string, string>>[],
): Record<string, string> {
  const junto: Record<string, string> = { ...atual };
  for (const lote of lotes) Object.assign(junto, lote);
  const ordenado: Record<string, string> = {};
  for (const chave of Object.keys(junto).sort()) ordenado[chave] = junto[chave] as string;
  return ordenado;
}
