import type { TokensDoCodex } from "@/lib/ai/pontos/pkce-da-assinatura";

/**
 * OS CABEÇALHOS DA ASSINATURA (#2952).
 *
 * O login Sign in with ChatGPT guarda no `id_token` — e também no
 * `access_token` — a claim `https://api.openai.com/auth`, com o
 * `chatgpt_account_id` da conta (o workspace escolhido no login). O backend do
 * Codex exige esse id em TODO pedido autenticado: o próprio CLI o manda no
 * cabeçalho `ChatGPT-Account-Id`. Sem ele, `GET /v1/models` responde `http_401`
 * mesmo com um access token válido — era o que deixava `models_available`
 * vazio, desabilitava "Criar agente" e fazia todo "Publicar" cair em
 * `model_not_found` para quem ESTAVA conectado.
 *
 * A CONVERSA já funcionava e a listagem não: por isso o id sai daqui, da
 * credencial JÁ GRAVADA (nada de rede, nada de novo login).
 */
const CLAIM_DA_CONTA = "https://api.openai.com/auth";

/** O payload de um JWT (`a.b.c`), sem verificar assinatura — só leitura de claim. */
function lerPayload(jwt: string | undefined | null): Record<string, unknown> | null {
  if (typeof jwt !== "string") return null;
  const partes = jwt.split(".");
  const payload = partes[1];
  if (partes.length < 2 || !payload) return null;
  try {
    const texto = Buffer.from(payload, "base64url").toString("utf8");
    const objeto: unknown = JSON.parse(texto);
    return objeto && typeof objeto === "object" ? (objeto as Record<string, unknown>) : null;
  } catch {
    // Token ilegível não pode derrubar a listagem: sem claim, sem cabeçalho.
    return null;
  }
}

function accountIdDoToken(jwt: string | undefined | null): string | null {
  const payload = lerPayload(jwt);
  const auth = payload?.[CLAIM_DA_CONTA];
  if (!auth || typeof auth !== "object") return null;
  const id = (auth as Record<string, unknown>).chatgpt_account_id;
  return typeof id === "string" && id.trim() !== "" ? id.trim() : null;
}

/**
 * O id da conta a partir da credencial gravada: `id_token` primeiro — é onde o
 * login o escreve —, com o `access_token` como reserva, já que as duas são
 * JWTs da mesma sessão e carregam a mesma claim.
 */
export function lerAccountIdDaCredencial(
  tokens: Pick<TokensDoCodex, "access_token" | "id_token">,
): string | null {
  return accountIdDoToken(tokens.id_token) ?? accountIdDoToken(tokens.access_token);
}

/**
 * Os cabeçalhos da listagem. O `ChatGPT-Account-Id` só entra quando a claim
 * existe: sem ela o pedido continua como antes, mas nunca se inventa um id.
 */
export function cabecalhosDaAssinatura(
  tokens: Pick<TokensDoCodex, "access_token" | "id_token">,
): Record<string, string> {
  const accountId = lerAccountIdDaCredencial(tokens);
  return {
    Authorization: `Bearer ${tokens.access_token}`,
    ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
  };
}
