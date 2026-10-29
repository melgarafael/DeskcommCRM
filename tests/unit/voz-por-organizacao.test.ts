/**
 * A VOZ DA RESPOSTA EM ÁUDIO POR ORGANIZAÇÃO — regra, Google e worker.
 *
 *  1. A regra de vozes (`edge/voz/vozes.ts`): SÓ pt-BR Standard — WaveNet, Neural2
 *     e as demais famílias, e qualquer nome arbitrário, são recusados.
 *  2. O Google: a chave vai em cabeçalho, nunca na URL, e nenhum erro carrega a
 *     chave (`listarVozesPtBr`, `validateGoogleTtsKey`).
 *  3. O worker (`resolverVozDoTurno`): a credencial cifrada DA ORGANIZAÇÃO vence o
 *     `.env`; outra organização não enxerga a chave; a voz do agente vence a do
 *     ambiente; voz inválida e chave ilegível caem em texto com o motivo.
 *
 * Google simulado (`fetchImpl`); nenhuma chave real.
 */
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.AI_CRED_AES_KEY = "iBc1Z2gYaAH4rEHs1dHQ2dvNQ6t4OfrdE1/Y6OSvtZY=";
});

import { resolverVozDoTurno } from "@/lib/agent-engine/edge/voz/credencial";
import { ENDPOINT_DAS_VOZES, FalhaDaVoz, listarVozesPtBr } from "@/lib/agent-engine/edge/voz/sintese";
import { ehVozAceita, VOZ_PADRAO, vozesAceitasDaLista } from "@/lib/agent-engine/edge/voz/vozes";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { agentConfigPatchSchema } from "@/lib/ai/guardrails-schema";
import { PROVEDOR_DA_VOZ, IDS_COM_CHAVE } from "@/lib/ai/pontos/provedores";
import { validateGoogleTtsKey, validateProviderKey } from "@/lib/ai/provider-validators";
import { encryptKey } from "@/lib/crypto/aes_gcm";

const CHAVE_A = "AIzaSyFAKE_chave-da-org-a-0123456789abcd";
const CHAVE_B = "AIzaSyFAKE_chave-da-org-b-0123456789wxyz";
const CHAVE_ENV = "AIzaSyFAKE_chave-da-instalacao-000000env";
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

const LISTA_DO_GOOGLE = {
  voices: [
    { languageCodes: ["pt-BR"], name: "pt-BR-Neural2-A", ssmlGender: "FEMALE" },
    { languageCodes: ["pt-BR"], name: "pt-BR-Standard-B", ssmlGender: "MALE" },
    { languageCodes: ["pt-BR"], name: "pt-BR-Chirp3-HD-Achernar", ssmlGender: "FEMALE" },
    { languageCodes: ["pt-BR"], name: "pt-BR-Wavenet-C", ssmlGender: "FEMALE" },
    { languageCodes: ["pt-BR"], name: "pt-BR-Standard-A", ssmlGender: "FEMALE" },
    { languageCodes: ["pt-BR"], name: "pt-BR-Standard-A", ssmlGender: "FEMALE" },
    { languageCodes: ["pt-PT"], name: "pt-PT-Standard-A", ssmlGender: "FEMALE" },
  ],
};

function googleFalso(resposta: { status?: number; corpo?: unknown } = {}) {
  const chamadas: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    chamadas.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } });
    return new Response(JSON.stringify(resposta.corpo ?? LISTA_DO_GOOGLE), { status: resposta.status ?? 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, chamadas };
}

