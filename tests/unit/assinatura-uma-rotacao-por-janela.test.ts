/**
 * UMA ROTAÇÃO POR JANELA (#3371, fatia 5).
 *
 * ## O que aconteceu em produção
 *
 * Dois POSTs de refresh com 35 s de intervalo (a trava do banco cobre 30 s) e,
 * depois, ~500 tentativas em ~26 h que a OpenAI passou a recusar todas. O
 * `access_token` da assinatura vive menos que a janela de renovação de 8 dias:
 * a condição de necessidade olhava `renovacaoProxima(expires_at)` — que volta
 * `true` para QUALQUER token com menos de 8 dias de vida —, então o token NOVO,
 * recém-rotacionado, já nascia "próximo de vencer".
 *
 * ## A regra desta fatia
 *
 * A rotação grava o `expires_at` do token NOVO e o marco do fim da janela
 * daquele par (`proxima_renovacao_em`, a última fatia da vida do token). A
 * decisão passa a ser `precisaRenovar(marco lido do banco)`, e a trava de 30 s
 * continua onde está: ela impede dois POSTs SIMULTÂNEOS; o que muda é a
 * CONDIÇÃO DE NECESSIDADE.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.AI_CRED_AES_KEY = "iBc1Z2gYaAH4rEHs1dHQ2dvNQ6t4OfrdE1/Y6OSvtZY=";
});

import {
  JANELA_DA_TRAVA_MS,
  lerLoginCodexRenovandoSeProxima,
} from "@/lib/ai/credenciais/login-codex";
import type { TokensDoCodex } from "@/lib/ai/pontos/pkce-da-assinatura";
import { PROVEDOR_POR_ASSINATURA } from "@/lib/ai/pontos/provedores";
import {
  FRACAO_DA_VIDA_PARA_RENOVAR,
  precisaRenovar,
  proximaRenovacaoEm,
} from "@/lib/ai/pontos/renovacao-da-assinatura";
import { bufToBytea, byteaToBuffer, decryptKey, encryptKey } from "@/lib/crypto/aes_gcm";
import { fecharAvisoDaAssinatura } from "@/lib/ai/credenciais/aviso-da-assinatura";

import { FakeSupabase } from "./helpers/fake-ai-credentials";

vi.mock("@/lib/instalacao/modulos", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  moduloLigado: vi.fn(async () => true),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/ai/provider-validators", () => ({ validateProviderKey: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/ai/credenciais/aviso-da-assinatura", () => ({
  fecharAvisoDaAssinatura: vi.fn(async () => "resolvido"),
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const CRED = "22222222-2222-4222-8222-222222222222";
const UMA_HORA = 60 * 60 * 1000;

/** A vida do access_token da assinatura: MUITO menor que a janela de 8 dias. */
function linhaVencendoEm(ms: number) {
  const guardado: TokensDoCodex = {
    access_token: "at-velho",
    refresh_token: "rt-velho",
    client_id: "siwc-client-test",
    scopes: ["chatgpt.tokens.use.direct"],
    expires_at: Date.now() + ms,
  };
  const c = encryptKey(JSON.stringify(guardado));
  return {
    id: CRED,
    organization_id: ORG,
    provider: PROVEDOR_POR_ASSINATURA,
    is_active: true,
    validated_at: new Date().toISOString(),
    api_key_encrypted: bufToBytea(c.ciphertext),
    api_key_iv: bufToBytea(c.iv),
    api_key_tag: bufToBytea(c.tag),
    // A trava do banco já expirou: é o "35 s depois" do incidente.
    updated_at: new Date(Date.now() - JANELA_DA_TRAVA_MS - 5_000).toISOString(),
  };
}

