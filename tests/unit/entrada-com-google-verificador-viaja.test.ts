/**
 * O VERIFICADOR DE PKCE DA ENTRADA COM GOOGLE PRECISA VIAJAR DE VOLTA.
 *
 * ─── O defeito que este arquivo existe para não deixar voltar ────────────────
 *
 * `signInWithOAuth` (auth-js, com `flowType: "pkce"` que o `@supabase/ssr`
 * força) sorteia um verificador e o GRAVA EM COOKIE, usando as `cookieOptions`
 * do cliente que fez a chamada. O cliente do produto é `sameSite: "strict"`.
 *
 * A volta do Google é navegação vinda de outro site — `accounts.google.com` →
 * GoTrue → `/auth/callback` — e o navegador NÃO manda cookie `Strict` numa
 * dessas. Resultado medido na issue #1388, ao dirigir o `/authorize` na mão e
 * preparar o cookie por fora: `PKCE code verifier not found in storage`, e o
 * fluxo nunca completa.
 *
 * ─── Por que um teste, e não um comentário ──────────────────────────────────
 *
 * Consertar a INSTÂNCIA é trocar o `sameSite` de um cliente. O defeito volta
 * sozinho na próxima vez que alguém "limpar" o cliente de OAuth, ou apontar a
 * action para o `createClient` de sempre — o typecheck passa, a tela renderiza,
 * e o erro só aparece no fim de um consentimento real, que nenhuma suíte local
 * exercita. É a mesma classe que `tests/unit/callback-oauth-alcancavel.test.ts`
 * guarda para os callbacks de integração.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { isPublicPath } from "@/lib/auth/public-paths";
import { CAMINHO_DO_RETORNO_DO_GOOGLE, urlDeRetornoDoGoogle } from "@/lib/auth/entrada-com-google";

const FONTE_DO_CLIENTE = readFileSync("lib/supabase/server.ts", "utf8");
const FONTE_DA_ACTION = readFileSync("app/actions/auth/signInWithGoogle.ts", "utf8");
const FONTE_DO_CALLBACK = readFileSync("app/auth/callback/route.ts", "utf8");

describe("o verificador de PKCE da entrada com Google viaja de volta", () => {
  it("o cliente da ida grava com sameSite Lax — Strict não viaja na volta do Google", () => {
    // A função existe e é ela que usa lax.
    expect(FONTE_DO_CLIENTE).toMatch(/export async function createClientDeEntradaComGoogle/);
    const corpo = FONTE_DO_CLIENTE.slice(
      FONTE_DO_CLIENTE.indexOf("export async function createClientDeEntradaComGoogle"),
    );
    expect(corpo, "o cliente da entrada com Google precisa gravar com `lax`").toMatch(
      /clienteDeServidor\(\s*"lax"\s*\)/,
    );
    // E o cliente de sempre continua Strict: o que fica frouxo é o verificador
    // de uso único, nunca o cookie de sessão.
    expect(FONTE_DO_CLIENTE).toMatch(/export async function createClient\(\)[\s\S]{0,120}?"strict"/);
  });

  it("a action de ida usa esse cliente — e não o de sessão", () => {
    expect(FONTE_DA_ACTION).toMatch(/await createClientDeEntradaComGoogle\(\)/);
    expect(
      FONTE_DA_ACTION,
      "a ida com o `createClient` de sempre grava o verificador em cookie Strict e a volta falha sempre",
    ).not.toMatch(/await createClient\(\)/);
  });

  it("a volta troca o code por sessão NO SERVIDOR, com o cliente de sessão", () => {
    expect(FONTE_DO_CALLBACK).toMatch(/auth\.exchangeCodeForSession\(/);
    expect(FONTE_DO_CALLBACK).toMatch(/await createClient\(\)/);
  });

  it("`/auth/callback` é alcançável sem cookie de sessão", () => {
    // Sem isto o `proxy` responde 307 para `/login` antes de a rota existir, e
    // o fluxo nunca completa — medido em produção com o callback da agenda.
    expect(isPublicPath(CAMINHO_DO_RETORNO_DO_GOOGLE)).toBe(true);
  });
});

describe("o redirectTo da ida", () => {
  const APP = "https://crm.exemplo.com.br";

  it("é absoluto, no domínio da instalação, e aponta para o callback", () => {
    expect(urlDeRetornoDoGoogle(APP)).toBe(`${APP}/auth/callback`);
  });

  it("leva o `next` pedido — é o único canal que sobrevive ao pulo pelo Google", () => {
    const url = new URL(urlDeRetornoDoGoogle(APP, { next: "/app/inbox" }));
    expect(url.searchParams.get("next")).toBe("/app/inbox");
  });

  it("descarta `next` externo — quem o aplica é `safeNext`, e a URL é nossa", () => {
    const url = new URL(urlDeRetornoDoGoogle(APP, { next: "https://evil.exemplo.com" }));
    expect(url.searchParams.get("next")).toBeNull();
    expect(url.host).toBe("crm.exemplo.com.br");
  });

  it("leva o convite quando há, e nada quando não há", () => {
    expect(
      new URL(urlDeRetornoDoGoogle(APP, { convite: " tok " })).searchParams.get("convite"),
    ).toBe("tok");
    expect(
      new URL(urlDeRetornoDoGoogle(APP, { convite: "   " })).searchParams.get("convite"),
    ).toBeNull();
  });
});
