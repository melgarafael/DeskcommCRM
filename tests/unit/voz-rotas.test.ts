/**
 * AS ROTAS DA VOZ (IA › Provedores › Voz e áudio) e a guarda no agente.
 *
 * Banco falso em memória que FILTRA de verdade (duas organizações), cifra real
 * (AES-GCM com chave de teste) e Google falso no `fetch` global. O que se prende:
 *
 *   - a chave entra cifrada e NUNCA volta: nem na resposta, nem na auditoria,
 *     nem no console; a tela vê `••••` + 4 últimos;
 *   - substituir exige a chave inteira (máscara ou pedaço é 422) e troca na
 *     MESMA linha; remover apaga só a da organização da sessão;
 *   - RBAC: ler é manager+, gravar/testar/remover/amostra é admin;
 *   - teste e erros devolvem só código; a amostra recusa voz arbitrária ANTES
 *     de chamar o Google e sintetiza só a frase fixa;
 *   - ligar a resposta em áudio no agente sem chave utilizável é 422.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.AI_CRED_AES_KEY = "iBc1Z2gYaAH4rEHs1dHQ2dvNQ6t4OfrdE1/Y6OSvtZY=";
});

const deps = vi.hoisted(() => ({
  role: vi.fn(),
  support: vi.fn(),
  audit: vi.fn(),
  admin: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/impersonate/support")>()),
  requireSupportWrite: deps.support,
}));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: deps.admin }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { NextRequest } from "next/server";

import { DELETE, GET, PUT } from "@/app/api/v1/ai/voz/route";
import { POST as TESTAR } from "@/app/api/v1/ai/voz/testar/route";
import { GET as VOZES } from "@/app/api/v1/ai/voz/vozes/route";
import { POST as AMOSTRA } from "@/app/api/v1/ai/voz/amostra/route";
import { PATCH as PATCH_DO_AGENTE } from "@/app/api/v1/ai/agents/[id]/route";
import { FRASE_DA_AMOSTRA } from "@/lib/agent-engine/edge/voz/vozes";
import { lerChaveDaVoz } from "@/lib/ai/voz/credencial";
import { PROVEDOR_DA_VOZ } from "@/lib/ai/pontos/provedores";
import { env } from "@/lib/env";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const EU = "33333333-3333-4333-8333-333333333333";
const AGENTE_A = "55555555-5555-4555-8555-555555555555";
const CHAVE_1 = "AIzaSyFAKE_primeira-chave-de-voz-0001wxyz";
const CHAVE_2 = "AIzaSyFAKE_segunda-chave-de-voz-00002abc";
const CHAVE_B = "AIzaSyFAKE_chave-da-outra-empresa-9999bbbb";
const SEGREDOS = [CHAVE_1, CHAVE_2, CHAVE_B];

// ─── banco falso ────────────────────────────────────────────────────────────

type Linha = Record<string, unknown>;
const CIFRADAS = ["api_key_encrypted", "api_key_iv", "api_key_tag"];

function bancoFalso() {
  const tabelas: Record<string, Linha[]> = { ai_provider_credentials: [], ai_agents: [] };
  let seq = 0;
  let relogio = Date.parse("2026-10-28T10:00:00Z");
  const agora = () => new Date((relogio += 1000)).toISOString();

  function from(nome: string) {
    const vista = nome === "ai_provider_credentials_safe";
    const tabela = tabelas[vista ? "ai_provider_credentials" : nome] ?? (tabelas[nome] = []);
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: Linha = {};
    let colunas: string | null = null;
    let limite: number | null = null;
    let ordem: { col: string; asc: boolean } | null = null;
    const filtros: [string, unknown][] = [];

    const executar = (): { data: Linha[]; error: { code?: string; message: string } | null } => {
      if (op === "insert") {
        const dup = tabela.some(
          (r) =>
            r.organization_id === payload.organization_id && r.provider === payload.provider && r.label === payload.label,
        );
        if (dup) return { data: [], error: { code: "23505", message: "duplicate" } };
        const nova: Linha = {
          id: `cred-${++seq}`,
          validated_at: null,
          validation_error: null,
          models_available: null,
          created_at: agora(),
          updated_at: agora(),
          ...payload,
        };
        tabela.push(nova);
        return { data: [projetar(nova)], error: null };
      }
      let alvo = tabela.filter((r) => filtros.every(([c, v]) => r[c] === v));
      if (op === "update") for (const r of alvo) Object.assign(r, payload, { updated_at: agora() });
      if (op === "delete") for (const r of alvo) tabela.splice(tabela.indexOf(r), 1);
      if (ordem) {
        const { col, asc } = ordem;
        alvo = [...alvo].sort((a, b) => String(a[col]).localeCompare(String(b[col])) * (asc ? 1 : -1));
      }
      if (limite !== null) alvo = alvo.slice(0, limite);
      return { data: alvo.map(projetar), error: null };
    };
    const projetar = (r: Linha): Linha => {
      let saida: Linha = { ...r };
      if (vista) for (const c of CIFRADAS) delete saida[c];
      if (colunas && colunas !== "*") {
        const so = colunas.split(",").map((c) => c.trim());
        saida = Object.fromEntries(so.filter((c) => c in saida).map((c) => [c, saida[c]]));
      }
      return saida;
    };

    const q = {
      select(c?: string) {
        colunas = c ?? "*";
        return q;
      },
      eq(c: string, v: unknown) {
        filtros.push([c, v]);
        return q;
      },
      is(c: string, v: unknown) {
        filtros.push([c, v]);
        return q;
      },
      order(col: string, o?: { ascending?: boolean }) {
        ordem = { col, asc: o?.ascending !== false };
        return q;
      },
      limit(n: number) {
        limite = n;
        return q;
      },
      insert(p: Linha) {
        op = "insert";
        payload = p;
        return q;
      },
      update(p: Linha) {
        op = "update";
        payload = p;
        return q;
      },
      delete() {
        op = "delete";
        return q;
      },
      async maybeSingle() {
        const r = executar();
        return { data: r.data[0] ?? null, error: r.error };
      },
      async single() {
        const r = executar();
        return r.data[0] ? { data: r.data[0], error: null } : { data: null, error: r.error ?? { message: "nada" } };
      },
      then(ok: (r: unknown) => unknown, falha?: (e: unknown) => unknown) {
        return Promise.resolve(executar()).then(ok, falha);
      },
    };
    return q;
  }
  return { tabelas, admin: { from } };
}

// ─── Google falso ───────────────────────────────────────────────────────────

const LISTA = {
  voices: [
    { languageCodes: ["pt-BR"], name: "pt-BR-Wavenet-B", ssmlGender: "MALE" },
    { languageCodes: ["pt-BR"], name: "pt-BR-Standard-A", ssmlGender: "FEMALE" },
    { languageCodes: ["pt-BR"], name: "pt-BR-Chirp3-HD-Achernar", ssmlGender: "FEMALE" },
  ],
};

let googleStatus = 200;
const chamadasAoGoogle: { url: string; metodo: string; headers: Record<string, string>; corpo: unknown }[] = [];
const googleFalso = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  const corpo = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;
  chamadasAoGoogle.push({
    url: String(url),
    metodo: init?.method ?? "GET",
    headers: { ...(init?.headers as Record<string, string>) },
    corpo,
  });
  if (googleStatus !== 200) {
    return new Response(JSON.stringify({ error: { message: "API key not valid", status: "PERMISSION_DENIED" } }), {
      status: googleStatus,
    });
  }
  if (String(url).endsWith("text:synthesize")) {
    return new Response(JSON.stringify({ audioContent: Buffer.from("OggS-amostra").toString("base64") }));
  }
  return new Response(JSON.stringify(LISTA));
});

// ─── ambiente de cada caso ──────────────────────────────────────────────────

let banco: ReturnType<typeof bancoFalso>;
const respostas: string[] = [];
let espioes: ReturnType<typeof vi.spyOn>[] = [];

function sessao(orgId: string, papel: "admin" | "manager" | "agent" = "admin") {
  deps.role.mockImplementation(async (minimo: string) => {
    const rank = { viewer: 1, agent: 2, manager: 3, admin: 4 } as Record<string, number>;
    if ((rank[papel] ?? 0) < (rank[minimo] ?? 9)) {
      return { ok: false, response: Response.json({ error: { code: "forbidden" } }, { status: 403 }) };
    }
    return { ok: true, user: { id: EU, idioma: "pt-BR" }, org: { orgId, role: papel } };
  });
}

async function corpo(res: Response): Promise<{ status: number; json: Record<string, unknown> }> {
  const texto = await res.clone().text();
  respostas.push(texto);
  return { status: res.status, json: JSON.parse(texto || "{}") as Record<string, unknown> };
}
const dados = (j: Record<string, unknown>) => j.data as Record<string, unknown>;

const put = (api_key: unknown) =>
  PUT(
    new NextRequest("http://localhost/api/v1/ai/voz", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key }),
    }),
  );
const amostra = (voz: unknown) =>
  AMOSTRA(
    new NextRequest("http://localhost/api/v1/ai/voz/amostra", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ voz }),
    }),
  );

/** Deixa a validação em segundo plano (fire-and-forget do miolo comum) terminar. */
const esperarSegundoPlano = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  vi.clearAllMocks();
  banco = bancoFalso();
  deps.admin.mockImplementation(() => banco.admin);
  deps.support.mockResolvedValue(null);
  deps.audit.mockResolvedValue(undefined);
  googleStatus = 200;
  chamadasAoGoogle.length = 0;
  respostas.length = 0;
  vi.stubGlobal("fetch", googleFalso);
  env.GOOGLE_TTS_API_KEY = "";
  env.GOOGLE_TTS_VOICE = "";
  sessao(ORG_A);
  espioes = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
});

