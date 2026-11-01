/**
 * A RECUSA DIZ POR QUÊ (#3371, fatia 3).
 *
 * ## O que aconteceu em produção
 *
 * Cliente Obralivre, `401 · Provided authentication token is expired` em 107
 * turnos seguidos, ~26 h sem a IA responder e cota sobrando. A renovação
 * automática tentou ~500 vezes e falhou em SILÊNCIO: `renovarComTravaDeBanco`
 * tinha `catch { return { ok: false, motivo: "falha" } }` — o mesmo `falha` para
 * refresh revogado, `invalid_grant`, DNS fora do ar e timeout —, e
 * `lerLoginCodexRenovandoSeProxima` tinha outro `catch` vazio. Nenhum dos dois
 * escrevia nada em `ai_provider_credentials.validation_error`, o campo que a
 * tela de Credenciais mostra a quem vai reconectar a conta.
 *
 * ## O que este arquivo guarda
 *
 *  1. O motivo da recusa chega ao RETORNO (`motivoDetalhe`) com nome próprio —
 *     não um `falha` genérico.
 *  2. O motivo é GRAVADO em `validation_error` da credencial.
 *  3. O caminho automático (sem usuário, sem retorno lido por ninguém) registra
 *     O MESMO motivo no log.
 *  4. Nem o log nem o campo carregam token: nada de `access_token`, de
 *     `refresh_token` nem de cabeçalho de autorização.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Precisa existir ANTES de qualquer import: `lib/env.ts` lê o processo no
// carregamento do módulo, e é ele que entrega a chave de cifragem ao AES.
vi.hoisted(() => {
  process.env.AI_CRED_AES_KEY = "iBc1Z2gYaAH4rEHs1dHQ2dvNQ6t4OfrdE1/Y6OSvtZY=";
});

import {
  lerLoginCodexRenovandoSeProxima,
  renovarComTravaDeBanco,
} from "@/lib/ai/credenciais/login-codex";
import { ErroDeToken, type TokensDoCodex } from "@/lib/ai/pontos/pkce-da-assinatura";
import { PROVEDOR_POR_ASSINATURA } from "@/lib/ai/pontos/provedores";
import { detalheDaRecusaDeRenovacao } from "@/lib/ai/pontos/renovacao-da-assinatura";
import { bufToBytea, encryptKey } from "@/lib/crypto/aes_gcm";
import { logger } from "@/lib/logger";

import { FakeSupabase } from "./helpers/fake-ai-credentials";

const estado = vi.hoisted(() => ({ modulo: true }));

vi.mock("@/lib/instalacao/modulos", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  moduloLigado: vi.fn(async () => estado.modulo),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/ai/provider-validators", () => ({ validateProviderKey: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const CRED = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

const tokens: TokensDoCodex = {
  access_token: "at-1234567890",
  refresh_token: "rt-9876543210",
  client_id: "siwc-client-test",
  scopes: ["chatgpt.tokens.use.direct"],
  expires_at: null,
};

/** A linha cifrada da empresa, como `guardarLoginCodex` a deixa. */
function linhaCifrada(extra: Record<string, unknown> = {}) {
  const c = encryptKey(JSON.stringify(tokens));
  return {
    id: CRED,
    organization_id: ORG,
    provider: PROVEDOR_POR_ASSINATURA,
    label: "Assinatura do ChatGPT",
    is_active: true,
    validated_at: new Date().toISOString(),
    validation_error: null as string | null,
    api_key_encrypted: bufToBytea(c.ciphertext),
    api_key_iv: bufToBytea(c.iv),
    api_key_tag: bufToBytea(c.tag),
    updated_at: new Date(Date.now() - 60_000).toISOString(),
    ...extra,
  };
}

function admin() {
  return new FakeSupabase();
}

/** Renovação que lança o erro que o provedor lançaria. */
function queFalha(erro: unknown) {
  return async (): Promise<TokensDoCodex> => {
    throw erro;
  };
}

beforeEach(() => {
  estado.modulo = true;
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.error).mockClear();
});

