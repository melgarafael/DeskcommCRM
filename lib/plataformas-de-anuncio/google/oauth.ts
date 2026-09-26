/**
 * O consentimento e o token do Google Ads — a parte pura.
 *
 * Irmão declarado de `lib/agenda/google/oauth.ts` — mesmas três armadilhas
 * (sem `prompt=consent` não vem `refresh_token`; a renovação não repete o
 * `refresh_token`; `expires_in` é relativo, não absoluto), mesma cura para
 * cada uma. Pede o escopo da API escolhida: `adwords` nas conexões legadas
 * ou `datamanager` na nova autorização. A escolha viaja no state assinado.
 *
 * Sem rede, sem `process.env` e sem relógio próprio — ver o cabeçalho do
 * irmão para o porquê.
 */

import type { ApiDeConversaoGoogle } from "../types";

export const ESCOPO_DATA_MANAGER = "https://www.googleapis.com/auth/datamanager";

export const ESCOPO_OBRIGATORIO = "https://www.googleapis.com/auth/adwords";

export const ENDERECO_DE_CONSENTIMENTO = "https://accounts.google.com/o/oauth2/v2/auth";
export const ENDERECO_DE_TOKEN = "https://oauth2.googleapis.com/token";

/** Renovar com folga, não no vencimento — mesmo valor do irmão da Agenda. */
export const FOLGA_DE_RENOVACAO_MS = 60_000;

export interface AppDoGoogleAds {
  clientId: string;
  redirectUri: string;
}

/**
 * A URL para onde mandamos o admin da organização autorizar a conta de Ads.
 *
 * Lança quando o app não está configurado — mesma disciplina do irmão: quem
 * chama transforma isto no cartão "conectar o Google Ads ainda não está
 * configurado".
 */
export function montarUrlDeConsentimento(
  app: AppDoGoogleAds,
  opcoes: { state: string; api?: ApiDeConversaoGoogle },
): string {
  const clientId = app.clientId?.trim();
  const redirectUri = app.redirectUri?.trim();
  if (!clientId)
    throw new Error(
      "GOOGLE_ADS_OAUTH_CLIENT_ID ausente: não há app OAuth para pedir consentimento",
    );
  if (!redirectUri)
    throw new Error("redirect_uri ausente: o Google exige o endereço de retorno registrado");
  if (!opcoes.state?.trim())
    throw new Error("state ausente: sem ele o retorno do Google não é verificável");

  const parametros = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: opcoes.api === "data_manager" ? ESCOPO_DATA_MANAGER : ESCOPO_OBRIGATORIO,
    // Sem `offline` não vem refresh_token nenhum; sem `consent` ele some na
    // segunda vez — mesma armadilha 1 do irmão da Agenda.
    access_type: "offline",
    prompt: "consent",
    state: opcoes.state,
  });

  return `${ENDERECO_DE_CONSENTIMENTO}?${parametros.toString()}`;
}

export interface TokenDoGoogleAds {
  access_token: string;
  /** `null` quando a resposta não trouxe — ver `fundirTokens`. */
  refresh_token: string | null;
  token_type: string;
  /** Instante absoluto, ISO-8601. Nunca o `expires_in` relativo. */
  expira_em: string;
}

export type MotivoDeTokenIlegivel = "resposta_invalida" | "erro_do_google" | "sem_access_token";

export type LeituraDeToken =
  | { ok: true; token: TokenDoGoogleAds }
  | { ok: false; motivo: MotivoDeTokenIlegivel; detalhe: string };

function texto(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Lê a resposta do endpoint de token — mesma disciplina do irmão: nunca lança. */
export function lerRespostaDeToken(bruto: unknown, opcoes: { agora: Date }): LeituraDeToken {
  if (typeof bruto !== "object" || bruto === null) {
    return {
      ok: false,
      motivo: "resposta_invalida",
      detalhe: `resposta não é objeto: ${typeof bruto}`,
    };
  }
  const r = bruto as Record<string, unknown>;

  const erro = texto(r.error);
  if (erro) {
    const descricao = texto(r.error_description);
    return {
      ok: false,
      motivo: "erro_do_google",
      detalhe: descricao ? `${erro}: ${descricao}` : erro,
    };
  }

  const accessToken = texto(r.access_token);
  if (!accessToken) {
    return { ok: false, motivo: "sem_access_token", detalhe: "resposta sem `access_token`" };
  }

  const expiresInBruto =
    typeof r.expires_in === "string" ? Number(r.expires_in.trim()) : r.expires_in;
  const expiresIn =
    typeof expiresInBruto === "number" && Number.isFinite(expiresInBruto) ? expiresInBruto : null;
  const expiraEm =
    expiresIn === null
      ? new Date(opcoes.agora.getTime())
      : new Date(opcoes.agora.getTime() + expiresIn * 1000);

  return {
    ok: true,
    token: {
      access_token: accessToken,
      refresh_token: texto(r.refresh_token),
      token_type: texto(r.token_type) ?? "Bearer",
      expira_em: expiraEm.toISOString(),
    },
  };
}

/**
 * Escreve o token novo por cima do velho SEM perder o `refresh_token` — mesma
 * armadilha 2 do irmão da Agenda.
 */
export function fundirTokens(
  atual: TokenDoGoogleAds | null | undefined,
  novo: TokenDoGoogleAds,
): TokenDoGoogleAds {
  return {
    access_token: novo.access_token,
    refresh_token: novo.refresh_token ?? atual?.refresh_token ?? null,
    token_type: novo.token_type || atual?.token_type || "Bearer",
    expira_em: novo.expira_em,
  };
}