afterEach(() => {
  // Nada que saiu desta suíte — respostas, auditoria, console, URLs ao Google — leva uma chave.
  const tudo = JSON.stringify({
    respostas,
    auditoria: deps.audit.mock.calls,
    console: espioes.map((e) => e.mock.calls),
    urls: chamadasAoGoogle.map((c) => c.url),
  });
  for (const s of SEGREDOS) expect(tudo).not.toContain(s);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── casos ──────────────────────────────────────────────────────────────────

describe("gravar, mascarar, substituir e remover", () => {
  it("sem chave: não configurada e nada em uso", async () => {
    const r = await corpo(await GET());
    expect(r.status).toBe(200);
    expect(dados(r.json)).toMatchObject({ configurada: false, mascara: null, em_uso: null });
  });

  it("grava cifrada, devolve só a máscara, audita sem a chave e valida em segundo plano", async () => {
    const r = await corpo(await put(CHAVE_1));
    expect(r.status).toBe(200);
    expect(dados(r.json)).toMatchObject({ configurada: true, mascara: "••••wxyz" });

    const linhas = banco.tabelas.ai_provider_credentials!;
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({ organization_id: ORG_A, provider: PROVEDOR_DA_VOZ, api_key_last4: "wxyz" });
    expect(JSON.stringify(linhas[0])).not.toContain(CHAVE_1);
    expect(String(linhas[0]!.api_key_encrypted)).toMatch(/^\\x[0-9a-f]+$/);

    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai.credential_created",
        organizationId: ORG_A,
        metadata: expect.objectContaining({ provider: PROVEDOR_DA_VOZ, last4: "wxyz" }),
      }),
    );

    await esperarSegundoPlano();
    const depois = dados((await corpo(await GET())).json);
    expect(depois).toMatchObject({ validada: true, erro: null, em_uso: "organizacao" });
    // O Google recebeu a chave no cabeçalho, nunca na URL.
    expect(chamadasAoGoogle[0]?.headers["x-goog-api-key"]).toBe(CHAVE_1);
  });

  it("substituir exige a chave inteira e troca na MESMA linha", async () => {
    await put(CHAVE_1);
    await esperarSegundoPlano();
    const id = banco.tabelas.ai_provider_credentials![0]!.id;

    for (const ruim of ["••••wxyz", "wxyz", "", "AIza curta", `${CHAVE_2}\n`.repeat(10)]) {
      const r = await corpo(await put(ruim));
      expect(r.status).toBe(422);
      expect(JSON.stringify(r.json)).not.toContain("details");
    }
    expect(await lerChaveDaVoz(banco.admin as never, ORG_A)).toEqual({ chave: CHAVE_1, origem: "organizacao" });

    const r = await corpo(await put(CHAVE_2));
    expect(r.status).toBe(200);
    expect(dados(r.json)).toMatchObject({ mascara: "••••2abc", validada: false });
    expect(banco.tabelas.ai_provider_credentials).toHaveLength(1);
    expect(banco.tabelas.ai_provider_credentials![0]!.id).toBe(id);
    expect(await lerChaveDaVoz(banco.admin as never, ORG_A)).toEqual({ chave: CHAVE_2, origem: "organizacao" });
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai.credential_updated",
        metadata: expect.objectContaining({ last4: "2abc", trocou_chave: true }),
      }),
    );
  });

  it("remover apaga só a chave da organização da sessão e audita com os 4 últimos", async () => {
    await put(CHAVE_1);
    sessao(ORG_B);
    await put(CHAVE_B);
    sessao(ORG_A);

    const r = await corpo(await DELETE());
    expect(r.status).toBe(200);
    expect(dados(r.json)).toMatchObject({ configurada: false, removida: true });
    expect(banco.tabelas.ai_provider_credentials!.map((l) => l.organization_id)).toEqual([ORG_B]);
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai.credential_deleted",
        organizationId: ORG_A,
        metadata: expect.objectContaining({ provider: PROVEDOR_DA_VOZ, last4: "wxyz" }),
      }),
    );
  });
});

