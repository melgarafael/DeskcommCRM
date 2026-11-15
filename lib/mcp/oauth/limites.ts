/**
 * Limites de taxa das portas públicas do OAuth do MCP.
 *
 * Por IP, sobre o mesmo contador da superfície de login (`authRateLimited`).
 * Os segredos (código, refresh, segredo do cliente) têm 256 bits — o limite não
 * existe para barrar adivinhação, que é inviável, e sim para tirar o custo zero
 * de quem enche o banco de clientes registrados ou martela o token.
 *
 * Folgados de propósito no token: quem chama é o SERVIDOR do cliente (o
 * ChatGPT sai de poucos IPs da OpenAI), e todas as conexões de uma instalação
 * dividem esse balde.
 */
import { authRateLimited, type AuthRateLimits } from "@/lib/auth/rate-limit";

export const LIMITES_OAUTH_MCP = {
  registro: { ip: 20, windowSec: 3600 },
  autorizacao: { ip: 60, windowSec: 300 },
  token: { ip: 300, windowSec: 300 },
  revogacao: { ip: 60, windowSec: 300 },
  consentimento: { ip: 30, id: 20, windowSec: 300 },
} satisfies Record<string, AuthRateLimits>;

export type PortaOAuth = keyof typeof LIMITES_OAUTH_MCP;

export function oauthMcpLimitado(porta: PortaOAuth, identificador: string | null = null): Promise<boolean> {
  return authRateLimited(`mcp_oauth_${porta}`, identificador, LIMITES_OAUTH_MCP[porta]);
}
