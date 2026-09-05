/**
 * Rate limit da superfície de autenticação (issue #64).
 *
 * O `checkRateLimit` já existia e era usado em dois pontos (webhook de captação
 * e dispatcher de IA); login, signup, recuperação de senha e aceite de convite
 * ficaram sem nenhum limite — força bruta de senha e enumeração de token saíam
 * de graça. Aqui só se aplica o que já existe.
 *
 * Duas contagens por tentativa, quando há identificador:
 *  - por IP: barra o atacante que varre muitas contas de um lugar só;
 *  - por identificador (hash do e-mail, token): barra o ataque distribuído
 *    contra UMA conta, que a contagem por IP não vê.
 *
 * O identificador entra SEMPRE hasheado — chave de Redis é lugar de dado
 * opaco, não de e-mail de cliente.
 *
 * Janela FIXA (é o que `checkRateLimit` implementa: `INCR` + `EXPIRE`), então
 * uma rajada na virada da janela passa em dobro. É limite de abuso, não de
 * precisão — e sem Upstash configurado o contador cai para memória do processo,
 * o que degrada em instalação de nó único mas não deixa a porta escancarada.
 */
import { createHash } from "node:crypto";
import { headers } from "next/headers";

import { checkRateLimit, peekRateLimit } from "@/lib/ai/dispatcher/rate-limit";

export interface AuthRateLimits {
  /** Tentativas por IP na janela. */
  ip: number;
  /** Tentativas por identificador na janela (omita para não contar por ele). */
  id?: number;
  windowSec: number;
}

/**
 * IP do cliente, ou `null` quando não dá para saber.
 *
 * `x-forwarded-for` é o header do proxy; `x-real-ip` é o que Nginx costuma setar
 * sozinho em configurações simples. Nenhum dos dois é confiável contra spoofing —
 * mas o uso aqui é rate limit, onde forjar o header só isola o atacante em outro
 * balde, nunca dá acesso.
 *
 * `null` em vez de uma string sentinela: "não sei de onde veio" precisa ser
 * inexprimível como se fosse uma origem, senão vira balde compartilhado.
 */
async function clientIp(): Promise<string | null> {
  const hdrs = await headers();
  const encaminhado = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (encaminhado) return encaminhado;
  const real = hdrs.get("x-real-ip")?.trim();
  return real || null;
}

function opaque(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex").slice(0, 32);
}

/**
 * `true` = barre a tentativa.
 *
 * @param action rótulo do bucket (`login`, `signup`, `reset`, `invite_accept`)
 * @param identifier e-mail ou token da tentativa; hasheado antes de virar chave
 */
export async function authRateLimited(
  action: string,
  identifier: string | null,
  limits: AuthRateLimits,
): Promise<boolean> {
  const ip = await clientIp();

  // SEM IP identificável, o limite por IP não entra — e isto é decisão de
  // segurança, não relaxamento.
  //
  // O teto por IP existe para ISOLAR uma origem: barrar quem varre muitas contas
  // de um lugar só. Quando o header não chega, não há origem para isolar, e a
  // versão anterior jogava todo mundo num ÚNICO balde global (`opaque("sem-ip")`).
  // O efeito é o oposto do pretendido: o atacante não fica isolado (ele divide o
  // balde com as vítimas) e 60 requisições anônimas trancam o login da instalação
  // INTEIRA. Vira um DoS de custo zero contra a própria empresa.
  //
  // E o caso não é hipotético: o kit self-host expõe o app direto, sem proxy
  // (`docker-compose.prod.yml`), então `x-forwarded-for` não existe em nenhuma
  // instalação padrão — ou seja, o balde global era o caminho NORMAL, não a exceção.
  //
  // O que barra força bruta de senha continua valendo integralmente: o contador por
  // CONTA (`contaBloqueadaPorFalhas`), que não depende de IP nenhum e é justamente o
  // desenhado para o ataque distribuído.
  if (ip !== null) {
    const byIp = await checkRateLimit(`auth:${action}:ip:${opaque(ip)}`, limits.ip, limits.windowSec);
    if (!byIp.allowed) return true;
  }

  if (identifier && limits.id !== undefined) {
    const byId = await checkRateLimit(
      `auth:${action}:id:${opaque(identifier)}`,
      limits.id,
      limits.windowSec,
    );
    if (!byId.allowed) return true;
  }

  return false;
}