/** O token que a OpenAI devolve na troca: vida de 1 h, contada de agora. */
function dublarTrocaDeToken() {
  const fetchDuble = vi.fn(async () =>
    new Response(
      JSON.stringify({
        access_token: "at-novo",
        refresh_token: "rt-novo",
        token_type: "Bearer",
        scope: "openid profile email offline_access chatgpt.tokens.use.direct",
        expires_in: UMA_HORA / 1000,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  globalThis.fetch = fetchDuble as never;
  return fetchDuble;
}

/** Abre a porta da trava como se tivessem passado 35 s. */
function passarTrintaECincoSegundos(fake: FakeSupabase) {
  fake.linha!.updated_at = new Date(Date.now() - JANELA_DA_TRAVA_MS - 5_000).toISOString();
}

/** O par que está GRAVADO na credencial, decifrado. */
function guardadoNaLinha(fake: FakeSupabase): Record<string, unknown> {
  const bruto = decryptKey({
    ciphertext: byteaToBuffer(fake.linha!.api_key_encrypted),
    iv: byteaToBuffer(fake.linha!.api_key_iv),
    tag: byteaToBuffer(fake.linha!.api_key_tag),
  });
  return JSON.parse(bruto) as Record<string, unknown>;
}

const fetchOriginal = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = fetchOriginal;
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("o marco da janela, puro", () => {
  it("fim da janela = última fatia da vida do token, com piso de 1 minuto", () => {
    const agora = 1_800_000_000_000;
    expect(FRACAO_DA_VIDA_PARA_RENOVAR).toBe(0.1);
    // Vida de 1 h → renova nos últimos 6 min.
    expect(proximaRenovacaoEm(agora + UMA_HORA, agora)).toBe(agora + 54 * 60 * 1000);
    // Vida de 30 dias → renova nos últimos 3 dias.
    expect(proximaRenovacaoEm(agora + 30 * 24 * UMA_HORA, agora)).toBe(
      agora + 27 * 24 * UMA_HORA,
    );
    // Vida de 30 s → o piso de 1 min responde "pode renovar já".
    expect(proximaRenovacaoEm(agora + 30_000, agora)).toBeLessThanOrEqual(agora);
    // Sem prazo declarado, ninguém inventa janela.
    expect(proximaRenovacaoEm(null, agora)).toBeNull();
  });

  it("precisaRenovar exige as DUAS condições: dentro da janela E marco vencido", () => {
    const agora = 1_800_000_000_000;
    // Token novo (1 h) com marco no futuro: NÃO rotaciona — era o laço de produção.
    expect(
      precisaRenovar(
        { expires_at: agora + UMA_HORA, proxima_renovacao_em: agora + 54 * 60 * 1000 },
        agora,
      ),
    ).toBe(false);
    // Marco vencido, token dentro da janela de 8 dias: rotaciona.
    expect(
      precisaRenovar({ expires_at: agora + 6 * 60 * 1000, proxima_renovacao_em: agora - 1 }, agora),
    ).toBe(true);
    // Par antigo, sem marco: responde pela régua de 8 dias (uma vez).
    expect(precisaRenovar({ expires_at: agora + UMA_HORA }, agora)).toBe(true);
    expect(precisaRenovar({ expires_at: agora + 30 * 24 * UMA_HORA }, agora)).toBe(false);
  });
});

describe("dois turnos seguidos fazem UM POST — a janela do token novo é respeitada", () => {
  it("⭐ o turno seguinte NÃO rotaciona de novo: o marco do token novo está no futuro", async () => {
    const fake = new FakeSupabase();
    fake.linha = linhaVencendoEm(UMA_HORA);
    const fetchDuble = dublarTrocaDeToken();

    const primeiro = await lerLoginCodexRenovandoSeProxima({ admin: fake as never, orgId: ORG });
    expect(primeiro?.access_token).toBe("at-novo");
    expect(fetchDuble).toHaveBeenCalledTimes(1);

    // 35 s depois — o intervalo medido no incidente, já fora da trava de 30 s.
    passarTrintaECincoSegundos(fake);
    const segundo = await lerLoginCodexRenovandoSeProxima({ admin: fake as never, orgId: ORG });

    // O defeito: com `renovacaoProxima(expires_at)` isto era 2, e em 26 h virou ~500.
    expect(
      fetchDuble,
      "rotacionou de novo com o token que o POST anterior acabou de gravar",
    ).toHaveBeenCalledTimes(1);
    expect(segundo?.access_token).toBe("at-novo");
  });

  it("⭐ o expires_at do token NOVO e o marco ficam GRAVADOS na credencial", async () => {
    const fake = new FakeSupabase();
    fake.linha = linhaVencendoEm(UMA_HORA);
    dublarTrocaDeToken();

    const antes = Date.now();
    const devolvidos = await lerLoginCodexRenovandoSeProxima({ admin: fake as never, orgId: ORG });
    const gravado = guardadoNaLinha(fake);

    expect(gravado.access_token).toBe("at-novo");
    expect(gravado.expires_at).toBe(devolvidos?.expires_at);
    // Vida nova (1 h) contada de agora — não o `expires_at` do token velho.
    expect(Number(gravado.expires_at)).toBeGreaterThanOrEqual(antes + UMA_HORA - 5_000);
    // E o marco é o fim da janela DESSE par.
    expect(Number(gravado.proxima_renovacao_em)).toBe(
      proximaRenovacaoEm(Number(gravado.expires_at)),
    );
    expect(Number(gravado.proxima_renovacao_em)).toBeGreaterThan(Date.now());
  });

  it("quando a janela do token novo abre, a rotação acontece de novo (não é 'nunca mais')", async () => {
    const fake = new FakeSupabase();
    fake.linha = linhaVencendoEm(UMA_HORA);
    const fetchDuble = dublarTrocaDeToken();

    await lerLoginCodexRenovandoSeProxima({ admin: fake as never, orgId: ORG });
    expect(fetchDuble).toHaveBeenCalledTimes(1);

    const marco = Number(guardadoNaLinha(fake).proxima_renovacao_em);
    passarTrintaECincoSegundos(fake);

    // Um minuto depois do fim da janela: o par já está na última fatia da vida.
    await lerLoginCodexRenovandoSeProxima({
      admin: fake as never,
      orgId: ORG,
      agora: marco + 60_000,
    });
    expect(fetchDuble).toHaveBeenCalledTimes(2);
  });
});

describe("a renovação que volta a dar certo fecha o aviso da Central", () => {
  it("⭐ a renovação AUTOMÁTICA bem-sucedida fecha o aviso da empresa — sem clique", async () => {
    const fake = new FakeSupabase();
    fake.linha = linhaVencendoEm(UMA_HORA);
    dublarTrocaDeToken();

    await lerLoginCodexRenovandoSeProxima({ admin: fake as never, orgId: ORG });

    // Um timeout passageiro abriu o aviso; a renovação seguinte deu certo. Sem
    // isto ele ficava aberto, contra o próprio texto ("se fecha sozinho").
    expect(vi.mocked(fecharAvisoDaAssinatura)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fecharAvisoDaAssinatura).mock.calls[0]?.[1]).toBe(ORG);
  });

  it("renovação que falha NÃO fecha o aviso", async () => {
    const fake = new FakeSupabase();
    fake.linha = linhaVencendoEm(UMA_HORA);
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as never;

    await lerLoginCodexRenovandoSeProxima({ admin: fake as never, orgId: ORG });

    expect(vi.mocked(fecharAvisoDaAssinatura)).not.toHaveBeenCalled();
  });
});
