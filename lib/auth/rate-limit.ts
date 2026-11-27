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

import {
  aplicarPenalidade,
  checkRateLimit,
  limparRateLimit,
  peekRateLimit,
  segundosDePenalidade,
} from "@/lib/ai/dispatcher/rate-limit";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";

export interface AuthRateLimits {
  /** Tentativas por IP na janela. */
  ip: number;
  /** Tentativas por identificador na janela (omita para não contar por ele). */
  id?: number;
  windowSec: number;
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
  const ip = ipDoCliente(await headers());

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
  mfa: { ip: 30, id: 3, windowSec: 60 },
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
export async function registrarFalhaDeLogin(
  email: string,
  limits: AuthRateLimits,
): Promise<DegrauDoBloqueio | null> {
  if (limits.id !== undefined) {
    await checkRateLimit(`auth:login_fail:id:${opaque(email)}`, limits.id, limits.windowSec);
  }
  // A janela do dia é alimentada pela MESMA falha — é o que impede o ataque de
  // "5 erros a cada 5 minutos, para sempre": a curta esquece, a do dia não.
  return registrarFalhaNaRegua(email);
}

/**
 * ─── BLOQUEIO PROGRESSIVO POR CONTA (issue #4743, item 1) ──────────────────
 *
 * O limite acima é de JANELA CURTA (5 falhas / 5 min) e zera a cada 5 minutos:
 * 5 erros a cada 5 minutos dão até 1.440 tentativas por dia na MESMA conta,
 * todo dia, sem ninguém saber. Ele continua valendo exatamente como está — o
 * que entra aqui é uma SEGUNDA janela, a do DIA, que não zera a cada 5 minutos
 * e cujo castigo CRESCE com o número de falhas.
 *
 * "Dia" aqui é o dia do calendário UTC, não 24 horas desde a primeira falha: a
 * chave do contador nasce alinhada (`floor(agora / 86400 s)`), então ela vira à
 * meia-noite UTC. O castigo em curso NÃO vira junto — ele tem TTL próprio.
 *
 * ─── O mecanismo é o do `MFA_DIARIO`, não um segundo ───────────────────────
 *
 * O segundo fator já fazia isso (`auth:mfa_fail_daily:id:<hash>`, 86400 s):
 * um balde diário ao lado do balde curto, `peekRateLimit` antes e
 * `checkRateLimit` depois da falha. A senha passa a ter o mesmo par de baldes.
 * A única peça nova é o PRAZO do castigo: um contador de janela fixa não sabe
 * dizer "30 minutos a partir de agora" (a chave nasce alinhada ao início da
 * janela), então o degrau grava uma penalidade com TTL próprio —
 * `aplicarPenalidade`, no mesmo módulo de contador, mesmo armazenamento.
 *
 * ─── A RÉGUA, com os números ───────────────────────────────────────────────
 *
 *   falhas no dia │ castigo │ efeito
 *   ──────────────┼─────────┼───────────────────────────────────────────────
 *    5            │  5 min  │ igual à janela curta; o balde do dia só passa
 *                 │         │ a LEMBRAR (é o degrau 1)
 *   10            │ 30 min  │ e cada falha nova a partir daí renova os 30 min
 *
 * A conta, do jeito mais rápido possível para quem ataca: 10 falhas na
 * primeira meia hora e depois uma a cada 30 minutos — no máximo 57 por dia
 * UTC contra a mesma conta (medido em `signInWithPassword.test.ts`), em vez de
 * ~1.440.
 *
 * ─── Por que NÃO há degrau "até redefinir a senha" (decisão do dono) ───────
 *
 * A issue sugere um terceiro degrau (20 falhas → trancada até redefinir). Ele
 * ficou de fora de propósito: quem souber o e-mail do dono poderia trancá-lo
 * fora do próprio CRM sem saber a senha, e a saída seria o "esqueci a senha"
 * por e-mail — que numa instalação sem e-mail configurado não chega. O degrau
 * longo entra junto com o destravamento pelo administrador em Equipe (item 1
 * da issue) e o aviso ao dono da conta (item 2).
 *
 * ─── Enumeração ────────────────────────────────────────────────────────────
 *
 * O balde é derivado do E-MAIL APRESENTADO, exista conta ou não — a mesma
 * decisão que o balde curto já toma. Consequência: quem digita um e-mail que
 * não existe recebe exatamente a mesma sequência de respostas de quem digita o
 * e-mail de uma vítima real, inclusive o `rate_limited` a partir da 6ª. Se o
 * castigo só valesse para contas existentes, o PRÓPRIO bloqueio viraria o
 * oráculo de enumeração que a issue pede para não criar.
 */
export interface DegrauDoBloqueio {
  /** Falhas dentro da janela do dia que disparam este degrau. */
  falhas: number;
  /** Duração do castigo. */
  segundos: number;
  /** Evento de auditoria próprio do degrau. */
  acao: AcaoDeBloqueio;
}

export type AcaoDeBloqueio = "auth.login_bloqueio_5min" | "auth.login_bloqueio_30min";

/** Janela do dia (vira à meia-noite UTC) — o mesmo 86400 do `MFA_DIARIO`. */
export const JANELA_DIARIA_DA_CONTA_SEC = 86_400;

export const DEGRAUS_DO_BLOQUEIO: readonly DegrauDoBloqueio[] = [
  { falhas: 5, segundos: 300, acao: "auth.login_bloqueio_5min" },
  { falhas: 10, segundos: 1800, acao: "auth.login_bloqueio_30min" },
];

/** Falhas no dia do degrau mais alto — o `limit` do contador do dia. */
const FALHAS_DO_ULTIMO_DEGRAU = DEGRAUS_DO_BLOQUEIO[DEGRAUS_DO_BLOQUEIO.length - 1]?.falhas ?? 0;

export interface BloqueioProgressivo {
  bloqueado: boolean;
  /** 0 = livre; 1..2 = degrau da régua. */
  degrau: number;
  /** Evento de auditoria do degrau ativo (o da última falha registrada). */
  acao: AcaoDeBloqueio | null;
  restanteSec: number;
}

function chaveDiariaDaConta(email: string): string {
  return `auth:falha_conta_dia:id:${opaque(email)}`;
}

function chaveDoDegrau(email: string, indice: number): string {
  return `auth:falha_conta_bloqueio:id:${opaque(email)}:d${indice + 1}`;
}

/** Falhas da conta no dia UTC corrente (sem incrementar). */
export async function falhasNaJanelaDiaria(email: string): Promise<number> {
  return peekRateLimit(chaveDiariaDaConta(email), JANELA_DIARIA_DA_CONTA_SEC);
}

/** `0` = abaixo do primeiro degrau; `n` = degrau `n` (1..2). */
export function degrauDeFalhas(falhas: number): number {
  let degrau = 0;
  DEGRAUS_DO_BLOQUEIO.forEach((d, i) => {
    if (falhas >= d.falhas) degrau = i + 1;
  });
  return degrau;
}

/**
 * A conta está sob castigo? Consulta do degrau mais alto para o mais baixo —
 * quem chegou ao 2 não pode "cair" para o 1 só porque o castigo do 1 venceu.
 */
export async function bloqueioProgressivoDeConta(email: string): Promise<BloqueioProgressivo> {
  const restantes = await Promise.all(
    DEGRAUS_DO_BLOQUEIO.map((_, i) => segundosDePenalidade(chaveDoDegrau(email, i))),
  );
  for (let i = DEGRAUS_DO_BLOQUEIO.length - 1; i >= 0; i--) {
    const degrau = DEGRAUS_DO_BLOQUEIO[i];
    const restanteSec = restantes[i] ?? 0;
    if (degrau && restanteSec > 0) {
      return { bloqueado: true, degrau: i + 1, acao: degrau.acao, restanteSec };
    }
  }
  return { bloqueado: false, degrau: 0, acao: null, restanteSec: 0 };
}

/**
 * Conta a falha na janela do dia e aplica o castigo do degrau alcançado.
 *
 * ZERO sleep: o prazo é o TTL da penalidade, não um temporizador — é o que
 * torna a janela do dia testável com relógio controlado.
 *
 * @returns o degrau que ACABOU de ser disparado (para o evento de auditoria),
 *   ou `null` quando a falha não mudou o estado do bloqueio.
 */
export async function registrarFalhaNaRegua(email: string): Promise<DegrauDoBloqueio | null> {
  const antes = await bloqueioProgressivoDeConta(email);

  await checkRateLimit(
    chaveDiariaDaConta(email),
    FALHAS_DO_ULTIMO_DEGRAU,
    JANELA_DIARIA_DA_CONTA_SEC,
  );
  const falhas = await falhasNaJanelaDiaria(email);
  const indice = degrauDeFalhas(falhas);
  const degrau = DEGRAUS_DO_BLOQUEIO[indice - 1];
  if (!degrau) return null;

  await aplicarPenalidade(chaveDoDegrau(email, indice - 1), degrau.segundos);

  // Já estava castigado neste degrau (o castigo foi renovado, não nasceu
  // agora): não é um evento novo. Castigo vencido e reincidente É evento novo.
  return indice > antes.degrau ? degrau : null;
}

/**
 * O desbloqueio antecipado: o caminho de redefinir a senha por e-mail.
 *
 * Medido no código: `/login` → "esqueci a senha" → `requestPasswordReset`
 * (manda o link) → `/auth/confirm` (abre a sessão de recuperação) →
 * `updatePassword` (grava a senha nova). É esse último passo que chama isto.
 * Zera o balde do dia e os castigos, então a conta volta a aceitar a senha
 * nova imediatamente — sem esperar os 30 minutos vencerem.
 */
export async function liberarBloqueioProgressivo(email: string): Promise<void> {
  for (let i = 0; i < DEGRAUS_DO_BLOQUEIO.length; i++) {
    await limparRateLimit(chaveDoDegrau(email, i));
  }
  await limparRateLimit(chaveDiariaDaConta(email), [JANELA_DIARIA_DA_CONTA_SEC]);
}

/**
 * Bloqueio por falha de TOKEN DE API (`dsk_...`) — o MCP não tinha nenhum
 * (issue #1447).
 *
 * O login já contava falhas; o token de máquina, não. `validateBearerToken`
 * recusava e seguia, e cada recusa custava um lookup em `api_tokens` — então a
 * mesma origem podia varrer tokens para sempre a custo zero. Dois baldes,
 * porque são dois ataques diferentes:
 *
 *   - por ORIGEM (`api_token_fail:ip`): quem ADIVINHA — cabeçalho ausente ou
 *     torto, `dsk_` malformado, hash desconhecido. É o freio de quem varre de
 *     um lugar só.
 *   - pelo VALOR APRESENTADO (`api_token_fail:token`, hash SHA256 do que veio
 *     no header): quem REPETE o mesmo chute, ou o mesmo token já morto
 *     (revogado, expirado), trocando de IP a cada tentativa — o espelho do
 *     caso acima, que o balde por IP vê como "1 falha por IP" e não barra.
 *
 * `revoked`/`expired` NÃO debitam o balde por origem: quem apresenta um token
 * que existiu não está adivinhando, e transformar cliente desatualizado em
 * bloqueio por IP puniria NAT corporativo — exatamente o que `authRateLimited`
 * evita. Eles debitam só o balde do valor apresentado, que não afeta mais
 * ninguém.
 *
 * `lookup_failed` não conta em balde nenhum: a falha é nossa (banco fora), e
 * indisponibilidade de infraestrutura não pode virar bloqueio de cliente.
 *
 * Sem Redis de pé a contagem cai para a memória do processo — vira teto por
 * instância, o mesmo aviso que o resto deste módulo já carrega. As funções
 * aqui falham ABERTO: erro ao consultar o teto não pode virar 500 no meio da
 * autenticação — o que ele protege é custo, não acesso.
 */
export interface TokenFailureLimits {
  /** Teto por origem, por janela. */
  ip: number;
  /** Teto por valor apresentado, por janela. */
  token: number;
  windowSec: number;
}

export const TOKEN_FAILURE_LIMITS: TokenFailureLimits = { ip: 30, token: 5, windowSec: 300 };

export interface FalhaDeTokenOpcoes {
  /** `true` (default) = também debita o balde por origem: quem ADIVINHOU. */
  contaNoIp?: boolean;
}

function tokenFailureIpKey(ip: string): string {
  return `api_token_fail:ip:${opaque(ip)}`;
}

function tokenFailureValueKey(plaintext: string): string {
  return `api_token_fail:token:${opaque(plaintext)}`;
}

/**
 * `true` = teto estourado, barre ANTES de resolver o token.
 *
 * Consulta sem incrementar: quem incrementa é `registrarFalhaDeToken`, e só
 * quando a tentativa realmente falhou. Acerto não paga imposto.
 */
export async function tokenFailureLimited(
  plaintext: string | null,
  limits: TokenFailureLimits = TOKEN_FAILURE_LIMITS,
): Promise<boolean> {
  try {
    const ip = ipDoCliente(await headers());
    if (ip !== null && (await peekRateLimit(tokenFailureIpKey(ip), limits.windowSec)) >= limits.ip) {
      return true;
    }
    if (
      plaintext !== null &&
      (await peekRateLimit(tokenFailureValueKey(plaintext), limits.windowSec)) >= limits.token
    ) {
      return true;
    }
    return false;
  } catch (err) {
    console.error(
      "[auth.rate-limit] teto de token indisponível (falha aberta)",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Registra a tentativa que FALHOU.
 *
 * @param plaintext valor apresentado; `null` quando não veio token nenhum
 *   (cabeçalho ausente/malformado) — aí só o balde por origem existe.
 */
export async function registrarFalhaDeToken(
  plaintext: string | null,
  opcoes: FalhaDeTokenOpcoes = {},
  limits: TokenFailureLimits = TOKEN_FAILURE_LIMITS,
): Promise<void> {
  const contaNoIp = opcoes.contaNoIp ?? true;
  try {
    if (contaNoIp) {
      const ip = ipDoCliente(await headers());
      if (ip !== null) {
        await checkRateLimit(tokenFailureIpKey(ip), limits.ip, limits.windowSec);
      }
    }
    if (plaintext !== null) {
      await checkRateLimit(tokenFailureValueKey(plaintext), limits.token, limits.windowSec);
    }
  } catch (err) {
    console.error(
      "[auth.rate-limit] falha ao registrar tentativa de token (falha aberta)",
      err instanceof Error ? err.message : err,
    );
  }
}

/** Janela longa do segundo fator: só por usuário (o teto por IP é o da janela curta). */
const MFA_DIARIO = { id: 15, windowSec: 86400 } as const;

/**
 * Bloqueio por FALHA no segundo fator (MFA/TOTP), contado no servidor e não
 * no navegador — a mesma dupla proteção do `login`:
 *  - janela curta (`AUTH_LIMITS.mfa`, 3 falhas / 60s por usuário e 30 por IP);
 *  - janela diária (`MFA_DIARIO`, 15 falhas / 24h por usuário).
 *
 * Toda tela que confere o código do segundo fator consulta e alimenta este
 * mesmo balde: `verifyMfa` e `updatePassword`.
 */
export async function mfaBloqueadoPorFalhas(
  userId: string,
  limits: AuthRateLimits = AUTH_LIMITS.mfa,
  diario: { id: number; windowSec: number } = MFA_DIARIO,
): Promise<boolean> {
  const ip = ipDoCliente(await headers());
  if (ip !== null) {
    const atualIp = await peekRateLimit(`auth:mfa_fail:ip:${opaque(ip)}`, limits.windowSec);
    if (atualIp >= limits.ip) return true;
  }
  if (limits.id !== undefined) {
    const atualId = await peekRateLimit(`auth:mfa_fail:id:${opaque(userId)}`, limits.windowSec);
    if (atualId >= limits.id) return true;
  }
  const atualDia = await peekRateLimit(`auth:mfa_fail_daily:id:${opaque(userId)}`, diario.windowSec);
  return atualDia >= diario.id;
}

/** Registra uma tentativa de MFA/TOTP que falhou no contador do servidor. */
export async function registrarFalhaDeMfa(
  userId: string,
  limits: AuthRateLimits = AUTH_LIMITS.mfa,
  diario: { id: number; windowSec: number } = MFA_DIARIO,
): Promise<void> {
  const ip = ipDoCliente(await headers());
  if (ip !== null) {
    await checkRateLimit(`auth:mfa_fail:ip:${opaque(ip)}`, limits.ip, limits.windowSec);
  }
  if (limits.id !== undefined) {
    await checkRateLimit(`auth:mfa_fail:id:${opaque(userId)}`, limits.id, limits.windowSec);
  }
  await checkRateLimit(`auth:mfa_fail_daily:id:${opaque(userId)}`, diario.id, diario.windowSec);
}