describe("isolamento entre organizações", () => {
  it("a chave da B não aparece, não é testada e não libera nada na A", async () => {
    sessao(ORG_B);
    await put(CHAVE_B);
    await esperarSegundoPlano();
    sessao(ORG_A);

    expect(dados((await corpo(await GET())).json)).toMatchObject({ configurada: false, em_uso: null });
    expect((await corpo(await TESTAR())).status).toBe(422);
    expect((await corpo(await VOZES())).status).toBe(409);
    expect((await corpo(await amostra("pt-BR-Standard-A"))).status).toBe(409);
    expect(await lerChaveDaVoz(banco.admin as never, ORG_A)).toBeNull();
    // Nenhuma chamada da A ao Google saiu com a chave da B (a validação da B é dela).
    const daA = chamadasAoGoogle.slice(1);
    expect(daA).toHaveLength(0);
  });
});

describe("RBAC", () => {
  it("manager lê o estado e as vozes; não grava, não testa, não remove, não gera amostra", async () => {
    await put(CHAVE_1);
    await esperarSegundoPlano();
    sessao(ORG_A, "manager");
    expect((await corpo(await GET())).status).toBe(200);
    expect((await corpo(await VOZES())).status).toBe(200);
    expect((await corpo(await put(CHAVE_2))).status).toBe(403);
    expect((await corpo(await TESTAR())).status).toBe(403);
    expect((await corpo(await DELETE())).status).toBe(403);
    expect((await corpo(await amostra("pt-BR-Standard-A"))).status).toBe(403);
    expect(await lerChaveDaVoz(banco.admin as never, ORG_A)).toEqual({ chave: CHAVE_1, origem: "organizacao" });
  });

  it("atendente (agent) não lê nem o estado", async () => {
    sessao(ORG_A, "agent");
    expect((await corpo(await GET())).status).toBe(403);
    expect((await corpo(await VOZES())).status).toBe(403);
  });

  it("suporte temporário não grava nem dispara chamada paga", async () => {
    deps.support.mockResolvedValue(Response.json({ error: { code: "support_read_only" } }, { status: 403 }));
    expect((await put(CHAVE_1)).status).toBe(403);
    expect((await amostra("pt-BR-Standard-A")).status).toBe(403);
    expect(banco.tabelas.ai_provider_credentials).toHaveLength(0);
    expect(chamadasAoGoogle).toHaveLength(0);
  });
});

