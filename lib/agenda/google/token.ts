/**
 * As duas chamadas de rede do OAuth do Google: trocar o código e renovar.
 *
 * É a fronteira entre a camada pura (`oauth.ts`, que lê e funde tokens sem
 * saber o que é rede) e o mundo. Tudo o que é decisão mora lá; aqui só mora o
 * `fetch` e a tradução da resposta.
 *
 * ─── Nenhuma das duas lança ───────────────────────────────────────────────
 *
 * As duas devolvem `LeituraDeToken`. Rede falha por motivos que não
 * controlamos, e um `throw` aqui viraria 500 numa rota que precisa redirecionar
 * o navegador com um motivo legível — ou pararia o worker de renovação no
 * primeiro timeout, deixando todas as outras agendas sem renovar junto.
 *
 * ─── O que a renovação NÃO faz, e é o ponto mais importante ───────────────
 *
 * Ela **não** grava nada e **não** funde nada. Devolve a resposta lida, e quem
 * chama funde com `fundirTokens` antes de persistir. A separação existe porque a
 * resposta de renovação vem SEM `refresh_token` — quem gravar direto o que
 * chegou aqui apaga a chave que acabou de renovar e mata a conexão na hora
 * seguinte. Deixar a fusão de fora obriga quem persiste a passar por ela.
 */

import { ENDERECO_DE_TOKEN, lerRespostaDeToken, type LeituraDeToken } from "./oauth";
import type { AppDoGoogleConfigurado } from "./config";

/** Quanto esperamos pelo Google antes de desistir de uma chamada de token. */
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
    // Sem resposta do Google, nada foi decidido do lado de lá. Quem chama
    // classifica com `classificarErroDoGoogle`, que lê isso como transitório.
    const motivo = erro instanceof Error ? erro.message : String(erro);
    return { ok: false, motivo: "resposta_invalida", detalhe: `sem resposta do Google: ${motivo}`, status: null };
  }

  // O corpo é lido MESMO em erro: é nele que vem `{"error":"invalid_grant"}`,
  // que é como o Google diz "o usuário revogou o acesso" — com HTTP 400, não
  // 401. Descartar o corpo por causa do status perderia o único sinal que
  // distingue "reconecte" de "tente de novo".
  //
  // O status só viaja quando o Google RECUSOU (não-2xx). Um 2xx que falha depois
  // — corpo cortado por timeout/reset no meio do JSON, ou sem `access_token` —
  // não é recusa: com o 200 junto, o cron classificaria `permanente` e marcaria
  // a agenda `error` por um soluço de rede (#2400). `null` = transitório.
  const statusDaRecusa = resposta.ok ? null : resposta.status;
  let bruto: unknown;
  try {
    bruto = await resposta.json();
  } catch {
    return {
      ok: false,
      motivo: "resposta_invalida",
      detalhe: `HTTP ${resposta.status} com corpo ilegível`,
      status: statusDaRecusa,
    };
  }

  return lerRespostaDeToken(bruto, { agora, status: statusDaRecusa });
}

/** Troca o `code` do consentimento pelo primeiro par de tokens. */
export async function trocarCodigoPorToken(
  app: AppDoGoogleConfigurado,
  code: string,
  opcoes: { agora: Date },
): Promise<LeituraDeToken> {
  return pedirToken(
    new URLSearchParams({
      code,
      client_id: app.clientId,
      client_secret: app.clientSecret,
      // O MESMO endereço do consentimento — o Google compara byte a byte, e é
      // por isso que ele tem uma fonte só (`config.ts`).
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
 * antes de gravar — ver o cabeçalho.
 */
export async function renovarToken(
  app: AppDoGoogleConfigurado,
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
