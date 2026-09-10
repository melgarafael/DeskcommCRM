/**
 * Protocolo OAuth device-code do Codex — PURO (fetch injetável, sem SQL, sem
 * framework). O SQL mora em `armazenamento.ts`; a borda HTTP, nas rotas.
 *
 * Forma observada (NÃO documentada pela OpenAI — reconstruída do Codex CLI e
 * de terceiros como OpenCode/CLIProxyAPI): token endpoint em
 * `application/x-www-form-urlencoded`, scope com `offline_access` (sem ele,
 * sem refresh), device-code para ambientes sem browser local (o nosso caso:
 * VPS). Divergir da forma observada (ex.: JSON no token endpoint) é o jeito
 * mais rápido de ganhar um 400 que parece revogação.
 *
 * Fluxo: `iniciarDeviceCode` → operador abre `verificationUri` e digita
 * `userCode` no browser → tela faz poll em `trocarDeviceCodePorTokens` até
 * sair de `{pendente: true}` → refresh + account_id salvos cifrados. Depois,
 * cada turno chama `renovarAccessToken` (o access vive só em memória).
 *
 * Regra de quarentena (padrão Hermes): `invalid_grant`/401/403 é definitivo —
 * repetir o refresh morto só gera um rio de 401 idênticos. Quem marca é o
 * resolver; `ehRevogacaoDefinitiva` é o predicado único dos dois lados.
 */
import { CODEX_OAUTH_DEVICE_URL, CODEX_OAUTH_TOKEN_URL, codexClientId } from "./constantes";

const TIMEOUT_MS = 8_000;

/** Scope do Codex: `offline_access` é o que garante o refresh token. */
export const CODEX_SCOPE = "openid profile email offline_access";

function corpoForm(campos: Record<string, string>): { headers: Record<string, string>; body: string } {
  return {
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(campos).toString(),
  };
}

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
    { method: "POST", ...corpoForm({ client_id: clientId }) },
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
  | {
      pendente: false;
      refreshToken: string;
      accessToken: string;
      /** JWT de identidade — dele se extrai o `chatgpt_account_id` (ver abaixo). */
      idToken: string | null;
      expiresIn: number;
    };

export async function trocarDeviceCodePorTokens(
  deviceCode: string,
  fetchImpl: typeof fetch = fetch,
  clientId: string = codexClientId(),
): Promise<TrocaDeDevice> {
  const res = await timedFetch(
    CODEX_OAUTH_TOKEN_URL,
    {
      method: "POST",
      ...corpoForm({
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
  const j = (await res.json()) as {
    refresh_token: string;
    access_token: string;
    id_token?: string;
    expires_in: number;
  };
  return {
    pendente: false,
    refreshToken: j.refresh_token,
    accessToken: j.access_token,
    idToken: j.id_token ?? null,
    expiresIn: j.expires_in,
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
      ...corpoForm({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        scope: CODEX_SCOPE,
      }),
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
