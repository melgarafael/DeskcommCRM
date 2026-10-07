/**
 * A CONTA DE UMA EMPRESA: gravação cifrada, leitores que recusam, trava no banco.
 *
 * Cinco perguntas do PR #1672, cada uma com um caso que reprova se a linha for
 * quebrada:
 *
 *  1. A gravação marca `validated_at` (item 4) — sem isso `loadCredential`
 *     recusa a credencial que o login acabou de provar.
 *  2. O `api_key_last4` do login é o do ACCESS_TOKEN, não o fim do JSON (item 3).
 *  3. `loadCredential` recusa a linha do login: nenhum leitor genérico manda o
 *     JSON dos tokens como chave (item 9).
 *  4. `resolveOrgLlmConfig` filtra por `provider` nos DOIS caminhos, inclusive o
 *     por `credentialId` (item 9).
 *  5. A trava de renovação está NO BANCO: um `update` condicional que só um
 *     processo vence, e o módulo desligado não deixa nem renovar nem gravar
 *     (itens 7 e 8).
 *
 * Sabotagem que confirma que a guarda vigia: apagar o `.lt("updated_at", …)` da
 * trava deixa o caso 5 vermelho (dois processos renovam); tirar o `validated_at`
 * da gravação deixa o caso 1 vermelho; apagar o filtro de `provider` de uma das
 * duas queries do resolvedor deixa o caso 4 vermelho.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Precisa existir ANTES de qualquer import: `lib/env.ts` lê o processo no
// carregamento do módulo, e é ele que entrega a chave de cifragem ao AES.
vi.hoisted(() => {
  process.env.AI_CRED_AES_KEY = "iBc1Z2gYaAH4rEHs1dHQ2dvNQ6t4OfrdE1/Y6OSvtZY=";
});

import {
  guardarCredencial,
  guardarCredencialDoLogin,
  rotacionarCredencial,
} from "@/lib/ai/credenciais/guardar";
import {
  guardarLoginCodex,
  lerLoginCodex,
  renovarComTravaDeBanco,
} from "@/lib/ai/credenciais/login-codex";
import { audit } from "@/lib/audit";
import { CredentialUnavailableError, loadCredential } from "@/lib/ai/credentials";
import { PROVEDOR_POR_ASSINATURA } from "@/lib/ai/pontos/provedores";
import { resolveOrgLlmConfig } from "@/lib/agent-engine/edge/llm/credentials";
import { bufToBytea, encryptKey } from "@/lib/crypto/aes_gcm";
import { validateProviderKey } from "@/lib/ai/provider-validators";
import type { TokensDoCodex } from "@/lib/ai/pontos/pkce-da-assinatura";

import { FakeSupabase } from "./helpers/fake-ai-credentials";

const estado = vi.hoisted(() => ({ fake: null as unknown, modulo: true }));
const org = "11111111-1111-4111-8111-111111111111";
const user = "33333333-3333-4333-8333-333333333333";
const credId = "22222222-2222-4222-8222-222222222222";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => estado.fake,
  isServiceRoleConfigured: () => true,
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/ai/provider-validators", () => ({
  validateProviderKey: vi.fn(async () => ({ ok: true, models: ["codex-mini"] })),
}));
vi.mock("@/lib/instalacao/modulos", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  moduloLigado: vi.fn(async () => estado.modulo),
}));

function admin() {
  return new FakeSupabase();
}
const tokens: TokensDoCodex = {
  access_token: "at-1234567890",
  refresh_token: "rt-9876543210",
  expires_at: null,
};

beforeEach(() => {
  estado.modulo = true;
  vi.mocked(validateProviderKey).mockClear();
});

describe("gravar a conta da empresa (itens 3 e 4)", () => {
  it("a gravação nasce com validated_at e o last4 é o do access_token", async () => {
    const fake = admin();
    const r = await guardarCredencialDoLogin({
      admin: fake as never,
      orgId: org,
      userId: user,
      label: "Assinatura do Codex (ChatGPT)",
      apiKey: JSON.stringify(tokens),
    });
    expect(r.ok).toBe(true);
    expect(fake.linha!.provider).toBe(PROVEDOR_POR_ASSINATURA);
    const linha = fake.linha!;
    expect(typeof linha.validated_at).toBe("string");
    expect(linha.validated_at).not.toBeNull();
    expect(linha.api_key_last4).toBe("7890");
    // O login não tem endpoint de chave para pingar: validar em segundo plano
    // zeraria o `validated_at` que a troca do código acabou de provar.
    expect(validateProviderKey).not.toHaveBeenCalled();
    // E o segredo nunca vai em claro.
    expect(String(linha.api_key_encrypted)).not.toContain("rt-9876543210");
  });

  // O cadastro GENÉRICO (rota REST, onboarding) recebe texto colado. Se ele
  // aceitasse a assinatura, o texto nasceria "validado" — a marca acima — sem
  // login nenhum. Vale com o módulo LIGADO (o `beforeEach` o liga): a credencial
  // só nasce pelo login, nunca por colagem.
  it("o cadastro genérico recusa a assinatura e não grava nada", async () => {
    const fake = admin();
    const r = await guardarCredencial({
      admin: fake as never,
      orgId: org,
      userId: user,
      provider: PROVEDOR_POR_ASSINATURA,
      label: "colada",
      apiKey: "sk-texto-colado-qualquer",
    });
    expect(r).toEqual({ ok: false, motivo: "assinatura_so_pelo_login" });
    expect(fake.linha).toBeNull();
  });

  it("o cadastro genérico segue gravando os outros provedores, sem marca de validada", async () => {
    const fake = admin();
    const r = await guardarCredencial({
      admin: fake as never,
      orgId: org,
      userId: user,
      provider: "openai",
      label: "chave da openai",
      apiKey: "sk-chave-da-openai-1234",
    });
    expect(r.ok).toBe(true);
    expect(fake.linha!.provider).toBe("openai");
    expect(fake.linha!.validated_at ?? null).toBeNull();
  });

  it("rotacionar o par de tokens CONFIRMA o login em vez de zerar o validated_at", async () => {
    const fake = admin();
    fake.linha = {
      id: credId,
      organization_id: org,
      provider: PROVEDOR_POR_ASSINATURA,
      label: "Assinatura do Codex (ChatGPT)",
      is_active: true,
      updated_at: new Date(Date.now() - 60_000).toISOString(),
    };
    const r = await rotacionarCredencial({
      admin: fake as never,
      orgId: org,
      userId: user,
      credentialId: credId,
      provider: PROVEDOR_POR_ASSINATURA,
      apiKey: JSON.stringify({ ...tokens, access_token: "at-novo" }),
    });
    expect(r.ok).toBe(true);
    expect(typeof fake.linha!.validated_at).toBe("string");
    expect(validateProviderKey).not.toHaveBeenCalled();
  });

  it("com o módulo da instalação desligado, nada é gravado", async () => {
    estado.modulo = false;
    const fake = admin();
    const r = await guardarLoginCodex({ admin: fake as never, orgId: org, userId: user, tokens });
    expect(r).toEqual({ ok: false, motivo: "modulo_desligado" });
    expect(fake.linha).toBeNull();
  });
});

describe("nenhum leitor genérico usa o JSON dos tokens como chave (item 9)", () => {
  it("loadCredential recusa a linha do login com not_found", async () => {
    const fake = admin();
    fake.linha = {
      id: credId,
      organization_id: org,
      provider: PROVEDOR_POR_ASSINATURA,
      label: "Assinatura do Codex (ChatGPT)",
      is_active: true,
      validated_at: new Date().toISOString(),
      api_key_encrypted: bufToBytea(encryptKey(JSON.stringify(tokens)).ciphertext),
      api_key_iv: bufToBytea(encryptKey(JSON.stringify(tokens)).iv),
      api_key_tag: bufToBytea(encryptKey(JSON.stringify(tokens)).tag),
    };
    estado.fake = fake;
    await expect(loadCredential(credId, org)).rejects.toBeInstanceOf(CredentialUnavailableError);
    await expect(loadCredential(credId, org)).rejects.toMatchObject({ reason: "not_found" });
  });

  it("resolveOrgLlmConfig filtra o provider nos DOIS caminhos, inclusive por credentialId", async () => {
    const sqls: string[] = [];
    const db = {
      query: async (sql: string) => {
        sqls.push(sql);
        if (sql.includes("from organizations")) {
          return {
            rows: [
              {
                llm: { provider: "openai", default_model: null, params: {}, enabled_models: [] },
                teto: null,
                modo: null,
                efetivo_em: null,
                limiar_pct: null,
              },
            ],
          };
        }
        return { rows: [] };
      },
    };
    const cfg = {
      openaiApiKey: "sk-plataforma",
      cacheTtl: "1h",
      deepseekThinking: "provider",
      budgetEnforcement: "on",
    } as never;

    await resolveOrgLlmConfig(db as never, cfg, org);
    await resolveOrgLlmConfig(db as never, cfg, org, { credentialId: credId });

    const dasCredenciais = sqls.filter((s) => s.includes("ai_provider_credentials"));
    expect(dasCredenciais.length).toBe(2);
    for (const sql of dasCredenciais) {
      expect(sql).toContain(`provider <> '${PROVEDOR_POR_ASSINATURA}'`);
    }
    // Controle: a query de orçamento não carrega o filtro (não tem a tabela).
    expect(sqls.filter((s) => s.includes("ai_budgets"))).toHaveLength(2);
  });
});

describe("a trava de renovação está NO BANCO (item 8)", () => {
  function linhaCifrada() {
    const c = encryptKey(JSON.stringify(tokens));
    return {
      id: credId,
      organization_id: org,
      provider: PROVEDOR_POR_ASSINATURA,
      label: "Assinatura do Codex (ChatGPT)",
      is_active: true,
      validated_at: new Date().toISOString(),
      api_key_encrypted: bufToBytea(c.ciphertext),
      api_key_iv: bufToBytea(c.iv),
      api_key_tag: bufToBytea(c.tag),
      updated_at: new Date(Date.now() - 60_000).toISOString(),
    };
  }

  it("dois processos ao mesmo tempo: UM só chama o provedor, o outro espera", async () => {
    const fake = admin();
    fake.linha = linhaCifrada();
    let chamadas = 0;
    const renovar = async (atuais: TokensDoCodex): Promise<TokensDoCodex> => {
      chamadas += 1;
      await new Promise((r) => setTimeout(r, 5));
      return { ...atuais, access_token: "at-rotacionado", refresh_token: "rt-rotacionado" };
    };

    const [a, b] = await Promise.all([
      renovarComTravaDeBanco({ admin: fake as never, orgId: org, credentialId: credId, userId: null, renovar }),
      renovarComTravaDeBanco({ admin: fake as never, orgId: org, credentialId: credId, userId: null, renovar }),
    ]);

    expect(chamadas).toBe(1);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect([a, b].filter((r) => !r.ok && r.motivo === "em_curso")).toHaveLength(1);
    // O vencedor regravou o par na mesma linha.
    const linha = fake.linha!;
    expect(String(linha.api_key_encrypted)).not.toContain("rt-9876543210");
  });

  it("com o módulo desligado, a renovação nem sai do lugar", async () => {
    estado.modulo = false;
    const fake = admin();
    fake.linha = linhaCifrada();
    let chamadas = 0;
    const r = await renovarComTravaDeBanco({
      admin: fake as never,
      orgId: org,
      credentialId: credId,
      userId: null,
      renovar: async (atuais) => {
        chamadas += 1;
        return atuais;
      },
    });
    expect(r).toEqual({ ok: false, motivo: "modulo_desligado" });
    expect(chamadas).toBe(0);
    expect(fake.linha!.updated_at).toBe(new Date(fake.linha!.updated_at as string).toISOString());
  });

  it("a auditoria leva quem pediu; a renovação automática leva null, nunca um texto", async () => {
    // `actor_user_id` é uuid: o "sistema" de antes fazia o registro falhar a
    // cada revalidação, calado, porque a falha de audit não bloqueia.
    for (const userId of [user, null]) {
      vi.mocked(audit).mockClear();
      const fake = admin();
      fake.linha = linhaCifrada();
      const r = await renovarComTravaDeBanco({
        admin: fake as never,
        orgId: org,
        credentialId: credId,
        userId,
        renovar: async (atuais) => ({ ...atuais, access_token: "at-novo" }),
      });
      expect(r.ok).toBe(true);
      expect(vi.mocked(audit).mock.calls.map(([e]) => e.actorUserId)).toEqual([userId]);
    }
  });
});

describe("lerLoginCodex: o módulo desligado cala a leitura", () => {
  function linhaValida() {
    const c = encryptKey(JSON.stringify(tokens));
    return {
      id: credId,
      organization_id: org,
      provider: PROVEDOR_POR_ASSINATURA,
      is_active: true,
      validated_at: new Date().toISOString(),
      api_key_encrypted: bufToBytea(c.ciphertext),
      api_key_iv: bufToBytea(c.iv),
      api_key_tag: bufToBytea(c.tag),
    };
  }

  it("ligado, devolve o par gravado (controle: a linha é legível)", async () => {
    const fake = admin();
    fake.linha = linhaValida();
    expect(await lerLoginCodex({ admin: fake as never, orgId: org })).toEqual(tokens);
  });

  it("desligado, devolve null com a MESMA linha no banco", async () => {
    estado.modulo = false;
    const fake = admin();
    fake.linha = linhaValida();
    expect(await lerLoginCodex({ admin: fake as never, orgId: org })).toBeNull();
  });
});
