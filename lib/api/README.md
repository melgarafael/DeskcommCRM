# lib/api/

Helpers e convenções compartilhadas por toda rota `/api/v1/*`.

- `wrappers.ts` — `ok(data, opts)` / `fail(code, message, status, opts)` / `noContent()` + tipos `ApiSuccess<T>` / `ApiError`
- `errors.ts` — `ApiErrorCodes` (constante canônica de códigos)

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
- `idempotency.ts` — helper de idempotência de POST: replay (mesma chave e mesmo corpo devolve a resposta gravada) e conflito (mesma chave e corpo diferente devolve `conflito`, para a rota responder 409). Persiste na tabela Postgres `idempotency_keys` com janela de 24h — **não** em Upstash, como esta linha dizia (a spec 01 §7.3 previa Redis; a implementação é Postgres).
- `rate-limit.ts` — sliding window via Upstash; injeta headers `X-RateLimit-*`
- `pagination.ts` — encode/decode de cursor opaco base64 + HMAC
- `audit.ts` — fire-and-forget write em `api_audit_log`
- `cors.ts` — allowlist por tenant
