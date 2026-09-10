/**
 * Protocolo OAuth device-code do Codex — PURO (fetch injetável, sem SQL, sem
 * framework). O SQL mora em `armazenamento.ts`; a borda HTTP, nas rotas.
 *
 * FORMA OBSERVADA (NÃO documentada pela OpenAI — espelha `ai-sdk-codex-oauth`
 * e o Codex CLI):
 *   1. `iniciarDeviceCode` → POST deviceauth/usercode (JSON `{client_id}`) →
 *      `{user_code, device_auth_id, interval}`; o OPERADOR abre
 *      `https://auth.openai.com/codex/device` e digita o código;
 *   2. `trocarDeviceCodePorTokens` → POST deviceauth/token (JSON
 *      `{device_auth_id, user_code}`) → 403/404 = pendente; 200 =
 *      `{authorization_code, code_verifier}` → troca no token endpoint
 *      (FORM `{grant_type: authorization_code, ...}`) → tokens;
 *   3. cada turno chama `renovarAccessToken` (FORM `{grant_type:
 *      refresh_token, ...}`) — o access vive só em memória.
 *
 * Regra de quarentena (padrão Hermes): `invalid_grant`/401/403 no REFRESH é
 * definitivo — repetir o refresh morto só gera um rio de 401 idênticos. Quem
 * marca é o resolver; `ehRevogacaoDefinitiva` é o predicado único dos dois lados.
 */
import {
  CODEX_DEVICE_AUTH_URL,
  CODEX_DEVICE_REDIRECT_URI,
  CODEX_DEVICE_TOKEN_URL,
  CODEX_DEVICE_VERIFY_URL,
  CODEX_OAUTH_TOKEN_URL,
  codexClientId,
} from "./constantes";

const TIMEOUT_MS = 8_000;

async function timedFetch(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function corpoForm(campos: Record<string, string>): { headers: Record<string, string>; body: string } {
  return {
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(campos).toString(),
  };
}

/**
 * Extrai o `chatgpt_account_id` do JWT de identidade — o backend do Codex
 * exige esse valor no header `ChatGPT-Account-ID` de CADA chamada de chat.
 * Sem guardá-lo no connect, o spike de execução não tem como montar o
 * envelope de identidade.
 *
 * Fallback em 3 níveis (observado em terceiros): `chatgpt_account_id` topo →
 * `https://api.openai.com/auth.chatgpt_account_id` → `organizations[0].id`.
 * Sem verificação de assinatura: é a NOSSA credencial, lida para a NOSSA
 * contabilidade — nunca aceita de terceiros, nunca decide acesso.
 */
export function extrairIdDaConta(idToken: string | null): string | null {
  if (!idToken) return null;
  const partes = idToken.split(".");
  const payloadB64 = partes[1];
  if (partes.length !== 3 || !payloadB64) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as Record<string, unknown>;
    const direto = payload["chatgpt_account_id"];
    if (typeof direto === "string" && direto !== "") return direto;
    const auth = payload["https://api.openai.com/auth"];
    if (typeof auth === "object" && auth !== null) {
      const aninhado = (auth as Record<string, unknown>)["chatgpt_account_id"];
      if (typeof aninhado === "string" && aninhado !== "") return aninhado;
    }
    const orgs = payload["organizations"];
    if (Array.isArray(orgs)) {
      const primeira = orgs[0] as { id?: unknown } | undefined;
      if (typeof primeira?.id === "string" && primeira.id !== "") return primeira.id;
    }
    return null;
  } catch {
    return null;
  }
}

/** HTTP 4xx terminal ou invalid_grant/revoked → quarentena local, sem replay. */
export function ehRevogacaoDefinitiva(status: number, code?: string): boolean {
  if (code === "invalid_grant" || code === "revoked" || code === "invalid_request") return true;
  return status === 400 || status === 401 || status === 403;
}

