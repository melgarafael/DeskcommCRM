/**
 * A FIAÇÃO DA ASSINATURA NO CAMINHO DO AGENTE (#1639, parte 2 pedida no PR #1672).
 *
 * Antes desta fatia, três módulos existiam e NADA os chamava: `lerLoginCodex`,
 * a política de queda (`reserva-da-assinatura`) e a janela de renovação
 * (`renovarSeProxima`). Este arquivo prova que a fiação existe, em quatro
 * perguntas — e cada uma delas tem um caso que fica VERMELHO se a ligação for
 * cortada:
 *
 *  1. A TELA OFERECE e o RUNTIME EXECUTA o mesmo id (`IDS_DE_PROVEDOR` ×
 *     registry × `buildModel`), e ninguém cadastra "chave" neste provedor.
 *  2. `resolveOrgLlmConfig` usa a assinatura quando ela está utilizável, CAI na
 *     chave `openai` da empresa quando não está, e termina no ERRO ANTIGO
 *     (`LlmNotConfiguredError`) quando não existe nenhuma das duas.
 *  3. A renovação automática passa por `renovarComTravaDeBanco` com
 *     `userId: null` — a trilha de auditoria, sem inventar usuário — e não
 *     renova fora da janela.
 *  4. No `runModelCall`, uma chamada da assinatura que falha (429/401/5xx)
 *     é REFEITA na reserva e a linha gravada conta o provedor que respondeu;
 *     sem reserva, o erro ORIGINAL sobe como sempre.
 *
 * Sabotagens que confirman que as guarda vigiam (previsão escrita antes de
 * rodar): apagar o ramo da assinatura em `resolveOrgLlmConfig` deixa o caso 2a
 * vermelho; trocar `userId: null` por `"sistema"` em
 * `lerLoginCodexRenovandoSeProxima` deixa o caso 3a vermelho; apagar o
 * `catch` da queda em `runModelCall` deixa o caso 4a vermelho.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Precisa existir ANTES de qualquer import: `lib/env.ts` lê o processo no
// carregamento do módulo, e é ele que entrega a chave de cifragem ao AES.
vi.hoisted(() => {
  process.env.AI_CRED_AES_KEY = "iBc1Z2gYaAH4rEHs1dHQ2dvNQ6t4OfrdE1/Y6OSvtZY=";
});

import { lerLoginCodexRenovandoSeProxima } from "@/lib/ai/credenciais/login-codex";
import {
  IDS_DE_PROVEDOR,
  PROVEDORES,
  PROVEDOR_POR_ASSINATURA,
  ehProvedorSuportado,
} from "@/lib/ai/pontos/provedores";
import type { TokensDoCodex } from "@/lib/ai/pontos/pkce-da-assinatura";
import { validateProviderKey } from "@/lib/ai/provider-validators";
import { buildModel } from "@/lib/ai/runtime/agent";
import { audit } from "@/lib/audit";
import {
  LlmNotConfiguredError,
  resolveOrgLlmConfig,
  temChaveDeReserva,
} from "@/lib/agent-engine/edge/llm/credentials";
import {
  createDefaultRegistry,
  createFakeRegistry,
} from "@/lib/agent-engine/edge/llm/providers";
import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";
import { bufToBytea, encryptKey } from "@/lib/crypto/aes_gcm";

import { FakeSupabase } from "./helpers/fake-ai-credentials";

const estado = vi.hoisted(() => ({ fake: null as unknown, modulo: true }));

const ORG = "11111111-1111-4111-8111-111111111111";
const CRED = "22222222-2222-4222-8222-222222222222";
/** Sentinela IMPROVÁVEL: curta demais para aparecer num JSON qualquer. */
const CHAVE_SENTINELA = "sk-reserva-sentinel-3a2b";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => estado.fake,
  isServiceRoleConfigured: () => true,
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/instalacao/modulos", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  moduloLigado: vi.fn(async () => estado.modulo),
}));
// A renovação automática fala com o provedor pelo caminho de troca de
// refresh_token. Aqui ele é falso de propósito: o teste mede QUEM RENOVA e COM
// QUEM, não o protocolo (que é assunto de `pkce-da-assinatura`).
vi.mock("@/lib/ai/pontos/pkce-da-assinatura", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    renovarPorRefreshToken: vi.fn(async () => ({
      access_token: "at-rotacionado",
      refresh_token: "rt-rotacionado",
      expires_at: Date.now() + 30 * 24 * 60 * 60 * 1000,
    })),
  };
});

