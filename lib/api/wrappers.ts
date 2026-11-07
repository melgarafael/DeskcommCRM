/**
 * Wrappers canônicos de API (sucesso e erro).
 *
 * Toda rota `/api/v1/*` DEVE usar `ok()` / `fail()` em vez de NextResponse direto.
 * Garante:
 *  - Formato consistente { data, meta? } / { error: { code, message, details? } }
 *  - Header X-Request-Id correlacionando com audit log
 *  - Status codes corretos (200/201/204/400/401/403/404/409/422/429/500)
 */

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { requestIdJaLogado } from "@/lib/log/request-id-logado";
import { logger } from "@/lib/logger";
import type { ApiErrorCode } from "@/lib/api/errors";

// -----------------------------------------------------------------------------
// Tipos públicos
// -----------------------------------------------------------------------------

export type CursorMeta = {
  cursor?: string | null;
  has_more?: boolean;
  total?: number | null;
};

export type ApiSuccess<T> = {
  data: T;
  meta?: CursorMeta & Record<string, unknown>;
};

export type ApiError = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

type OkOptions = {
  status?: 200 | 201 | 204;
  meta?: ApiSuccess<unknown>["meta"];
  requestId?: string;
  headers?: HeadersInit;
};

export function ok<T>(data: T, opts: OkOptions = {}): NextResponse<ApiSuccess<T>> {
  const { status = 200, meta, requestId, headers } = opts;
  const body: ApiSuccess<T> = meta ? { data, meta } : { data };

  const res = NextResponse.json(body, { status, headers });
  res.headers.set("X-Request-Id", requestId ?? randomUUID());
  return res;
}

type FailOptions = {
  details?: unknown;
  requestId?: string;
  headers?: HeadersInit;
};

export function fail(
  code: ApiErrorCode | (string & {}),
  message: string,
  status: number,
  opts: FailOptions = {},
): NextResponse<ApiError> {
  const body: ApiError = {
    error: {
      code,
      message,
      ...(opts.details !== undefined ? { details: opts.details } : {}),
    },
  };

  // O ID é resolvido UMA vez (#3971): é o mesmo que vai no header e no log. Até
  // aqui, sem `requestId` do chamador, ele era um UUID gerado só para o header
  // — o `ID:` da tela não existia em lugar nenhum.
  const requestId = opts.requestId ?? randomUUID();

  const res = NextResponse.json(body, { status, headers: opts.headers });
  res.headers.set("X-Request-Id", requestId);

  // 5xx é defeito nosso, e é o caso em que alguém vai PROCURAR este ID no log:
  // a resposta não diz o que houve, por desenho. Fora daqui não há outra linha
  // garantida — ~1/5 das rotas grava a própria, as demais não gravam nada.
  //
  // 4xx fica de fora: é recusa esperada (validação, permissão, estado), e uma
  // linha por recusa encheria o log justamente onde ele precisa ser lido.
  // Quando a rota JÁ gravou o ID (as ~95 que fazem isso), a linha dela fica e
  // esta não sai: ela carrega a causa e a organização, que esta não tem. O
  // registro do `logger` é quem sabe disso — ver lib/log/request-id-logado.ts.
  if (status >= 500 && !requestIdJaLogado(requestId)) {
    logger.error("api: resposta de erro sem log da rota", { requestId, code, status });
  }

  return res;
}

// -----------------------------------------------------------------------------
// Resposta montada à mão (#4107)
// -----------------------------------------------------------------------------

/**
 * Carimba o `X-Request-Id` numa resposta que NÃO passa por `ok()`/`fail()` —
 * arquivo, imagem, redirect, stream, `new NextResponse(null, { status: 401 })`.
 *
 * O id é o MESMO que a rota grava no log e na auditoria: o `x-request-id` que o
 * `proxy.ts` pôs na requisição (`requestIdOf`). Nada de `randomUUID()` novo aqui
 * — dois ids para a mesma requisição é o defeito que o #3971 fechou.
 *
 * `Response.redirect()` devolve cabeçalhos IMUTÁVEIS; nesse caso a resposta é
 * reconstruída com os mesmos status e cabeçalhos, mais o id. (O `body` de um
 * redirect é sempre vazio.)
 */
export function comIdDaRequisicao<T extends Response>(res: T, reqOuId: Request | string | null | undefined): T {
  const doHeader =
    typeof reqOuId === "string" ? reqOuId : reqOuId?.headers.get("x-request-id");
  const requestId = doHeader && doHeader.length > 0 ? doHeader : randomUUID();

  // Quem já carimbou o PRÓPRIO id (o export de tenant, o `/api/mcp`) manda: ali
  // o id foi resolvido junto com a auditoria da rota, e trocá-lo por outro
  // desfaria justamente a correlação que este helper existe para garantir.
  if (res.headers.has("X-Request-Id")) return res;

  try {
    res.headers.set("X-Request-Id", requestId);
    return res;
  } catch {
    // Cabeçalhos IMUTÁVEIS (todo `Response.redirect` reconstruído por
    // `NextResponse.redirect`): refazer a resposta com os mesmos status e
    // cabeçalhos, mais o id. É um `NextResponse` — quem chama pode ainda pôr
    // cookie na resposta (os callbacks de OAuth fazem), e um `Response` puro
    // quebraria isso em tempo de execução sem o tsc ver.
    const cabecalhos = new Headers(res.headers);
    cabecalhos.set("X-Request-Id", requestId);
    return new NextResponse(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: cabecalhos,
    }) as unknown as T;
  }
}

// -----------------------------------------------------------------------------
// Atalhos comuns
// -----------------------------------------------------------------------------

export const noContent = (requestId?: string) => {
  const res = new NextResponse(null, { status: 204 });
  res.headers.set("X-Request-Id", requestId ?? randomUUID());
  return res;
};
