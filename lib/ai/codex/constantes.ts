/**
 * Constantes do provider `openai-codex` (assinatura ChatGPT via OAuth).
 *
 * FORMA OBSERVADA (reconstruída do Codex CLI e de terceiros como OpenCode e
 * `ai-sdk-codex-oauth` — NÃO documentada pela OpenAI): o device-flow usa DOIS
 * endpoints próprios (`deviceauth/usercode` + `deviceauth/token`), e só a
 * troca final e o refresh batem no token endpoint padrão. Adivinhar esses
 * caminhos (foi o que a primeira versão deste arquivo fez) rende 404 que
 * parece revogação.
 *
 * Único lugar com literais Codex; o resto importa daqui.
 */
export const CODEX_INFERENCE_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CODEX_RESPONSES_PATH = "/responses";
export const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
/** Device-flow: abre a sessão (JSON `{client_id}` → `{user_code, device_auth_id, interval}`). */
export const CODEX_DEVICE_AUTH_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
/** Device-flow: poll (JSON `{device_auth_id, user_code}` → 403/404 pendente, 200 `{authorization_code, code_verifier}`). */
export const CODEX_DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
/** Redirect URI da troca do device-flow (fixo do protocolo, não configurável). */
export const CODEX_DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
/** URL onde o OPERADOR digita o código (humano, não API). */
export const CODEX_DEVICE_VERIFY_URL = "https://auth.openai.com/codex/device";

export function codexClientId(): string {
  const id = process.env.OPENAI_CODEX_CLIENT_ID?.trim();
  if (!id) throw new Error("OPENAI_CODEX_CLIENT_ID ausente — defina o client OAuth (D1).");
  return id;
}
