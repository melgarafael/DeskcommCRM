# lib/api/

Helpers e convenções compartilhadas por toda rota `/api/v1/*`.

- `wrappers.ts` — `ok(data, opts)` / `fail(code, message, status, opts)` / `noContent()` + tipos `ApiSuccess<T>` / `ApiError`
- `errors.ts` — `ApiErrorCodes` (constante canônica de códigos)
- `idempotency.ts` — `comIdempotencia`: reserva antes do efeito, replay (mesma chave e corpo devolvem a resposta gravada) e conflito (mesma chave com corpo diferente, para o chamador responder 409). Persiste em `idempotency_keys`, com recibo de 24h e reserva de 60s.

## Exemplo

```ts
import { ok, fail } from "@/lib/api/wrappers";
import { ApiErrorCodes } from "@/lib/api/errors";

export async function GET(req: Request) {
  const data = await fetchSomething();
  if (!data) return fail(ApiErrorCodes.not_found, "Lead não encontrado", 404);
  return ok(data, { meta: { cursor: nextCursor, has_more: true } });
}
```

## A adicionar (próximas specs)

- `auth.ts` — extrai user / tenant da request (cookie OU bearer); valida MFA; retorna `AuthContext`
- `rate-limit.ts` — sliding window via Upstash; injeta headers `X-RateLimit-*`
- `pagination.ts` — encode/decode de cursor opaco base64 + HMAC
- `audit.ts` — fire-and-forget write em `api_audit_log`
- `cors.ts` — allowlist por tenant
