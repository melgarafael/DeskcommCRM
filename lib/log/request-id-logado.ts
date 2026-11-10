/**
 * "Este `requestId` já apareceu numa linha de log?" — memória curta de processo.
 *
 * Existe por causa de um único chamador: `fail()` (lib/api/wrappers.ts). Desde
 * a #3971 ele grava o ID que devolve no `X-Request-Id`, para que o `ID:` que a
 * tela mostra sempre exista no log. Só que ~95 rotas JÁ gravam o `requestId`
 * antes de chamar `fail()` — e ali a linha da rota é melhor: ela carrega a
 * causa (`error.message`), a organização, o canal. Se `fail()` gravasse sempre,
 * essas rotas passariam a ter duas linhas para o mesmo id, e a segunda não
 * acrescentaria nada.
 *
 * Como `fail()` não tem como saber o que a rota já logou (não muda assinatura,
 * não toca as 2.6 mil chamadas), a informação vai por aqui: o `logger` registra
 * os ids que saíram numa linha, `fail()` consulta antes de gravar a dele.
 *
 * ## Por que um `Set` de módulo, e não `AsyncLocalStorage`
 *
 * O par "rota grava → rota chama fail()" acontece na MESMA pilha síncrona, no
 * mesmo processo. Um ALS exigiria abrir contexto no começo de cada requisição
 * (proxy/instrumentation), o que é bem mais peça para o mesmo resultado.
 *
 * O preço é memória de processo: por isso o conjunto é LIMITADO (descarta o
 * mais antigo). O intervalo entre o log da rota e o `fail()` é de microssegundos
 * — 500 ids de folga é ordens de magnitude mais do que qualquer rajada
 * concorrente nesse intervalo. Se um id for evicted antes da consulta, o pior
 * caso é a linha extra do `fail()`: o id continua no log, que é o que importa.
 */

/** Quantos ids a memória curta guarda antes de descartar o mais antigo. */
const TETO = 500;

const vistos = new Set<string>();

/**
 * Anota que este `requestId` já foi para o log. Chamado pelo `logger` em toda
 * linha que traz um. Id ausente, vazio ou que não seja string é ignorado.
 */
export function registrarRequestIdLogado(ctx?: Record<string, unknown>): void {
  const id = ctx?.requestId;
  if (typeof id !== "string" || id.length === 0) return;

  if (vistos.size >= TETO) {
    const maisAntigo = vistos.values().next().value;
    if (maisAntigo !== undefined) vistos.delete(maisAntigo);
  }
  vistos.add(id);
}

/** `true` quando este id já saiu numa linha de log nesta janela do processo. */
export function requestIdJaLogado(id: string): boolean {
  return vistos.has(id);
}