describe("o motivo da recusa chega com nome, não como 'falha'", () => {
  it("⭐ refresh_token_revoked volta em `motivoDetalhe` E fica gravado em validation_error", async () => {
    const fake = admin();
    fake.linha = linhaCifrada();

    const r = await renovarComTravaDeBanco({
      admin: fake as never,
      orgId: ORG,
      credentialId: CRED,
      userId: null,
      renovar: queFalha(new ErroDeToken("refresh_token_revoked", 400)),
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe("falha");
    // O defeito: sem isto, a recusa de 26 h de produção era indistinguível de
    // "a OpenAI não respondeu".
    expect(r.motivoDetalhe).toBe("refresh_token_revoked");
    expect(String(fake.linha!.validation_error)).toContain("refresh_token_revoked");
  });

  it("invalid_grant, timeout e fetch failed ganham rótulos DIFERENTES entre si", async () => {
    const casos: Array<{ erro: unknown; esperado: string }> = [
      { erro: new Error("invalid_grant"), esperado: "invalid_grant" },
      {
        erro: Object.assign(new Error("The operation was aborted due to timeout"), {
          name: "TimeoutError",
        }),
        esperado: "timeout",
      },
      { erro: new TypeError("fetch failed"), esperado: "fetch_failed" },
      { erro: new Error("Provided authentication token is expired"), esperado: "token_expired" },
    ];

    for (const caso of casos) {
      const fake = admin();
      fake.linha = linhaCifrada();
      const r = await renovarComTravaDeBanco({
        admin: fake as never,
        orgId: ORG,
        credentialId: CRED,
        userId: null,
        renovar: queFalha(caso.erro),
      });
      expect(r.ok, `caso ${caso.esperado}`).toBe(false);
      if (r.ok) continue;
      expect(r.motivoDetalhe, `caso ${caso.esperado}`).toBe(caso.esperado);
    }
  });

  it("e a tradução é pura: o mesmo erro classificado sem banco nenhum", () => {
    expect(detalheDaRecusaDeRenovacao(new ErroDeToken("refresh_token_revoked", 400))).toBe(
      "refresh_token_revoked",
    );
    expect(detalheDaRecusaDeRenovacao(new ErroDeToken("rede", null))).toBe("fetch_failed");
    expect(detalheDaRecusaDeRenovacao(new ErroDeToken("recusado", 400))).toBe("recusado");
    expect(detalheDaRecusaDeRenovacao(new Error("coisa estranha"))).toBe("desconhecido");
  });
});

describe("nem o log nem o campo carregam token", () => {
  it("⭐ o log da recusa leva organização e rótulo — nunca access/refresh/Bearer", async () => {
    const fake = admin();
    fake.linha = linhaCifrada();

    await renovarComTravaDeBanco({
      admin: fake as never,
      orgId: ORG,
      credentialId: CRED,
      userId: USER,
      // A mensagem do provedor pode ecoar o token recusado; o log não pode.
      renovar: queFalha(
        new ErroDeToken(
          "refresh_token_revoked",
          400,
          `invalid_grant: refresh_token rt-9876543210 revogado (Bearer at-1234567890)`,
        ),
      ),
    });

    const registros = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(registros).toContain("refresh_token_revoked");
    expect(registros).toContain(ORG);
    expect(registros).not.toContain("rt-9876543210");
    expect(registros).not.toContain("at-1234567890");
    expect(registros).not.toContain("Bearer");

    // O campo que a tela mostra também é só o rótulo.
    const gravado = String(fake.linha!.validation_error);
    expect(gravado).toContain("refresh_token_revoked");
    expect(gravado).not.toContain("rt-9876543210");
    expect(gravado).not.toContain("at-1234567890");
  });
});

describe("o caminho AUTOMÁTICO registra o mesmo motivo (é ele que rodou 500 vezes)", () => {
  it("⭐ lerLoginCodexRenovandoSeProxima loga o motivo da recusa", async () => {
    const fake = admin();
    fake.linha = linhaCifrada({
      // Token a 1 h de vencer: dentro da janela de 8 dias, logo a renovação é tentada.
      ...(() => {
        const c = encryptKey(
          JSON.stringify({ ...tokens, expires_at: Date.now() + 60 * 60 * 1000 }),
        );
        return {
          api_key_encrypted: bufToBytea(c.ciphertext),
          api_key_iv: bufToBytea(c.iv),
          api_key_tag: bufToBytea(c.tag),
        };
      })(),
    });

    // `renovarPorRefreshToken` fala com a OpenAI; o dublê devolve a recusa.
    const fetchOriginal = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as never;
    try {
      const devolvidos = await lerLoginCodexRenovandoSeProxima({
        admin: fake as never,
        orgId: ORG,
      });
      // A falha não derruba a leitura: o token atual ainda pode valer.
      expect(devolvidos?.access_token).toBe("at-1234567890");
    } finally {
      globalThis.fetch = fetchOriginal;
    }

    const motivos = vi
      .mocked(logger.warn)
      .mock.calls.map(([, contexto]) => JSON.stringify(contexto ?? {}));
    expect(motivos.some((m) => m.includes("fetch_failed"))).toBe(true);
    expect(motivos.some((m) => m.includes(ORG))).toBe(true);
  });
});
