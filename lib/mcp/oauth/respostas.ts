/**
 * Respostas no formato do OAuth (RFC 6749 §5.1/§5.2), não no envelope
 * `{ data } / { error: { code } }` de `lib/api/wrappers.ts`.
 *
 * É contrato externo: o cliente de MCP (ChatGPT, Claude, Cursor…) lê
 * `access_token`, `error` e `error_description` no NÍVEL DE CIMA do JSON. O
 * envelope da casa quebraria todo cliente. O `X-Request-Id` vai igual (#4107).
 */
export type ErroOAuth =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "invalid_scope"
  | "invalid_target"
  | "invalid_client_metadata"
  | "invalid_redirect_uri"
  | "temporarily_unavailable"
  | "server_error"
  | "slow_down";

const SEM_CACHE = { "cache-control": "no-store", pragma: "no-cache" } as const;

export function respostaOAuth(corpo: unknown, status: number, requestId: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "content-type": "application/json", ...SEM_CACHE, "X-Request-Id": requestId, ...extra },
  });
}

export function erroOAuth(erro: ErroOAuth, descricao: string, status: number, requestId: string): Response {
  const extra: Record<string, string> = {};
  // RFC 6749 §5.2: invalid_client com 401 leva o desafio do esquema usado.
  if (erro === "invalid_client" && status === 401) extra["www-authenticate"] = 'Basic realm="mcp-oauth"';
  if (erro === "slow_down") extra["retry-after"] = "60";
  return respostaOAuth({ error: erro, error_description: descricao }, status, requestId, extra);
}

/**
 * Devolve um erro ao `redirect_uri` do cliente (RFC 6749 §4.1.2.1). Só depois
 * de conferido que o endereço é um dos REGISTRADOS por aquele cliente — senão
 * a rota de autorização vira um redirecionador aberto.
 */
export function urlDeVoltaComErro(redirectUri: string, erro: string, state: string | undefined, issuer: string): string {
  const u = new URL(redirectUri);
  u.searchParams.set("error", erro);
  if (state !== undefined) u.searchParams.set("state", state);
  u.searchParams.set("iss", issuer);
  return u.toString();
}

export function urlDeVoltaComCodigo(redirectUri: string, codigo: string, state: string | undefined, issuer: string): string {
  const u = new URL(redirectUri);
  u.searchParams.set("code", codigo);
  if (state !== undefined) u.searchParams.set("state", state);
  // RFC 9207: o cliente confere de que servidor o código veio.
  u.searchParams.set("iss", issuer);
  return u.toString();
}
