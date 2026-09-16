/**
 * As três chamadas de rede do OAuth do Instagram: trocar o código, trocar por
 * token de longa duração, e buscar o perfil. Nenhuma lança — rede falha por
 * motivos que não controlamos, e um `throw` aqui viraria 500 numa rota pública
 * que precisa responder com uma página legível para o lead.
 */
import type { InstagramApp } from "./apps";
import {
  enderecoDePerfil,
  ENDERECO_DE_TOKEN_CURTO,
  ENDERECO_DE_TOKEN_LONGO,
  lerRespostaDePerfil,
  lerRespostaDeTokenCurto,
  lerRespostaDeTokenLongo,
  type LeituraDePerfil,
  type LeituraDeTokenCurto,
  type LeituraDeTokenLongo,
} from "./oauth";

const PRAZO_MS = 10_000;

async function lerJson(resposta: Response): Promise<unknown> {
  try {
    return await resposta.json();
  } catch {
    return null;
  }
}

export async function trocarCodigoPorTokenCurto(
  app: InstagramApp,
  code: string,
  redirectUri: string,
): Promise<LeituraDeTokenCurto> {
  let resposta: Response;
  try {
    resposta = await fetch(ENDERECO_DE_TOKEN_CURTO, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: app.appId,
        client_secret: app.appSecret,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code,
      }).toString(),
      signal: AbortSignal.timeout(PRAZO_MS),
      cache: "no-store",
    });
  } catch (erro) {
    const motivo = erro instanceof Error ? erro.message : String(erro);
    return { ok: false, motivo: "resposta_invalida", detalhe: `sem resposta do Instagram: ${motivo}` };
  }
  const bruto = await lerJson(resposta);
  if (bruto === null) {
    return { ok: false, motivo: "resposta_invalida", detalhe: `HTTP ${resposta.status} com corpo ilegível` };
  }
  return lerRespostaDeTokenCurto(bruto);
}

export async function trocarTokenCurtoPorLongo(
  app: InstagramApp,
  tokenCurto: string,
  opcoes: { agora: Date },
): Promise<LeituraDeTokenLongo> {
  const url = new URL(ENDERECO_DE_TOKEN_LONGO);
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", app.appSecret);
  url.searchParams.set("access_token", tokenCurto);

  let resposta: Response;
  try {
    resposta = await fetch(url, { signal: AbortSignal.timeout(PRAZO_MS), cache: "no-store" });
  } catch (erro) {
    const motivo = erro instanceof Error ? erro.message : String(erro);
    return { ok: false, motivo: "resposta_invalida", detalhe: `sem resposta do Instagram: ${motivo}` };
  }
  const bruto = await lerJson(resposta);
  if (bruto === null) {
    return { ok: false, motivo: "resposta_invalida", detalhe: `HTTP ${resposta.status} com corpo ilegível` };
  }
  return lerRespostaDeTokenLongo(bruto, opcoes);
}

export async function buscarPerfil(accessToken: string): Promise<LeituraDePerfil> {
  const url = new URL(enderecoDePerfil());
  url.searchParams.set("fields", "id,username,account_type");
  url.searchParams.set("access_token", accessToken);

  let resposta: Response;
  try {
    resposta = await fetch(url, { signal: AbortSignal.timeout(PRAZO_MS), cache: "no-store" });
  } catch (erro) {
    const motivo = erro instanceof Error ? erro.message : String(erro);
    return { ok: false, motivo: "resposta_invalida", detalhe: `sem resposta do Instagram: ${motivo}` };
  }
  const bruto = await lerJson(resposta);
  if (bruto === null) {
    return { ok: false, motivo: "resposta_invalida", detalhe: `HTTP ${resposta.status} com corpo ilegível` };
  }
  return lerRespostaDePerfil(bruto);
}