describe("regra de vozes", () => {
  it.each(["pt-BR-Standard-A", "pt-BR-Standard-B", "pt-BR-Standard-Z"])("aceita %s", (v) => {
    expect(ehVozAceita(v)).toBe(true);
  });

  it.each([
    "pt-BR-Wavenet-A",
    "pt-BR-Wavenet-B",
    "pt-BR-Neural2-A",
    "pt-BR-Neural2-C",
    "pt-BR-Chirp3-HD-Achernar",
    "pt-BR-Studio-B",
    "pt-BR-Polyglot-1",
    "pt-br-standard-a",
    "en-US-Standard-A",
    "pt-PT-Standard-A",
    "pt-BR-Standard-",
    "pt-BR-Standard-A ",
    "pt-BR-Standard-A\nX",
    "<script>",
    "",
    null,
  ])("recusa %s", (v) => {
    expect(ehVozAceita(v)).toBe(false);
  });

  it("a lista do Google vira só as Standard pt-BR, sem repetição — WaveNet/Neural2/Chirp somem", () => {
    const vozes = vozesAceitasDaLista(LISTA_DO_GOOGLE);
    expect(vozes).toEqual([
      { nome: "pt-BR-Standard-A", genero: "feminina" },
      { nome: "pt-BR-Standard-B", genero: "masculina" },
    ]);
    expect(vozes.every((v) => /^pt-BR-Standard-[A-Z]$/.test(v.nome))).toBe(true);
    expect(vozesAceitasDaLista(null)).toEqual([]);
  });

  it("a config do agente grava só um nome de voz aceito (ou null)", () => {
    expect(agentConfigPatchSchema.parse({ voz_da_resposta_em_audio: "pt-BR-Standard-C" })).toEqual({
      voz_da_resposta_em_audio: "pt-BR-Standard-C",
    });
    expect(agentConfigPatchSchema.safeParse({ voz_da_resposta_em_audio: "pt-BR-Wavenet-A" }).success).toBe(false);
    expect(agentConfigPatchSchema.safeParse({ voz_da_resposta_em_audio: "pt-BR-Neural2-A" }).success).toBe(false);
    expect(agentConfigPatchSchema.parse({ voz_da_resposta_em_audio: null })).toEqual({ voz_da_resposta_em_audio: null });
    expect(agentConfigPatchSchema.safeParse({ voz_da_resposta_em_audio: "pt-BR-Chirp3-HD-X" }).success).toBe(false);
    expect(agentConfigPatchSchema.safeParse({ voz_da_resposta_em_audio: CHAVE_A }).success).toBe(false);
  });

  it("a voz não é provedor de conversa nem entra no cadastro genérico de chaves", () => {
    expect((IDS_COM_CHAVE as readonly string[]).includes(PROVEDOR_DA_VOZ)).toBe(false);
  });
});

