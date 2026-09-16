/**
 * As duas chamadas de rede do OAuth do Google Ads: trocar o código e renovar.
 *
 * Irmão declarado de `lib/agenda/google/token.ts` — mesma fronteira (decisão
 * pura em `oauth.ts`, rede aqui), mesma disciplina (nenhuma das duas lança; a
 * renovação não grava nem funde nada, ver o cabeçalho do irmão).
 */

import { ENDERECO_DE_TOKEN, lerRespostaDeToken, type LeituraDeToken } from "./oauth";
import type { AppDoGoogleAdsConfigurado } from "./config";

const PRAZO_MS = 10_000;

async function pedirToken(corpo: URLSearchParams, agora: Date): Promise<LeituraDeToken> {
  let resposta: Response;
  try {
    resposta = await fetch(ENDERECO_DE_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: corpo.toString(),
      signal: AbortSignal.timeout(PRAZO_MS),
      cache: "no-store",
    });
  } catch (erro) {
    const motivo = erro instanceof Error ? erro.message : String(erro);
    return { ok: false, motivo: "resposta_invalida", detalhe: `sem resposta do Google: ${motivo}` };
  }

  let bruto: unknown;
  try {
    bruto = await resposta.json();
  } catch {
    return {
      ok: false,
      motivo: "resposta_invalida",
      detalhe: `HTTP ${resposta.status} com corpo ilegível`,
    };
  }

  return lerRespostaDeToken(bruto, { agora });
}

/** Troca o `code` do consentimento pelo primeiro par de tokens. */
export async function trocarCodigoPorToken(
  app: AppDoGoogleAdsConfigurado,
  code: string,
  opcoes: { agora: Date },
): Promise<LeituraDeToken> {
  return pedirToken(
    new URLSearchParams({
      code,
      client_id: app.clientId,
      client_secret: app.clientSecret,
      redirect_uri: app.redirectUri,
      grant_type: "authorization_code",
    }),
    opcoes.agora,
  );
}

/**
 * Renova o `access_token` com o `refresh_token`.
 *
 * ⚠️ A resposta vem SEM `refresh_token`. Passe o resultado por `fundirTokens`
 * antes de usar, se for persistir algo — o transporte de conversão (que só
 * precisa do `access_token` fresco para UMA chamada) não persiste nada aqui.
 */
export async function renovarToken(
  app: AppDoGoogleAdsConfigurado,
  refreshToken: string,
  opcoes: { agora: Date },
): Promise<LeituraDeToken> {
  return pedirToken(
    new URLSearchParams({
      refresh_token: refreshToken,
      client_id: app.clientId,
      client_secret: app.clientSecret,
      grant_type: "refresh_token",
    }),
    opcoes.agora,
  );
}
