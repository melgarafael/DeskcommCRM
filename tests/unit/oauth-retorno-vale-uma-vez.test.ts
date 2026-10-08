/**
 * O retorno do OAuth vale UMA vez — nos dois callbacks que não queimavam o
 * nonce do `state` (Google Ads e Nuvemshop). O irmão da Agenda já queimava
 * (`app/api/v1/agenda/google/callback/route.ts`); aqui a régua é a mesma: o
 * mesmo `state` apresentado de novo, dentro do prazo, é recusado ANTES de
 * qualquer troca de código.
 *
 * A tabela de nonces é simulada respeitando a chave primária (`23505` na
 * segunda inserção do mesmo nonce), que é o que o Postgres faz de verdade.
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SEGREDO = "um-segredo-de-instalacao-bem-comprido";

const fake = vi.hoisted(() => ({
  nonces: new Set<string>(),
  trocasAds: 0,
  trocasNuvemshop: 0,
}));

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_SECRET: "um-segredo-de-instalacao-bem-comprido", NEXT_PUBLIC_APP_URL: "http://localhost:3000" },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/impersonate/support", () => ({ supportCallbackWriteAllowed: async () => true }));
vi.mock("@/lib/webhooks/secrets", () => ({ encryptWebhookSecret: async () => "cifrado" }));
vi.mock("@/lib/plataformas-de-anuncio/google/config", () => ({
  CAMINHO_DO_CALLBACK: "/api/v1/plataformas-de-anuncio/google/callback",
  configuracaoDoGoogleAds: () => ({ clientId: "id", clientSecret: "s", redirectUri: "http://localhost:3000/cb" }),
}));
vi.mock("@/lib/plataformas-de-anuncio/google/token", () => ({
  trocarCodigoPorToken: async () => {
    fake.trocasAds += 1;
    return { ok: true, token: { refresh_token: "r" } };
  },
}));
vi.mock("@/lib/nuvemshop/config", () => ({
  getConfig: () => ({ clientSecret: "local" }),
  SUBSCRIBED_EVENTS: [],
  eventToSlug: () => "x",
}));
vi.mock("@/lib/nuvemshop/oauth", () => ({
  exchangeCodeForToken: async () => {
    fake.trocasNuvemshop += 1;
    return { ok: true, accessToken: "local", storeId: "12345", scope: "read_orders" };
  },
}));
vi.mock("@/lib/nuvemshop/api-client", () => ({ NuvemshopApiClient: class {} }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async () => ({ data: "\\x00", error: null }),
    from: (tabela: string) => ({
      insert: async (linha: { nonce: string }) => {
        if (tabela !== "calendar_oauth_nonces") return { error: null };
        if (fake.nonces.has(linha.nonce)) return { error: { code: "23505", message: "duplicate key" } };
        fake.nonces.add(linha.nonce);
        return { error: null };
      },
      upsert: () => {
        const resultado = { data: { id: randomUUID() }, error: null };
        return Object.assign(Promise.resolve(resultado), { select: () => ({ single: async () => resultado }) });
      },
      update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
    }),
  }),
}));

beforeEach(() => {
  fake.nonces.clear();
  fake.trocasAds = 0;
  fake.trocasNuvemshop = 0;
});

describe("o retorno do OAuth vale uma vez", () => {
  it("Google Ads: o mesmo state na segunda volta é recusado sem trocar código", async () => {
    const { emitirEstado } = await import("@/lib/plataformas-de-anuncio/google/estado");
    const { GET } = await import("@/app/api/v1/plataformas-de-anuncio/google/callback/route");
    const { assinarVinculo, NOME_DO_VINCULO } = await import("@/lib/agenda/google/vinculo");
    const nonce = randomUUID().replace(/-/g, "");
    const state = emitirEstado(
      { organizationId: randomUUID(), userId: randomUUID() },
      { segredo: SEGREDO, agora: new Date(), nonce },
    );
    // O mesmo navegador nas duas voltas: o que está sob teste aqui é o uso único.
    const pedido = () =>
      new NextRequest(`http://localhost/api/v1/plataformas-de-anuncio/google/callback?code=c&state=${encodeURIComponent(state)}`, {
        headers: { cookie: `${NOME_DO_VINCULO}=${assinarVinculo(nonce, SEGREDO)}` },
      });

    const primeira = await GET(pedido());
    expect(new URL(primeira.headers.get("location")!).searchParams.get("ok")).toBe("1");

    const segunda = await GET(pedido());
    expect(new URL(segunda.headers.get("location")!).searchParams.get("erro")).toBe("estado_invalido");
    expect(fake.trocasAds, "a segunda volta não pode chegar à troca do código").toBe(1);
  });

  it("Nuvemshop: o mesmo state na segunda volta é recusado sem trocar código", async () => {
    const { issueState } = await import("@/lib/nuvemshop/state");
    const { GET } = await import("@/app/api/v1/integrations/nuvemshop/callback/route");
    const state = issueState(randomUUID(), { userId: randomUUID(), authSessionId: randomUUID() });
    const pedido = () =>
      new NextRequest(`http://localhost/api/v1/integrations/nuvemshop/callback?code=c&state=${encodeURIComponent(state)}`);

    const primeira = await GET(pedido());
    expect(primeira.headers.get("location")).not.toContain("error=");

    const segunda = await GET(pedido());
    expect(segunda.headers.get("location")).toContain("error=invalid_state");
    expect(fake.trocasNuvemshop, "a segunda volta não pode chegar à troca do código").toBe(1);
  });
});