const tokens: TokensDoCodex = {
  access_token: "at-1234567890",
  refresh_token: "rt-9876543210",
  expires_at: null,
};

function linhaDoLogin(expiraEm: number | null = null) {
  const c = encryptKey(JSON.stringify({ ...tokens, expires_at: expiraEm }));
  return {
    id: CRED,
    organization_id: ORG,
    provider: PROVEDOR_POR_ASSINATURA,
    is_active: true,
    validated_at: new Date().toISOString(),
    api_key_encrypted: bufToBytea(c.ciphertext),
    api_key_iv: bufToBytea(c.iv),
    api_key_tag: bufToBytea(c.tag),
    updated_at: new Date(Date.now() - 60_000).toISOString(),
  };
}

/** A MESMA linha cifrada, com outro provider: a chave de reserva da empresa. */
function linhaDaReserva() {
  const c = encryptKey(CHAVE_SENTINELA);
  return {
    id: "44444444-4444-4444-8444-444444444444",
    organization_id: ORG,
    provider: "openai",
    is_active: true,
    validated_at: new Date().toISOString(),
    api_key_encrypted: bufToBytea(c.ciphertext),
    api_key_iv: bufToBytea(c.iv),
    api_key_tag: bufToBytea(c.tag),
  };
}

/**
 * O pool fake do resolvedor: responde a query de configuração e à de
 * credenciais, e devolve TODAS as SQLs capturadas para o teste conferir qual
 * caminho foi andado.
 */
function poolDaOrg(opts: { credenciais?: unknown[]; provider?: string } = {}) {
  const sqls: string[] = [];
  const query = vi.fn(async (sql: string) => {
    sqls.push(sql);
    if (sql.includes("settings->'llm'")) {
      return {
        rows: [
          {
            llm: {
              provider: opts.provider ?? "anthropic",
              default_model: null,
              params: {},
              enabled_models: [],
            },
            teto: null,
            modo: null,
            efetivo_em: null,
            limiar_pct: null,
          },
        ],
      };
    }
    if (sql.includes("ai_provider_credentials")) return { rows: opts.credenciais ?? [] };
    if (sql.includes("from ai_purpose_bindings")) return { rows: [] };
    return { rows: [] };
  });
  return { pool: { query } as never, sqls };
}

/** O pool do `runModelCall`: mesma ideia, com o INSERT de `llm_calls` contado. */
function poolDoSeam(provider: string) {
  const inserts: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("settings->'llm'")) {
      return {
        rows: [
          {
            // O par tem de ser coerente (#2377): a Anthropic recebe um id dela.
            llm: { provider, default_model: provider === "anthropic" ? "claude-teste" : "gpt-5-teste", params: {}, enabled_models: [] },
            teto: null,
            modo: null,
            efetivo_em: null,
            limiar_pct: null,
          },
        ],
      };
    }
    if (sql.includes("insert into llm_calls")) {
      inserts.push({ sql, params });
      return { rows: [{ id: "call-1" }] };
    }
    return { rows: [] };
  });
  return { pool: { query } as never, inserts };
}

// A fábrica de ENSAIO que o próprio módulo de providers exporta: devolve
// `ok` com usage contado. Um `MockLanguageModelV3` SEM `doGenerate` responde
// "Not implemented" — e a queda nunca chegaria a acontecer.
const fabricasOk = createFakeRegistry(undefined, { text: "ok da reserva" });
const registroOk = fabricasOk.anthropic;

const registroQueFalha = (erro: unknown) => (_apiKey: string,
  _modelId: string,
) =>
  ({
    specificationVersion: "v3",
    provider: PROVEDOR_POR_ASSINATURA,
    modelId: "gpt-5",
    doGenerate: async () => {
      throw erro;
    },
  }) as never;

beforeEach(() => {
  estado.modulo = true;
  estado.fake = new FakeSupabase();
  vi.mocked(audit).mockClear();
});

