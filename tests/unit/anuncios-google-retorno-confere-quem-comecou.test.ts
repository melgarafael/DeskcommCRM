/**
 * A volta da conexão de anúncios do Google só é aceita quando vem do mesmo
 * navegador que a começou, sob a mesma régua de sessão de suporte dos outros
 * callbacks, e nunca vira 500 quando o `state` não pode ser conferido.
 *
 * Irmão de `tests/unit/oauth-retorno-vale-uma-vez.test.ts` (uso único). Aqui
 * cada caso mede um portão: sem ele, o caso correspondente reprova.
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SEGREDO = "um-segredo-de-instalacao-bem-comprido";
const ORG = randomUUID();
const USER = randomUUID();
const SESSAO = randomUUID();
const CALLBACK = "/api/v1/plataformas-de-anuncio/google/callback";

const fake = vi.hoisted(() => ({
  env: { INTERNAL_SECRET: "um-segredo-de-instalacao-bem-comprido", NEXT_PUBLIC_APP_URL: "http://localhost:3000" },
  nonces: new Set<string>(),
  trocas: 0,
  suporteLibera: true,
  chamadasDeSuporte: [] as unknown[][],
  erros: [] as string[],
}));

vi.mock("@/lib/env", () => ({ env: fake.env }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { error: (msg: string) => fake.erros.push(msg), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: async () => null,
  authenticatedSessionId: async () => SESSAO,
  supportCallbackWriteAllowed: async (...args: unknown[]) => {
    fake.chamadasDeSuporte.push(args);
    return fake.suporteLibera;
  },
}));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({ ok: true, user: { id: USER, email: "a@exemplo.com" }, org: { orgId: ORG } }),
}));
vi.mock("@/lib/webhooks/secrets", () => ({ encryptWebhookSecret: async () => "cifrado" }));
vi.mock("@/lib/plataformas-de-anuncio/google/config", () => ({
  CAMINHO_DO_CALLBACK: "/api/v1/plataformas-de-anuncio/google/callback",
  configuracaoDoGoogleAds: () => ({ clientId: "id", clientSecret: "s", redirectUri: "http://localhost:3000/cb" }),
}));
vi.mock("@/lib/plataformas-de-anuncio/google/oauth", () => ({
  montarUrlDeConsentimento: (_app: unknown, { state }: { state: string }) =>
    `https://consentimento.exemplo/o?state=${encodeURIComponent(state)}`,
}));
vi.mock("@/lib/plataformas-de-anuncio/google/token", () => ({
  trocarCodigoPorToken: async () => {
    fake.trocas += 1;
    return { ok: true, token: { refresh_token: "r" } };
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => ({
      insert: async (linha: { nonce: string }) => {
        if (tabela !== "calendar_oauth_nonces") return { error: null };
        if (fake.nonces.has(linha.nonce)) return { error: { code: "23505", message: "duplicate key" } };
        fake.nonces.add(linha.nonce);
        return { error: null };
      },
      upsert: async () => ({ error: null }),
    }),
  }),
}));

beforeEach(() => {
  fake.env.INTERNAL_SECRET = SEGREDO;
  fake.nonces.clear();
  fake.trocas = 0;
  fake.suporteLibera = true;
  fake.chamadasDeSuporte = [];
  fake.erros = [];
});

/** Começa a conexão como o navegador faria e devolve o `state` e o cookie gravado. */
async function comecar(): Promise<{ state: string; cookie: string }> {
  const { GET } = await import("@/app/api/v1/plataformas-de-anuncio/google/connect/route");
  const resposta = await GET(new NextRequest("http://localhost/api/v1/plataformas-de-anuncio/google/connect"));
  const state = new URL(resposta.headers.get("location")!).searchParams.get("state")!;
  const gravado = resposta.cookies.get("crm_oauth_bind");
  expect(gravado, "o connect não gravou o cookie de vínculo").toBeDefined();
  expect(gravado!.path).toBe(CALLBACK);
  expect(gravado!.httpOnly).toBe(true);
  expect(gravado!.sameSite).toBe("lax");
  return { state, cookie: `crm_oauth_bind=${gravado!.value}` };
}

async function voltar(state: string, cookie?: string) {
  const { GET } = await import("@/app/api/v1/plataformas-de-anuncio/google/callback/route");
  const resposta = await GET(
    new NextRequest(`http://localhost${CALLBACK}?code=c&state=${encodeURIComponent(state)}`, {
      headers: cookie ? { cookie } : {},
    }),
  );
  const destino = new URL(resposta.headers.get("location")!);
  return { ok: destino.searchParams.get("ok"), erro: destino.searchParams.get("erro") };
}

describe("a volta da conexão de anúncios confere quem começou", () => {
  it("controle: o mesmo navegador volta e a conexão é gravada", async () => {
    const { state, cookie } = await comecar();
    expect(await voltar(state, cookie)).toEqual({ ok: "1", erro: null });
    expect(fake.trocas).toBe(1);
  });

  it("sem o cookie de quem começou: recusa sem queimar o nonce nem trocar o código", async () => {
    const { state } = await comecar();
    expect((await voltar(state)).erro).toBe("estado_invalido");
    expect(fake.trocas).toBe(0);
    expect(fake.nonces.size, "a recusa veio depois da queima do nonce").toBe(0);
  });

  it("com o cookie de OUTRO começo: recusa", async () => {
    const primeiro = await comecar();
    const segundo = await comecar();
    expect((await voltar(primeiro.state, segundo.cookie)).erro).toBe("estado_invalido");
    expect(fake.trocas).toBe(0);
  });

  it("aplica a régua de sessão de suporte com quem e qual sessão começou", async () => {
    const { state, cookie } = await comecar();
    fake.suporteLibera = false;
    expect((await voltar(state, cookie)).erro).toBe("estado_invalido");
    expect(fake.trocas).toBe(0);
    expect(fake.nonces.size).toBe(0);
    expect(fake.chamadasDeSuporte).toEqual([[ORG, USER, SESSAO]]);
  });

  it("segredo curto: volta para a tela com estado_invalido e registra no log, sem 500", async () => {
    const { state, cookie } = await comecar();
    fake.env.INTERNAL_SECRET = "curto";
    expect((await voltar(state, cookie)).erro).toBe("estado_invalido");
    expect(fake.trocas).toBe(0);
    expect(fake.erros.some((m) => m.includes("state não verificável"))).toBe(true);
  });
});
