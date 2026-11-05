/**
 * O id de UMA requisição, resolvido num lugar só.
 *
 * ─── Por que isto existe ─────────────────────────────────────────────────────
 * O id da resposta tem de ser o MESMO que a rota grava no registro daquela
 * requisição (auditoria, `logger`), senão o número que a tela mostra não leva a
 * lugar nenhum. Havia dois geradores: o `proxy.ts` cunhava um id e o carimbava
 * na resposta, e a rota cunhava outro com `randomUUID()` e gravava esse no
 * registro. Como o Next aplica os cabeçalhos do middleware DEPOIS dos da rota
 * (mesmo nome é sobrescrito — medido no Next 16.3.6: a rota grava
 * `X-Request-Id: AAA` e o cliente recebe o id do proxy), a resposta sempre saía
 * com um id que não existia em log nenhum.
 *
 * A regra agora é uma: **quem monta a resposta carimba o id daquela
 * requisição**, e o id nasce do cabeçalho de entrada quando ele é um UUID
 * válido (é o caso de uma chamada interna ou de um relato de cliente que já
 * traz o id) ou é cunhado uma vez. O `proxy.ts` deixou de carimbar sob `/api/`
 * justamente porque ele não conhece o id da rota.
 *
 * ─── Por que validar o formato ──────────────────────────────────────────────
 * O cabeçalho vem do cliente. Sem régua, qualquer texto entra no log e na
 * auditoria — inclusive um valor gigante ou com quebra de linha, que é
 * superfície de injeção em quem lê log. Só UUID (v1–v8) passa; o resto é
 * descartado e um id novo é cunhado.
 */

import type { NextRequest } from "next/server";

/** Nome canônico; HTTP não diferencia maiúsculas, então `set`/`get` conversam. */
const CABECALHO = "x-request-id";

/**
 * UUID nas versões que aparecem de verdade: v4 (cunhado aqui), v1/v7 (quem usa
 * id ordenado por tempo), v3/v5 (derivados). A variante é sempre RFC 4122.
 */
const FORMATO_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * O id desta requisição.
 *
 * Idempotente por requisição: o primeiro a chamar grava o id no cabeçalho da
 * própria requisição, então quem chamar depois (a rota, para gravar no
 * registro) recebe exatamente o mesmo valor — sem precisar passá-lo adiante.
 */
export function idDaRequisicao(req: { headers: Headers }): string {
  const recebido = req.headers.get(CABECALHO)?.trim() ?? "";
  if (FORMATO_UUID.test(recebido)) return recebido;

  // `crypto.randomUUID` (Web Crypto) e não `node:crypto`: este módulo é
  // importado pelo `proxy.ts`, que roda no runtime de borda.
  const novo = crypto.randomUUID();
  req.headers.set(CABECALHO, novo);
  return novo;
}

/**
 * Carimba o id na resposta — sem sobrescrever quem já escolheu um.
 *
 * `ok()`/`fail()` já devolvem o id que a rota lhes passou; respeitá-lo é o que
 * evita duas fontes de verdade no mesmo cabeçalho.
 */
export function comIdDaRequisicao<R extends Response>(res: R, requestId: string): R {
  if (!res.headers.has("X-Request-Id")) res.headers.set("X-Request-Id", requestId);
  return res;
}

/**
 * O mesmo carimbo para quem monta a resposta à mão: embrulha o handler inteiro.
 *
 * Uma rota que devolve `new Response(...)` (arquivo, QR, stream, redirect,
 * webhook) não passa por `ok()`/`fail()`, e são várias saídas por handler —
 * embrulhar cada `return` é churn que a próxima rota esquece. Aqui a garantia
 * fica na borda do handler: qualquer `Response` que ele devolva, seja qual for
 * o formato, sai com o id da requisição.
 *
 * O `idDaRequisicao` roda ANTES do handler de propósito: ele grava o id no
 * cabeçalho da requisição, então o `idDaRequisicao(req)` que a rota chama para
 * gravar o registro devolve o mesmo valor (inclusive fora do Next, quando não
 * há `proxy.ts` para cunhar).
 */
export function rotaComIdDaRequisicao<C = unknown, R extends Response = Response>(
  handler: (req: NextRequest, contexto: C) => Promise<R> | R,
): (req: NextRequest, contexto?: C) => Promise<R> {
  return async (req: NextRequest, contexto?: C) => {
    const requestId = idDaRequisicao(req);
    // `contexto` é opcional de propósito: o Next sempre chama com ele, mas os
    // handlers que não usam `params` (e os testes, que chamam só com a
    // requisição) não devem ser obrigados a inventar um.
    return comIdDaRequisicao(await handler(req, contexto as C), requestId);
  };
}
