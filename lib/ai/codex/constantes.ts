/**
 * Constantes do provider `openai-codex` (assinatura ChatGPT via OAuth).
 *
 * Espelham o Hermes (`DEFAULT_CODEX_BASE_URL =
 * "https://chatgpt.com/backend-api/codex"`): o Codex NÃO fala com
 * `api.openai.com` — é outro endpoint, outra autenticação (Bearer OAuth de
 * curta duração, nunca `sk-...`). Quem confundir os dois manda o access token
 * para o endpoint errado.
 *
 * Único lugar com literais Codex; o registry (`edge/llm/providers.ts`) e o
 * validador (`lib/ai/provider-validators.ts`) importam daqui.
 */
export const CODEX_INFERENCE_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_OAUTH_DEVICE_URL = "https://auth.openai.com/codex/device";

export function codexClientId(): string {
  const id = process.env.OPENAI_CODEX_CLIENT_ID?.trim();
  if (!id) throw new Error("OPENAI_CODEX_CLIENT_ID ausente — defina o client OAuth (D1).");
  return id;
}