/**
 * Limites por superfície. Números escolhidos para não estorvar uso humano
 * normal e ainda assim tirar o custo-zero do ataque:
 *  - login: quem erra a senha 5 vezes na mesma conta em 5 min quase sempre é
 *    script; o teto por IP é mais folgado por causa de NAT corporativo.
 *  - signup e convite: fluxos raros por pessoa, teto baixo.
 */
/** Teto de produção por IP no login. Congelado por teste — ver `LOGIN_IP_DEFAULT` abaixo. */
const LOGIN_IP_DEFAULT = 60;

/**
 * O teto por IP do login é o ÚNICO limite configurável, e existe por um defeito
 * de ambiente, não de produto: no CI todo teste sai do mesmo IP por construção
 * (um runner), então 28 specs × vários logins estouram 60/5min e o e2e reprova
 * com "Muitas tentativas" — foi o que derrubou `risk-radar` (13ª de 15 na parte 1).
 *
 * Por que afrouxar ISTO é seguro, e afrouxar o resto não seria: o limite que
 * barra brute force é `id` (5 falhas na MESMA conta em 5 min), e ele NÃO é
 * configurável — continua valendo inclusive para quem distribui as tentativas
 * por muitos IPs. O teto por IP é anti-flood genérico, já folgado de propósito
 * por causa de NAT corporativo; no CI o "NAT" é o runner inteiro.
 *
 * Valor inválido ou ausente cai no default de produção: a falha é fechada.
 */
function loginIpLimit(): number {
  const bruto = process.env.AUTH_RATE_LIMIT_LOGIN_IP;
  if (bruto === undefined) return LOGIN_IP_DEFAULT;
  const n = Number.parseInt(bruto, 10);
  return Number.isFinite(n) && n > 0 ? n : LOGIN_IP_DEFAULT;
}

export const AUTH_LIMITS = {
  login: { ip: loginIpLimit(), id: 5, windowSec: 300 },
  signup: { ip: 20, windowSec: 3600 },
  reset: { ip: 30, id: 3, windowSec: 3600 },
  invite_accept: { ip: 60, windowSec: 3600 },
  // Recuperação do primeiro acesso: o teto mais apertado da lista, e de
  // propósito. Cada acerto CRIA uma organização, e o caminho legítimo é
  // usado UMA vez na vida de uma conta — 3 por hora por identidade já é
  // folga para quem errou o nome duas vezes.
  org_recovery: { ip: 5, id: 3, windowSec: 3600 },
} satisfies Record<string, AuthRateLimits>;

export const __LOGIN_IP_DEFAULT_PARA_TESTE = LOGIN_IP_DEFAULT;

/**
 * Bloqueio por FALHA, para o login.
 *
 * `authRateLimited` conta toda tentativa — certo para IP, errado para conta:
 * quem digita a senha certa não pode gastar o próprio orçamento de bloqueio.
 * Aqui a consulta vem antes do provedor (só assim o ataque é barrado *antes*
 * de acontecer) e o incremento vem depois, apenas quando a senha errou.
 *
 * Efeito: N senhas erradas trancam a conta pela janela, inclusive contra quem
 * distribui as tentativas por muitos IPs. Acertar na 3ª não custa nada.
 */
export async function contaBloqueadaPorFalhas(email: string, limits: AuthRateLimits): Promise<boolean> {
  if (limits.id === undefined) return false;
  const atual = await peekRateLimit(`auth:login_fail:id:${opaque(email)}`, limits.windowSec);
  return atual >= limits.id;
}

/** Registra uma senha errada no contador da conta. */
export async function registrarFalhaDeLogin(email: string, limits: AuthRateLimits): Promise<void> {
  if (limits.id === undefined) return;
  await checkRateLimit(`auth:login_fail:id:${opaque(email)}`, limits.id, limits.windowSec);
}
