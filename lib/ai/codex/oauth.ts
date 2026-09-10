/**
 * Protocolo OAuth device-code do Codex — PURO (fetch injetável, sem SQL, sem
 * framework). O SQL mora em `armazenamento.ts`; a borda HTTP, nas rotas.
 *
 * Fluxo: `iniciarDeviceCode` → operador abre `verificationUri` e digita
 * `userCode` no browser → tela faz poll em `trocarDeviceCodePorTokens` até
 * sair de `{pendente: true}` → refresh salvo cifrado. Depois, cada turno
 * chama `renovarAccessToken` (o access vive só em memória).
 *
 * Regra de quarentena (padrão Hermes): `invalid_grant`/401/403 é definitivo —
 * repetir o refresh morto só gera um rio de 401 idênticos. Quem marca é o
 * resolver; `ehRevogacaoDefinitiva` é o predicado único dos dois lados.
 */
import { CODEX_OAUTH_DEVICE_URL, CODEX_OAUTH_TOKEN_URL, codexClientId } from "./constantes";

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

/** HTTP 4xx terminal ou invalid_grant/revoked → quarentena local, sem replay. */
export function ehRevogacaoDefinitiva(status: number, code?: string): boolean {
  if (code === "invalid_grant" || code === "revoked" || code === "invalid_request") return true;
  return status === 400 || status === 401 || status === 403;
}

export interface DeviceCodeSessao {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  intervalSecs: number;
}

export async function iniciarDeviceCode(
  fetchImpl: typeof fetch = fetch,
  clientId: string = codexClientId(),
): Promise<DeviceCodeSessao> {
  const res = await timedFetch(
    CODEX_OAUTH_DEVICE_URL,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: clientId }),
    },
    fetchImpl,
  );
  if (!res.ok) throw new Error(`codex_device_init_${res.status}`);
  const j = (await res.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval?: number;
  };
  return {
    deviceCode: j.device_code,
    userCode: j.user_code,
    verificationUri: j.verification_uri,
    expiresIn: j.expires_in,
    intervalSecs: j.interval ?? 5,
  };
}

export type TrocaDeDevice =
  | { pendente: true }
  | { pendente: false; refreshToken: string; accessToken: string; expiresIn: number };

export async function trocarDeviceCodePorTokens(
  deviceCode: string,
  fetchImpl: typeof fetch = fetch,
  clientId: string = codexClientId(),
): Promise<TrocaDeDevice> {
  const res = await timedFetch(
    CODEX_OAUTH_TOKEN_URL,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: clientId,
      }),
    },
    fetchImpl,
  );
  if (res.status === 400) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    if (j.error === "authorization_pending" || j.error === "slow_down") return { pendente: true };
  }
  if (!res.ok) throw new Error(`codex_device_poll_${res.status}`);
  const j = (await res.json()) as { refresh_token: string; access_token: string; expires_in: number };
  return { pendente: false, refreshToken: j.refresh_token, accessToken: j.access_token, expiresIn: j.expires_in };
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
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
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
  const j = (await res.json()) as { access_token: string; expires_in: number };
  return { accessToken: j.access_token, expiresIn: j.expires_in };
}