describe("testar, vozes e amostra", () => {
  it("teste ok devolve só a contagem; recusa do Google devolve só o código e grava o veredito", async () => {
    await put(CHAVE_1);
    await esperarSegundoPlano();
    let r = await corpo(await TESTAR());
    expect(dados(r.json)).toEqual({ ok: true, vozes: 1 });

    googleStatus = 403;
    r = await corpo(await TESTAR());
    expect(dados(r.json)).toEqual({ ok: false, erro: "auth_failed_403" });
    expect(r.json).not.toHaveProperty("data.mensagem");
    expect(banco.tabelas.ai_provider_credentials![0]).toMatchObject({
      validated_at: null,
      validation_error: "auth_failed_403",
    });
    expect(dados((await corpo(await GET())).json)).toMatchObject({ validada: false, erro: "auth_failed_403" });
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai.credential_revalidated", metadata: expect.objectContaining({ ok: false }) }),
    );
  });

  it("vozes: só as Standard pt-BR — a WaveNet e a Chirp que o Google devolve não aparecem", async () => {
    await put(CHAVE_1);
    const r = await corpo(await VOZES());
    expect(r.status).toBe(200);
    expect(dados(r.json)).toEqual({
      padrao: "pt-BR-Standard-A",
      origem: "organizacao",
      vozes: [{ nome: "pt-BR-Standard-A", genero: "feminina" }],
    });
  });

  it("vozes e estado usam a chave da INSTALAÇÃO quando a empresa não tem a sua", async () => {
    env.GOOGLE_TTS_API_KEY = CHAVE_2;
    expect(dados((await corpo(await GET())).json)).toMatchObject({ configurada: false, em_uso: "instalacao" });
    const r = await corpo(await VOZES());
    expect(dados(r.json)).toMatchObject({ origem: "instalacao" });
  });

  it("amostra: voz arbitrária é 422 sem chamar o Google; voz fora da lista da chave é 422 sem sintetizar", async () => {
    await put(CHAVE_1);
    await esperarSegundoPlano();
    chamadasAoGoogle.length = 0;

    for (const ruim of ["pt-BR-Wavenet-B", "pt-BR-Neural2-A", "pt-BR-Chirp3-HD-Achernar", "<script>", "", 42, "pt-BR-Standard-A; DROP"]) {
      expect((await corpo(await amostra(ruim))).status).toBe(422);
    }
    expect(chamadasAoGoogle).toHaveLength(0);

    expect((await corpo(await amostra("pt-BR-Standard-Z"))).status).toBe(422);
    expect(chamadasAoGoogle.filter((c) => c.url.endsWith("text:synthesize"))).toHaveLength(0);
  });

  it("amostra: sintetiza SÓ a frase fixa, com a voz validada, e devolve OGG sem cache", async () => {
    await put(CHAVE_1);
    await esperarSegundoPlano();
    const res = await amostra("pt-BR-Standard-A");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/ogg;codecs=opus");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-request-id")).toBeTruthy();
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("OggS-amostra");

    const sintese = chamadasAoGoogle.find((c) => c.url.endsWith("text:synthesize"));
    expect(sintese?.corpo).toMatchObject({
      input: { text: FRASE_DA_AMOSTRA },
      voice: { languageCode: "pt-BR", name: "pt-BR-Standard-A" },
      audioConfig: { audioEncoding: "OGG_OPUS" },
    });
    expect(sintese?.headers["x-goog-api-key"]).toBe(CHAVE_1);
  });

  it("erro do Google na lista vira 502 com código e status, sem a mensagem do Google", async () => {
    await put(CHAVE_1);
    await esperarSegundoPlano();
    googleStatus = 403;
    const r = await corpo(await VOZES());
    expect(r.status).toBe(502);
    expect(r.json).toMatchObject({ error: { code: "voz_indisponivel", details: { codigo: "http", status: 403 } } });
    expect(JSON.stringify(r.json)).not.toContain("API key not valid");
  });
});

