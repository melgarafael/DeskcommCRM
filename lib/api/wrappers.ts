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
// Atalhos comuns
// -----------------------------------------------------------------------------

export const noContent = (requestId?: string) => {
  const res = new NextResponse(null, { status: 204 });
  res.headers.set("X-Request-Id", requestId ?? randomUUID());
  return res;
};