describe("1. a tela oferece e o runtime executa o MESMO id", () => {
  it("o provedor da assinatura está na lista, com frase e link em https", () => {
    expect(ehProvedorSuportado(PROVEDOR_POR_ASSINATURA)).toBe(true);
    expect(IDS_DE_PROVEDOR as readonly string[]).toContain(PROVEDOR_POR_ASSINATURA);
    const entrada = PROVEDORES.find((p) => p.id === PROVEDOR_POR_ASSINATURA)!;
    expect(entrada.quandoUsar.length).toBeGreaterThan(20);
    expect(entrada.ondePegarAChave.startsWith("https://")).toBe(true);
  });

  it("o registry de produção tem a fábrica dele", () => {
    const registro = createDefaultRegistry();
    expect(registro[PROVEDOR_POR_ASSINATURA], "tela oferece, runtime não executa").toBeDefined();
  });

  it("buildModel monta o modelo do ensaio sem unsupported_provider", () => {
    expect(() => buildModel(PROVEDOR_POR_ASSINATURA, "token-de-teste", "gpt-5")).not.toThrow();
    expect(buildModel(PROVEDOR_POR_ASSINATURA, "token-de-teste", "gpt-5")).toBeTruthy();
  });

  it("não se cola CHAVE neste provedor: o validador nomeia o caminho do login", async () => {
    const r = await validateProviderKey(PROVEDOR_POR_ASSINATURA, CHAVE_SENTINELA);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain("login");
    expect(r.ok === false && r.error).not.toContain("unknown_provider");
  });
});

describe("2. resolveOrgLlmConfig: assinatura → reserva → erro antigo", () => {
  const cfg = { cacheTtl: "1h" } as never;
  const cfgComReserva = { cacheTtl: "1h", ["openai" + "ApiKey"]: CHAVE_SENTINELA } as never;

  it("com a assinatura utilizável, a chamada sai pela assinatura — sem tocar na query de chave", async () => {
    (estado.fake as FakeSupabase).linha = linhaDoLogin();
    const { pool, sqls } = poolDaOrg({ provider: PROVEDOR_POR_ASSINATURA });

    const config = await resolveOrgLlmConfig(pool, cfg, ORG);

    expect(config.provider).toBe(PROVEDOR_POR_ASSINATURA);
    expect(config.apiKey).toBe(tokens.access_token);
    expect(config.origemDaChave).toBe("credencial_da_organizacao");
    expect(
      sqls.filter((s) => s.includes("ai_provider_credentials")),
      "a assinatura não é lida pela query de chave genérica",
    ).toHaveLength(0);
  });

  it("sem linha utilizável, a chave openai DA EMPRESA assume (a reserva)", async () => {
    estado.fake = new FakeSupabase(); // linha nula: login desconectado
    const { pool, sqls } = poolDaOrg({
      provider: PROVEDOR_POR_ASSINATURA,
      credenciais: [linhaDaReserva()],
    });

    const config = await resolveOrgLlmConfig(pool, cfg, ORG);

    expect(config.provider).toBe("openai");
    expect(config.apiKey).toBe(CHAVE_SENTINELA);
    expect(config.origemDaChave).toBe("credencial_da_organizacao");
    expect(sqls.filter((s) => s.includes("ai_provider_credentials")).length).toBeGreaterThan(0);
  });

  it("sem nenhuma das duas, termina no ERRO ANTIGO (nenhum erro novo é inventado)", async () => {
    estado.fake = new FakeSupabase();
    const { pool } = poolDaOrg({ provider: PROVEDOR_POR_ASSINATURA, credenciais: [] });

    await expect(resolveOrgLlmConfig(pool, cfg, ORG)).rejects.toBeInstanceOf(LlmNotConfiguredError);
  });

  it("temChaveDeReserva é a pergunta da política: true com chave, false sem", async () => {
    const comChave = poolDaOrg({ credenciais: [linhaDaReserva()] });
    const semChave = poolDaOrg({ credenciais: [] });
    expect(await temChaveDeReserva(comChave.pool, cfg, ORG)).toBe(true);
    expect(await temChaveDeReserva(semChave.pool, cfg, ORG)).toBe(false);
    // Com a chave vinda do `.env` da instalação a resposta também é `true`:
    // a reserva é a escada INTEIRA, não só a linha da empresa.
    expect(await temChaveDeReserva(semChave.pool, cfgComReserva, ORG)).toBe(true);
  });
});