describe("agente — ligar a resposta em áudio exige chave utilizável", () => {
  function semearAgente(orgId: string, config: Record<string, unknown> = {}) {
    banco.tabelas.ai_agents!.push({
      id: AGENTE_A,
      organization_id: orgId,
      name: "Atendente",
      description: null,
      model: "anthropic/claude-sonnet-4-6",
      system_prompt: "x",
      is_active: true,
      is_default: true,
      kind: "rag_bot",
      priority: 0,
      published_version_id: null,
      archived_at: null,
      config,
      guardrails: [],
      active_kb_version_id: null,
      created_at: "2026-08-01T10:00:00Z",
      updated_at: "2026-08-01T10:00:00Z",
    });
  }
  const patch = (config: Record<string, unknown>) =>
    PATCH_DO_AGENTE(
      new NextRequest(`http://localhost/api/v1/ai/agents/${AGENTE_A}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config }),
      }),
      { params: Promise.resolve({ id: AGENTE_A }) },
    );
  const configGravada = () => banco.tabelas.ai_agents![0]!.config as Record<string, unknown>;

  it("sem chave nenhuma, ligar é 422 e nada muda; desligar passa", async () => {
    semearAgente(ORG_A, { resposta_em_audio: true });
    const r = await corpo(await patch({ resposta_em_audio: true }));
    expect(r.status).toBe(422);
    expect(r.json).toMatchObject({ error: { code: "voz_nao_configurada" } });
    expect((await corpo(await patch({ resposta_em_audio: false }))).status).toBe(200);
    expect(configGravada()).toMatchObject({ resposta_em_audio: false });
  });

  it("chave da empresa validada libera; a voz escolhida grava só o nome", async () => {
    await put(CHAVE_1);
    await esperarSegundoPlano();
    semearAgente(ORG_A);
    expect((await corpo(await patch({ resposta_em_audio: true, voz_da_resposta_em_audio: "pt-BR-Standard-B" }))).status).toBe(200);
    expect(configGravada()).toMatchObject({ resposta_em_audio: true, voz_da_resposta_em_audio: "pt-BR-Standard-B" });
    expect(JSON.stringify(configGravada())).not.toContain(CHAVE_1);
  });

  it("chave da empresa gravada mas NÃO validada não libera", async () => {
    googleStatus = 403;
    await put(CHAVE_1);
    await esperarSegundoPlano();
    semearAgente(ORG_A);
    expect((await corpo(await patch({ resposta_em_audio: true }))).status).toBe(422);
  });

  it("a chave da instalação libera", async () => {
    env.GOOGLE_TTS_API_KEY = CHAVE_2;
    semearAgente(ORG_A);
    expect((await corpo(await patch({ resposta_em_audio: true }))).status).toBe(200);
  });

  it("a chave validada da OUTRA empresa não libera esta", async () => {
    sessao(ORG_B);
    await put(CHAVE_B);
    await esperarSegundoPlano();
    sessao(ORG_A);
    semearAgente(ORG_A);
    expect((await corpo(await patch({ resposta_em_audio: true }))).status).toBe(422);
  });

  it.each(["pt-BR-Wavenet-B", "pt-BR-Neural2-A", "pt-BR-Chirp3-HD-Achernar"])("voz fora da Standard (%s) é 422 no PATCH", async (voz) => {
    semearAgente(ORG_A);
    const r = await corpo(await patch({ voz_da_resposta_em_audio: voz }));
    expect(r.status).toBe(422);
    expect(configGravada()).not.toHaveProperty("voz_da_resposta_em_audio");
  });
});
