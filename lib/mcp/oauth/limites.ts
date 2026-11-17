/**
 * Limites de taxa das portas públicas do OAuth do MCP.
 *
 * Por IP, sobre o mesmo contador da superfície de login (`authRateLimited`,
 * com o IP de `ipDoCliente`). Os segredos (código, refresh, segredo do cliente)
 * têm 256 bits — o limite não existe para barrar adivinhação, que é inviável, e
 * sim para tirar o custo zero de quem enche o banco de clientes registrados ou
 * martela o token.
 *
 * Folgados de propósito no token: quem chama é o SERVIDOR do cliente (o
 * ChatGPT sai de poucos IPs da OpenAI), e todas as conexões de uma instalação
 * dividem esse balde.
 *
 * SEM IP, aqui, o limite cai num balde COMUM — ao contrário do login, onde
 * `authRateLimited` deixa de contar por IP. Lá o balde comum trancaria o login
 * da empresa inteira; aqui o que se protege é o BANCO (cada registro é uma
 * linha), e o pior efeito do balde comum é um aplicativo esperar alguns minutos
 * para conectar. "Sem limite" não é opção para uma porta que escreve.
 */
import { headers } from "next/headers";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { authRateLimited, type AuthRateLimits } from "@/lib/auth/rate-limit";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";

export const LIMITES_OAUTH_MCP = {
  registro: { ip: 20, windowSec: 3600 },
  autorizacao: { ip: 60, windowSec: 300 },
  token: { ip: 300, windowSec: 300 },
  revogacao: { ip: 60, windowSec: 300 },
  consentimento: { ip: 30, id: 20, windowSec: 300 },
} satisfies Record<string, AuthRateLimits>;

/**
 * Teto de clientes registrados que nunca concluíram uma troca de código. Nunca
 * recusa: cheio, o registro novo despeja o pendente mais ANTIGO, poupando só o
 * que tem código de autorização vivo (`fn_mcp_oauth_registrar_cliente`). O freio de taxa é `LIMITES_OAUTH_MCP.registro`.
 * A poda diária (`fn_mcp_oauth_podar`, cron `data-retention`) apaga os que
 * passaram de 24 h.
 */
export const TETO_DE_CLIENTES_PENDENTES = 100;

export type PortaOAuth = keyof typeof LIMITES_OAUTH_MCP;

export async function oauthMcpLimitado(porta: PortaOAuth, identificador: string | null = null): Promise<boolean> {
  const limites = LIMITES_OAUTH_MCP[porta];
  if (await authRateLimited(`mcp_oauth_${porta}`, identificador, limites)) return true;
  if (ipDoCliente(await headers()) !== null) return false;
  const comum = await checkRateLimit(`auth:mcp_oauth_${porta}:sem-ip`, limites.ip, limites.windowSec);
  return !comum.allowed;
}