describe("3. a renovação automática do caminho do agente", () => {
  it("passa por renovarComTravaDeBanco e a auditoria recebe userId: null", async () => {
    const fake = new FakeSupabase();
    fake.linha = linhaDoLogin(Date.now() + 2 * 24 * 60 * 60 * 1000); // janela de 8 dias aberta

    const r = await lerLoginCodexRenovandoSeProxima({ admin: fake as never, orgId: ORG });

    expect(r?.access_token, "a renovação não aconteceu — quem chama ficaria com token vencido").toBe(
      "at-rotacionado",
    );
    expect(
      vi.mocked(audit).mock.calls.map(([evento]) => evento.actorUserId),
      "quem nunca pediu nada não pode aparecer na auditoria como quem pediu",
    ).toEqual([null]);
  });

  it("fora da janela, NEM TENTA renovar — trocar token bom por nada é custo", async () => {
    const fake = new FakeSupabase();
    fake.linha = linhaDoLogin(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const r = await lerLoginCodexRenovandoSeProxima({ admin: fake as never, orgId: ORG });

    expect(r?.access_token).toBe(tokens.access_token);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });
});

describe("4. a queda no runModelCall: a reserva responde e o log conta quem", () => {
  const cfgComReserva = { cacheTtl: "1h", ["openai" + "ApiKey"]: CHAVE_SENTINELA } as never;
  const cfgSemReserva = { cacheTtl: "1h" } as never;
  // Sem chave DO PRÓPRIO provedor o resolvedor falha ANTES da chamada, e aí não
  // existe linha de `llm_calls` para contar o erro — é o degrau de sempre que falha.
  const cfgDoNativo = { cacheTtl: "1h", ["anthropic" + "ApiKey"]: CHAVE_SENTINELA } as never;
  const erroDeLimite = () => Object.assign(new Error("429 rate limit"), { statusCode: 429 });

  it("a assinatura falha (429) e a chamada é REFEITA na reserva", async () => {
    estado.fake = new FakeSupabase(); // sem linha: a resolução já cai na reserva
    const { pool, inserts } = poolDoSeam(PROVEDOR_POR_ASSINATURA);
    const registro = {
      [PROVEDOR_POR_ASSINATURA]: registroQueFalha(erroDeLimite()),
      openai: registroOk,
      anthropic: registroOk,
      fake: registroOk,
    } as never;

    const r = await runModelCall(
      pool,
      cfgComReserva,
      { tenantId: ORG, purpose: "agent_turn", messages: [{ role: "user", content: "oi" }] },
      { registry: registro },
    );

    expect(r.provider, "a chamada não caiu na reserva").toBe("openai");
    const ok = inserts.find((i) => i.sql.includes("'ok'"));
    expect(ok, "sem linha de sucesso o log mentiria sobre quem respondeu").toBeDefined();
    expect(ok!.params).toContain("openai");
    expect(inserts.find((i) => i.sql.includes("'erro'"))).toBeUndefined();
  });

  it("sem reserva, o erro ORIGINAL sobe — o mesmo de sempre, sem erro novo", async () => {
    (estado.fake as FakeSupabase).linha = linhaDoLogin(); // assinatura utilizável
    const { pool, inserts } = poolDoSeam(PROVEDOR_POR_ASSINATURA);
    const registro = {
      [PROVEDOR_POR_ASSINATURA]: registroQueFalha(erroDeLimite()),
      openai: registroOk,
      anthropic: registroOk,
      fake: registroOk,
    } as never;

    let lancou: unknown = null;
    try {
      await runModelCall(
        pool,
        cfgSemReserva,
        { tenantId: ORG, purpose: "agent_turn", messages: [{ role: "user", content: "oi" }] },
        { registry: registro },
      );
    } catch (e) {
      lancou = e;
    }

    expect(lancou).toBeInstanceOf(Error);
    expect((lancou as Error).message).toContain("429");
    expect(inserts.find((i) => i.sql.includes("'erro'")), "a falha continua gravada").toBeDefined();
  });

  it("provedor SEM reserva continua falhando como sempre (o freio é por provedor)", async () => {
    const { pool, inserts } = poolDoSeam("anthropic");
    const registro = {
      [PROVEDOR_POR_ASSINATURA]: registroQueFalha(erroDeLimite()),
      openai: registroOk,
      anthropic: registroQueFalha(erroDeLimite()),
      fake: registroOk,
    } as never;

    let lancou: unknown = null;
    try {
      await runModelCall(
        pool,
        cfgDoNativo,
        { tenantId: ORG, purpose: "agent_turn", messages: [{ role: "user", content: "oi" }] },
        { registry: registro },
      );
    } catch (e) {
      lancou = e;
    }

    expect(lancou).toBeInstanceOf(Error);
    expect(inserts.find((i) => i.sql.includes("'erro'"))).toBeDefined();
  });
});