describe("Google — a chave só no cabeçalho, nunca em erro", () => {
  it("lista com a chave em X-Goog-Api-Key e a URL sem chave", async () => {
    const g = googleFalso();
    const vozes = await listarVozesPtBr(CHAVE_A, { fetchImpl: g.fetchImpl });
    expect(vozes).toHaveLength(2);
    expect(g.chamadas[0]?.url).toBe(ENDPOINT_DAS_VOZES);
    expect(g.chamadas[0]?.url).not.toContain(CHAVE_A);
    expect(g.chamadas[0]?.headers["x-goog-api-key"]).toBe(CHAVE_A);
  });

  it("recusa do Google vira código e status, sem a chave", async () => {
    const g = googleFalso({ status: 403, corpo: { error: { message: `API key ${CHAVE_A} not valid` } } });
    const err = await listarVozesPtBr(CHAVE_A, { fetchImpl: g.fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FalhaDaVoz);
    expect((err as FalhaDaVoz).code).toBe("http");
    expect((err as FalhaDaVoz).status).toBe(403);
    expect(JSON.stringify(err)).not.toContain(CHAVE_A);
    expect(String((err as Error).message)).not.toContain(CHAVE_A);
  });

  it("falha de rede não ecoa a requisição", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED ${ENDPOINT_DAS_VOZES} key=${CHAVE_A}`);
    }) as unknown as typeof fetch;
    const err = (await listarVozesPtBr(CHAVE_A, { fetchImpl }).catch((e: unknown) => e)) as FalhaDaVoz;
    expect(err.code).toBe("rede");
    expect(err.message).not.toContain(CHAVE_A);
  });

  it("validateGoogleTtsKey: ok devolve os nomes; 403 é auth_failed_403; o dispatcher conhece google-tts", async () => {
    await expect(validateGoogleTtsKey(CHAVE_A, { fetchImpl: googleFalso().fetchImpl })).resolves.toEqual({
      ok: true,
      models: ["pt-BR-Standard-A", "pt-BR-Standard-B"],
    });
    const r = await validateGoogleTtsKey(CHAVE_A, { fetchImpl: googleFalso({ status: 403 }).fetchImpl });
    expect(r).toEqual({ ok: false, error: "auth_failed_403" });
    await expect(
      validateGoogleTtsKey(CHAVE_A, { fetchImpl: googleFalso({ corpo: { voices: [] } }).fetchImpl }),
    ).resolves.toEqual({ ok: false, error: "sem_vozes_pt_br" });
    // Sem fetch injetado o dispatcher iria à rede: basta que ele NÃO caia no `unknown_provider`.
    const fonte = validateProviderKey.toString();
    expect(fonte).toContain("validateGoogleTtsKey");
  });
});

/** Um `ai_provider_credentials` mínimo, com a cifra de verdade. */
function bancoDoWorker(linhas: { organization_id: string; provider: string; chave: string; validada: boolean }[]) {
  const cifradas = linhas.map((l) => {
    const e = encryptKey(l.chave);
    return {
      ...l,
      api_key_encrypted: `\\x${e.ciphertext.toString("hex")}`,
      api_key_iv: `\\x${e.iv.toString("hex")}`,
      api_key_tag: `\\x${e.tag.toString("hex")}`,
    };
  });
  const consultas: { sql: string; params: unknown[] }[] = [];
  const db = {
    consultas,
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      consultas.push({ sql, params });
      const [org, provider] = params;
      const rows = cifradas
        .filter((l) => l.organization_id === org && l.provider === provider && l.validada)
        .map(({ api_key_encrypted, api_key_iv, api_key_tag }) => ({ api_key_encrypted, api_key_iv, api_key_tag }));
      return { rows, rowCount: rows.length };
    }),
  };
  return db as unknown as Queryable & { consultas: typeof consultas };
}

describe("worker — qual chave e qual voz", () => {
  const banco = () =>
    bancoDoWorker([
      { organization_id: ORG_A, provider: PROVEDOR_DA_VOZ, chave: CHAVE_A, validada: true },
      { organization_id: ORG_B, provider: PROVEDOR_DA_VOZ, chave: CHAVE_B, validada: false },
      // Chave de IA de outra natureza na mesma org: nunca vira chave de voz.
      { organization_id: ORG_B, provider: "google", chave: "AIzaSyFAKE_gemini-nao-e-voz-00000000", validada: true },
    ]);

  it("a credencial da organização vence a da instalação, com a voz do agente", async () => {
    const r = await resolverVozDoTurno({
      db: banco(),
      organizationId: ORG_A,
      vozDoAgente: "pt-BR-Standard-C",
      ambiente: { GOOGLE_TTS_API_KEY: CHAVE_ENV, GOOGLE_TTS_VOICE: "pt-BR-Standard-B" },
    });
    expect(r).toEqual({ ok: true, origem: "organizacao", config: { apiKey: CHAVE_A, voz: "pt-BR-Standard-C" } });
  });

  it("isolamento: a consulta filtra organização e provedor, e a org B não recebe a chave da A", async () => {
    const db = banco();
    const r = await resolverVozDoTurno({ db, organizationId: ORG_B, vozDoAgente: null, ambiente: {} });
    // B só tem chave de voz NÃO validada (e uma do Gemini): nada utilizável.
    expect(r).toEqual({ ok: false, code: "nao_configurada" });
    expect(db.consultas[0]?.params).toEqual([ORG_B, PROVEDOR_DA_VOZ]);
    expect(db.consultas[0]?.sql).toMatch(/organization_id = \$1 and provider = \$2/);
    expect(db.consultas[0]?.sql).toMatch(/is_active and validated_at is not null/);
    expect(JSON.stringify(r)).not.toContain(CHAVE_A);
  });

  it("sem chave da organização, a da instalação é a reserva; sem voz escolhida, a do ambiente", async () => {
    const r = await resolverVozDoTurno({
      db: banco(),
      organizationId: ORG_B,
      vozDoAgente: null,
      ambiente: { GOOGLE_TTS_API_KEY: CHAVE_ENV, GOOGLE_TTS_VOICE: "pt-BR-Standard-B" },
    });
    expect(r).toEqual({ ok: true, origem: "instalacao", config: { apiKey: CHAVE_ENV, voz: "pt-BR-Standard-B" } });
  });

  it("sem voz em lugar nenhum, vale a padrão Standard", async () => {
    const r = await resolverVozDoTurno({ db: banco(), organizationId: ORG_A, vozDoAgente: null, ambiente: {} });
    expect(r).toMatchObject({ ok: true, config: { voz: VOZ_PADRAO } });
  });

  it.each(["pt-BR-Chirp3-HD-Achernar", "pt-BR-Wavenet-C", "pt-BR-Neural2-A"])(
    "voz do agente fora da Standard (%s) = voz_nao_permitida (a resposta sai em texto)",
    async (voz) => {
      const r = await resolverVozDoTurno({ db: banco(), organizationId: ORG_A, vozDoAgente: voz, ambiente: {} });
      expect(r).toEqual({ ok: false, code: "voz_nao_permitida" });
    },
  );

  it("GOOGLE_TTS_VOICE fora da Standard também é recusada no worker", async () => {
    const r = await resolverVozDoTurno({
      db: banco(),
      organizationId: ORG_A,
      vozDoAgente: null,
      ambiente: { GOOGLE_TTS_VOICE: "pt-BR-Wavenet-A" },
    });
    expect(r).toEqual({ ok: false, code: "voz_nao_permitida" });
  });

  it("a voz do agente válida vence uma GOOGLE_TTS_VOICE inválida no ambiente", async () => {
    const r = await resolverVozDoTurno({
      db: banco(),
      organizationId: ORG_B,
      vozDoAgente: "pt-BR-Standard-C",
      ambiente: { GOOGLE_TTS_API_KEY: CHAVE_ENV, GOOGLE_TTS_VOICE: "en-US-Standard-A" },
    });
    expect(r).toMatchObject({ ok: true, origem: "instalacao", config: { voz: "pt-BR-Standard-C" } });
  });

  it("linha que não decifra não cai em silêncio na chave do ambiente", async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [{ api_key_encrypted: "\\x00", api_key_iv: "\\x00", api_key_tag: "\\x00" }],
        rowCount: 1,
      })),
    } as unknown as Queryable;
    const r = await resolverVozDoTurno({
      db,
      organizationId: ORG_A,
      vozDoAgente: null,
      ambiente: { GOOGLE_TTS_API_KEY: CHAVE_ENV },
    });
    expect(r).toEqual({ ok: false, code: "credencial_ilegivel" });
  });

  it("leitura do banco que falha usa a reserva da instalação", async () => {
    const db = { query: vi.fn(async () => Promise.reject(new Error("pool fechado"))) } as unknown as Queryable;
    const r = await resolverVozDoTurno({
      db,
      organizationId: ORG_A,
      vozDoAgente: null,
      ambiente: { GOOGLE_TTS_API_KEY: CHAVE_ENV },
    });
    expect(r).toMatchObject({ ok: true, origem: "instalacao" });
  });
});

describe("worker — o turno resolve a voz da organização e cai em texto quando não dá", () => {
  const log = () => {
    const linhas: unknown[] = [];
    const l = {
      linhas,
      info: vi.fn((...a: unknown[]) => linhas.push(a)),
      warn: vi.fn((...a: unknown[]) => linhas.push(a)),
      error: vi.fn((...a: unknown[]) => linhas.push(a)),
      debug: vi.fn((...a: unknown[]) => linhas.push(a)),
      child: () => l,
    };
    return l;
  };

  it("com a chave da organização, o sintetizador sai pronto e o log não leva a chave", async () => {
    const { vozDaOrganizacao } = await import("@/lib/agent-engine/agent/inbound-turn");
    const { env } = await import("@/lib/env");
    env.GOOGLE_TTS_API_KEY = "";
    const l = log();
    const voz = await vozDaOrganizacao({
      db: bancoDoWorker([{ organization_id: ORG_A, provider: PROVEDOR_DA_VOZ, chave: CHAVE_A, validada: true }]),
      organizationId: ORG_A,
      vozDoAgente: "pt-BR-Standard-B",
      log: l as never,
    });
    expect(voz.sintetizar).not.toBeNull();
    expect(voz.motivo).toBeUndefined();
    expect(JSON.stringify(l.linhas)).toContain("pt-BR-Standard-B");
    expect(JSON.stringify(l.linhas)).not.toContain(CHAVE_A);
  });

  it("sem chave em lugar nenhum: sintetizar nulo com o motivo, e a resposta sai em TEXTO", async () => {
    const { vozDaOrganizacao } = await import("@/lib/agent-engine/agent/inbound-turn");
    const { enviarComoAudio } = await import("@/lib/agent-engine/agent/resposta-em-audio");
    const { env } = await import("@/lib/env");
    env.GOOGLE_TTS_API_KEY = "";
    const l = log();
    const voz = await vozDaOrganizacao({ db: bancoDoWorker([]), organizationId: ORG_B, vozDoAgente: null, log: l as never });
    expect(voz).toMatchObject({ sintetizar: null, motivo: "nao_configurada" });

    const enviarTexto = vi.fn(async (_corpo: string) => ({ kind: "sent", messageId: "m1" }));
    const enviarAudio = vi.fn(async (_caminho: string) => ({ kind: "sent", messageId: "m2" }));
    await enviarComoAudio("Seu processo está em andamento.", {
      sintetizar: voz.sintetizar,
      ...(voz.motivo !== undefined ? { motivoSemVoz: voz.motivo } : {}),
      guardar: voz.guardar,
      caminho: "org/conv/voz.ogg",
      enviarAudio,
      enviarTexto,
      log: l as never,
    });
    expect(enviarTexto).toHaveBeenCalledWith("Seu processo está em andamento.");
    expect(enviarAudio).not.toHaveBeenCalled();
    expect(JSON.stringify(l.linhas)).toContain("nao_configurada");
  });

  it("Google recusando a chave da organização: o turno manda texto, com o status no log e sem a chave", async () => {
    const { enviarComoAudio } = await import("@/lib/agent-engine/agent/resposta-em-audio");
    const { criarSintetizador } = await import("@/lib/agent-engine/edge/voz/sintese");
    const g = googleFalso({ status: 403 });
    const l = log();
    const enviarTexto = vi.fn(async (_corpo: string) => ({ kind: "sent", messageId: "m1" }));
    const enviarAudio = vi.fn(async (_caminho: string) => ({ kind: "sent", messageId: "m2" }));
    await enviarComoAudio("Olá", {
      sintetizar: criarSintetizador({ apiKey: CHAVE_A, voz: VOZ_PADRAO }, { fetchImpl: g.fetchImpl }),
      guardar: vi.fn(async () => undefined),
      caminho: "org/conv/voz.ogg",
      enviarAudio,
      enviarTexto,
      log: l as never,
    });
    expect(enviarTexto).toHaveBeenCalledOnce();
    expect(enviarAudio).not.toHaveBeenCalled();
    expect(JSON.stringify(l.linhas)).toContain("403");
    expect(JSON.stringify(l.linhas)).not.toContain(CHAVE_A);
  });
});
