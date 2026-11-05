/**
 * JWT de contexto do módulo (Spec 33, F3, tarefa 4): assinatura verificável, expiração curta, sem
 * segredo no payload, e recusa de tudo que não é exatamente o que o host emitiu.
 */
import { createSecretKey, generateKeyPairSync, randomUUID } from "node:crypto";

import { decodeJwt, decodeProtectedHeader, SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import {
  emitirJwtDeContexto,
  JWT_AUDIENCE,
  JWT_ISSUER,
  JWT_VALIDADE_SEGUNDOS,
  jwtDeContextoDisponivel,
  verificarJwtDeContexto,
} from "./jwt-de-contexto";

function novaChavePem(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

const PEM = novaChavePem();
const PESSOA = randomUUID();
const ORG = randomUUID();
const INST = randomUUID();
const AGORA = new Date("2026-11-05T12:00:00.000Z");

async function emitir(extra: { chavePem?: string; agora?: Date } = {}) {
  const r = await emitirJwtDeContexto({
    pessoaId: PESSOA,
    organizationId: ORG,
    installationId: INST,
    chavePem: extra.chavePem ?? PEM,
    agora: extra.agora ?? AGORA,
  });
  if (!r) throw new Error("não emitiu");
  return r;
}

const esperado = { organizationId: ORG, installationId: INST, chavePem: PEM, agora: AGORA };

describe("emitirJwtDeContexto", () => {
  it("emite ES256, com sub/org/inst e validade de no máximo 5 minutos", async () => {
    const { jwt, expires_at } = await emitir();
    expect(decodeProtectedHeader(jwt)).toMatchObject({ alg: "ES256" });
    const p = decodeJwt(jwt);
    expect(p).toMatchObject({ sub: PESSOA, org: ORG, inst: INST, iss: JWT_ISSUER, aud: JWT_AUDIENCE });
    expect(p.exp! - p.iat!).toBe(JWT_VALIDADE_SEGUNDOS);
    expect(JWT_VALIDADE_SEGUNDOS).toBeLessThanOrEqual(300);
    expect(expires_at).toBe(new Date(p.exp! * 1000).toISOString());
  });

  it("o payload não carrega segredo, chave, papel, e-mail nem token", async () => {
    const { jwt } = await emitir();
    const p = decodeJwt(jwt);
    expect(Object.keys(p).sort()).toEqual(["aud", "exp", "iat", "inst", "iss", "jti", "org", "sub"]);
    const texto = JSON.stringify(p);
    expect(texto).not.toContain("PRIVATE");
    expect(texto).not.toContain(PEM.split("\n")[1]!);
    expect(texto).not.toMatch(/dsk_|role|email|secret/i);
  });

  it("sem chave (ou chave que não é P-256) não emite: recurso desligado", async () => {
    for (const chavePem of ["", "   ", "lixo", generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString()]) {
      expect(
        await emitirJwtDeContexto({ pessoaId: PESSOA, organizationId: ORG, installationId: INST, chavePem }),
      ).toBeNull();
      expect(await jwtDeContextoDisponivel({ chavePem })).toBe(false);
    }
    expect(await jwtDeContextoDisponivel({ chavePem: PEM })).toBe(true);
  });

  it("aceita a chave com \\n literal (formato de variável de ambiente)", async () => {
    const emLinha = PEM.trim().replace(/\n/g, "\\n");
    const { jwt } = await emitir({ chavePem: emLinha });
    expect(await verificarJwtDeContexto(jwt, { ...esperado, chavePem: emLinha })).toEqual({
      ok: true,
      pessoaId: PESSOA,
    });
  });
});

describe("verificarJwtDeContexto", () => {
  it("assinatura verificável: devolve a pessoa", async () => {
    const { jwt } = await emitir();
    expect(await verificarJwtDeContexto(jwt, esperado)).toEqual({ ok: true, pessoaId: PESSOA });
  });

  it("vencido recusa; dentro da validade passa", async () => {
    const { jwt } = await emitir();
    const quase = new Date(AGORA.getTime() + (JWT_VALIDADE_SEGUNDOS - 10) * 1000);
    const depois = new Date(AGORA.getTime() + (JWT_VALIDADE_SEGUNDOS + 60) * 1000);
    expect((await verificarJwtDeContexto(jwt, { ...esperado, agora: quase })).ok).toBe(true);
    expect((await verificarJwtDeContexto(jwt, { ...esperado, agora: depois })).ok).toBe(false);
  });

  it("organização ou instalação diferentes da linha do token recusam", async () => {
    const { jwt } = await emitir();
    expect((await verificarJwtDeContexto(jwt, { ...esperado, organizationId: randomUUID() })).ok).toBe(false);
    expect((await verificarJwtDeContexto(jwt, { ...esperado, installationId: randomUUID() })).ok).toBe(false);
  });

  it("assinado por OUTRA chave recusa", async () => {
    const { jwt } = await emitir({ chavePem: novaChavePem() });
    expect((await verificarJwtDeContexto(jwt, esperado)).ok).toBe(false);
  });

  it("adulterar o payload recusa", async () => {
    const { jwt } = await emitir();
    const [h, , s] = jwt.split(".");
    const falso = Buffer.from(
      JSON.stringify({ ...decodeJwt(jwt), sub: randomUUID() }),
    ).toString("base64url");
    expect((await verificarJwtDeContexto(`${h}.${falso}.${s}`, esperado)).ok).toBe(false);
  });

  it("alg none e HS256 com a chave pública como segredo recusam", async () => {
    const { jwt } = await emitir();
    const [, p] = jwt.split(".");
    const semAssinatura = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${p}.`;
    expect((await verificarJwtDeContexto(semAssinatura, esperado)).ok).toBe(false);

    const hs = await new SignJWT({ org: ORG, inst: INST })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(PESSOA)
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .setIssuedAt(Math.floor(AGORA.getTime() / 1000))
      .setExpirationTime(Math.floor(AGORA.getTime() / 1000) + 60)
      .sign(createSecretKey(Buffer.from(PEM)));
    expect((await verificarJwtDeContexto(hs, esperado)).ok).toBe(false);
  });

  it("emissor, audiência ou sub fora do formato recusam", async () => {
    const chave = (await import("node:crypto")).createPrivateKey(PEM);
    const t = Math.floor(AGORA.getTime() / 1000);
    const montar = (iss: string, aud: string, sub: string) =>
      new SignJWT({ org: ORG, inst: INST })
        .setProtectedHeader({ alg: "ES256" })
        .setSubject(sub)
        .setIssuer(iss)
        .setAudience(aud)
        .setIssuedAt(t)
        .setExpirationTime(t + 60)
        .sign(chave);
    expect((await verificarJwtDeContexto(await montar(JWT_ISSUER, JWT_AUDIENCE, PESSOA), esperado)).ok).toBe(true);
    expect((await verificarJwtDeContexto(await montar("outro", JWT_AUDIENCE, PESSOA), esperado)).ok).toBe(false);
    expect((await verificarJwtDeContexto(await montar(JWT_ISSUER, "outro", PESSOA), esperado)).ok).toBe(false);
    expect((await verificarJwtDeContexto(await montar(JWT_ISSUER, JWT_AUDIENCE, "nao-e-uuid"), esperado)).ok).toBe(false);
  });

  it("sem chave configurada, nada verifica; lixo recusa sem lançar", async () => {
    const { jwt } = await emitir();
    expect((await verificarJwtDeContexto(jwt, { ...esperado, chavePem: "" })).ok).toBe(false);
    for (const lixo of ["", "a.b.c", "x", "....", jwt.slice(0, -4)]) {
      expect((await verificarJwtDeContexto(lixo, esperado)).ok).toBe(false);
    }
  });
});