export interface DeviceCodeSessao {
  /** O que o operador digita em CODEX_DEVICE_VERIFY_URL. */
  userCode: string;
  /** Id da sessão de device (vai no poll junto do userCode). */
  deviceAuthId: string;
  verificationUri: string;
  /** Segundos até a sessão expirar (quando o provedor informa). */
  expiresIn: number;
  /** Segundos entre polls (margem anti-429 já aplicada pelo chamador). */
  intervalSecs: number;
}

export async function iniciarDeviceCode(
  fetchImpl: typeof fetch = fetch,
  clientId: string = codexClientId(),
): Promise<DeviceCodeSessao> {
  const res = await timedFetch(
    CODEX_DEVICE_AUTH_URL,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: clientId }),
    },
    fetchImpl,
  );
  if (!res.ok) throw new Error(`codex_device_init_${res.status}`);
  const j = (await res.json()) as {
    user_code: string;
    device_auth_id: string;
    verification_uri?: string;
    expires_in?: number;
    interval?: number | string;
  };
  return {
    userCode: j.user_code,
    deviceAuthId: j.device_auth_id,
    verificationUri: j.verification_uri ?? CODEX_DEVICE_VERIFY_URL,
    expiresIn: typeof j.expires_in === "number" ? j.expires_in : 600,
    intervalSecs: Number(j.interval ?? 5),
  };
}

export type TrocaDeDevice =
  | { pendente: true }
  | {
      pendente: false;
      refreshToken: string;
      accessToken: string;
      /** JWT de identidade — dele se extrai o `chatgpt_account_id` (ver acima). */
      idToken: string | null;
      expiresIn: number;
    };

export async function trocarDeviceCodePorTokens(
  deviceAuthId: string,
  userCode: string,
  fetchImpl: typeof fetch = fetch,
  clientId: string = codexClientId(),
): Promise<TrocaDeDevice> {
  const poll = await timedFetch(
    CODEX_DEVICE_TOKEN_URL,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    },
    fetchImpl,
  );
  // 403/404 = o operador ainda não aprovou. Qualquer outro não-200 aqui é
  // erro de verdade (sessão expirada, p. ex.) — não "pendente".
  if (poll.status === 403 || poll.status === 404) return { pendente: true };
  if (!poll.ok) throw new Error(`codex_device_poll_${poll.status}`);
  const aprovado = (await poll.json()) as { authorization_code: string; code_verifier: string };

  const troca = await timedFetch(
    CODEX_OAUTH_TOKEN_URL,
    {
      method: "POST",
      ...corpoForm({
        grant_type: "authorization_code",
        code: aprovado.authorization_code,
        redirect_uri: CODEX_DEVICE_REDIRECT_URI,
        client_id: clientId,
        code_verifier: aprovado.code_verifier,
      }),
    },
    fetchImpl,
  );
  if (!troca.ok) throw new Error(`codex_device_exchange_${troca.status}`);
  const j = (await troca.json()) as {
    refresh_token: string;
    access_token: string;
    id_token?: string;
    expires_in?: number;
  };
  return {
    pendente: false,
    refreshToken: j.refresh_token,
    accessToken: j.access_token,
    idToken: j.id_token ?? null,
    expiresIn: typeof j.expires_in === "number" ? j.expires_in : 3600,
  };
}

export async function renovarAccessToken(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
  clientId: string = codexClientId(),
): Promise<{ accessToken: string; expiresIn: number }> {
  const res = await timedFetch(
    CODEX_OAUTH_TOKEN_URL,
    {
      method: "POST",
      ...corpoForm({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
    },
    fetchImpl,
  );
  if (!res.ok) {
    const code = res.status === 400 ? "invalid_grant" : undefined;
    const err = new Error(`codex_refresh_${res.status}`) as Error & { status?: number; code?: string };
    err.status = res.status;
    err.code = code;
    throw err;
  }
  const j = (await res.json()) as { access_token: string; expires_in?: number };
  return { accessToken: j.access_token, expiresIn: typeof j.expires_in === "number" ? j.expires_in : 3600 };
}
