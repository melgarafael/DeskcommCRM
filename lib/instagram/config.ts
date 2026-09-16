import { env } from "@/lib/env";

/** Precisa bater, byte a byte, com o "Valid OAuth Redirect URI" cadastrado no Meta App. */
export const CAMINHO_DO_CALLBACK = "/api/v1/instagram/oauth/callback";

export function enderecoDeRetorno(urlDaAplicacao: string = env.NEXT_PUBLIC_APP_URL): string {
  const base = urlDaAplicacao.replace(/\/+$/, "");
  return `${base}${CAMINHO_DO_CALLBACK}`;
}

export const CAMINHO_DE_CONEXAO = "/api/v1/instagram/oauth/start";

/** O link que o agente manda ao lead pelo WhatsApp. */
export function enderecoDeConexao(
  organizationId: string,
  contactId: string,
  urlDaAplicacao: string = env.NEXT_PUBLIC_APP_URL,
): string {
  const base = urlDaAplicacao.replace(/\/+$/, "");
  const url = new URL(`${base}${CAMINHO_DE_CONEXAO}`);
  url.searchParams.set("org", organizationId);
  url.searchParams.set("contact", contactId);
  return url.toString();
}
