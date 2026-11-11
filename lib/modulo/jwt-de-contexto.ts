/**
 * JWT DE CONTEXTO DO MÓDULO (Spec 33, F3, tarefa 4).
 *
 * A tela do módulo (iframe) pede ao host um JWT curto que diz "esta PESSOA, nesta ORGANIZAÇÃO, para
 * esta INSTALAÇÃO". O módulo o devolve no cabeçalho `X-Module-Context` junto do seu token de módulo, e
 * `resolveAuthDual` o confere. Assinatura ASSIMÉTRICA (ES256): o host assina com a chave privada
 * (`MODULE_JWT_PRIVATE_KEY`, PEM PKCS#8) e quem tiver a pública só verifica; o módulo nunca recebe nem
 * precisa de segredo para ler o JWT.
 *
 * O JWT NÃO É AUTORIDADE DE PAPEL. Ele só identifica a pessoa. O papel dela é lido do banco a cada
 * chamada (`lib/modulo/papel-efetivo.ts`), então pessoa removida ou rebaixada perde o poder na
 * requisição seguinte, mesmo com o JWT ainda dentro da validade.
 *
 * Conteúdo (payload): `sub` (pessoa), `org`, `inst`, `iss`, `aud`, `iat`, `exp`, `jti`. Nada de papel,
 * e-mail, nome, segredo ou token. Validade de 5 minutos no máximo.
 *
 * Sem `MODULE_JWT_PRIVATE_KEY` (ou chave que não carrega) o recurso está DESLIGADO: emitir devolve
 * `null`, verificar recusa. Instalação fresca continua funcionando sem a variável.
 */
import { createPrivateKey, createPublicKey, randomUUID, type KeyObject } from "node:crypto";

import { jwtVerify, SignJWT } from "jose";

export const JWT_ISSUER = "crm-host";
export const JWT_AUDIENCE = "crm-module";
export const JWT_VALIDADE_SEGUNDOS = 300;
export const CABECALHO_DE_CONTEXTO = "x-module-context";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OpcoesDoJwt {
  /** PEM da chave privada. Só para teste; o padrão é `env.MODULE_JWT_PRIVATE_KEY`. */
  chavePem?: string;
  /** Só para teste. */
  agora?: Date;
}

async function pemConfigurado(opcoes: OpcoesDoJwt): Promise<string> {
  if (opcoes.chavePem !== undefined) return opcoes.chavePem;
  const { env } = await import("@/lib/env");
  return env.MODULE_JWT_PRIVATE_KEY;
}

/** PEM de variável de ambiente costuma vir com `\n` literal; normaliza. Chave ruim = `null`. */
function carregarChave(pem: string): KeyObject | null {
  const texto = pem.trim().replace(/\\n/g, "\n");
  if (!texto) return null;
  try {
    const chave = createPrivateKey(texto);
    if (chave.asymmetricKeyType !== "ec") return null;
    if (chave.asymmetricKeyDetails?.namedCurve !== "prime256v1") return null;
    return chave;
  } catch {
    return null;
  }
}

export async function jwtDeContextoDisponivel(opcoes: OpcoesDoJwt = {}): Promise<boolean> {
  return carregarChave(await pemConfigurado(opcoes)) !== null;
}

export interface EmitirJwtParams extends OpcoesDoJwt {
  pessoaId: string;
  organizationId: string;
  installationId: string;
}

/** `null` quando a chave não está configurada: quem chama responde 503. */
export async function emitirJwtDeContexto(
  p: EmitirJwtParams,
): Promise<{ jwt: string; expires_at: string } | null> {
  const chave = carregarChave(await pemConfigurado(p));
  if (!chave) return null;
  const agora = Math.floor((p.agora ?? new Date()).getTime() / 1000);
  const exp = agora + JWT_VALIDADE_SEGUNDOS;
  const jwt = await new SignJWT({ org: p.organizationId, inst: p.installationId })
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setSubject(p.pessoaId)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt(agora)
    .setExpirationTime(exp)
    .setJti(randomUUID())
    .sign(chave);
  return { jwt, expires_at: new Date(exp * 1000).toISOString() };
}

export interface EsperadoNoJwt extends OpcoesDoJwt {
  /** Da LINHA DO TOKEN do módulo, nunca do cabeçalho. */
  organizationId: string;
  installationId: string;
}

export type ResultadoDoJwt = { ok: true; pessoaId: string } | { ok: false };

/**
 * Assinatura (só ES256), emissor, audiência, `exp`, idade máxima, e `org`/`inst` iguais aos do token.
 * Qualquer falha (inclusive chave ausente) é `{ ok: false }`, sem dizer por quê.
 */
export async function verificarJwtDeContexto(
  jwt: string,
  esperado: EsperadoNoJwt,
): Promise<ResultadoDoJwt> {
  try {
    const privada = carregarChave(await pemConfigurado(esperado));
    if (!privada) return { ok: false };
    const publica = createPublicKey(privada);
    const { payload } = await jwtVerify(jwt, publica, {
      algorithms: ["ES256"],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      requiredClaims: ["sub", "org", "inst", "exp", "iat"],
      maxTokenAge: JWT_VALIDADE_SEGUNDOS,
      clockTolerance: 5,
      ...(esperado.agora ? { currentDate: esperado.agora } : {}),
    });
    const sub = payload.sub;
    if (typeof sub !== "string" || !UUID.test(sub)) return { ok: false };
    if (payload.org !== esperado.organizationId) return { ok: false };
    if (payload.inst !== esperado.installationId) return { ok: false };
    return { ok: true, pessoaId: sub.toLowerCase() };
  } catch {
    return { ok: false };
  }
}
