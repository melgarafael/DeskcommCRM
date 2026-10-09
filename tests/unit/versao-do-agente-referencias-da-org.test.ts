/**
 * A VERSÃO DO AGENTE SÓ REFERENCIA CREDENCIAL E CANAL DA PRÓPRIA ORGANIZAÇÃO.
 *
 * `credential_id` e `channel_session_id` têm FK simples no banco: ela confere
 * que a linha existe, não que é da mesma organização da versão. Quem escreve a
 * versão usa o client admin (sem RLS), então a conferência é do código — e mora
 * num ponto só, `validarEscopoDaVersao`, chamado por todo escritor.
 *
 * As duas direções são cobradas: da própria organização passa; de outra é
 * recusado com a MESMA resposta de "não existe".
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
// O PATCH autentica por `resolveAuthDual`; o ramo sessão (sem Bearer) chama
// `requireRole` — mockado acima — e abre o client de cookie, que fora de um
// request do Next lança. Nenhum escritor testado aqui lê por ele.
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/ai/agents/first-publication", () => ({
  publishFirstVersion: vi.fn(async () => ({ published: true })),
}));
vi.mock("@/lib/ai/agents/legacy-notice", () => ({
  recordLegacyNotice: vi.fn(async () => undefined),
  legacyRecoveryCause: () => "pronto",
  legacyRecoveryMessage: () => "",
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ id: USER, email: "u@example.com" })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG, name: "Org", role: "admin" })),
}));

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { publishFirstVersion } from "@/lib/ai/agents/first-publication";
import { mensagemDoEscopo, validarEscopoDaVersao } from "@/lib/ai/agents/escopo";

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const USER = "11111111-1111-4111-8111-111111111111";
const AGENTE = "33333333-3333-4333-8333-333333333333";
const AGENTE_LEGADO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VERSAO = "44444444-4444-4444-8444-444444444444";
const CRED_MINHA = "55555555-5555-4555-8555-555555555555";
const CRED_ALHEIA = "66666666-6666-4666-8666-666666666666";
const CANAL_MEU = "77777777-7777-4777-8777-777777777777";
const CANAL_ALHEIO = "88888888-8888-4888-8888-888888888888";
const INEXISTENTE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Linha = Record<string, unknown>;

/** Banco de mentira: filtra por `eq`/`in` de verdade, como o PostgREST faria. */
function bancoFalso(escritas: Array<{ tabela: string; op: string; valor: Linha }>) {
  const tabelas: Record<string, Linha[]> = {
    ai_provider_credentials: [
      { id: CRED_MINHA, organization_id: ORG },
      { id: CRED_ALHEIA, organization_id: OUTRA_ORG },
    ],
    channel_sessions: [
      { id: CANAL_MEU, organization_id: ORG },
      { id: CANAL_ALHEIO, organization_id: OUTRA_ORG },
    ],
    ai_agents: [
      {
        id: AGENTE_LEGADO,
        organization_id: ORG,
        kind: "rag_bot",
        system_prompt: "x",
        published_version_id: null,
        archived_at: null,
      },
    ],
    ai_agent_versions: [
      { id: VERSAO, organization_id: ORG, agent_id: AGENTE, status: "draft", followup: {} },
    ],
  };
  return {
    from(tabela: string) {
      const filtros: Array<(l: Linha) => boolean> = [];
      let carga: Linha | null = null;
      const linhas = () => (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
        in: (c: string, vs: unknown[]) => (filtros.push((l) => vs.includes(l[c])), q),
        limit: () => q,
        maybeSingle: async () => ({ data: linhas()[0] ?? null, error: null }),
        single: async () =>
          carga && tabela === "ai_agents"
            ? { data: { id: AGENTE }, error: null }
            : { data: { ...(linhas()[0] ?? {}), ...(carga ?? {}) }, error: null },
        update: (v: Linha) => ((carga = v), escritas.push({ tabela, op: "update", valor: v }), q),
        insert: (v: Linha) => ((carga = v), escritas.push({ tabela, op: "insert", valor: v }), q),
        then: (r: (x: unknown) => unknown) => r({ data: carga ? null : linhas(), error: null }),
      };
      return q;
    },
  };
}

const escritas: Array<{ tabela: string; op: string; valor: Linha }> = [];

beforeEach(() => {
  escritas.length = 0;
  vi.mocked(publishFirstVersion).mockClear();
  vi.mocked(createAdminClient).mockReturnValue(bancoFalso(escritas) as never);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG, name: "Org", role: "admin" },
  } as never);
});

describe("validarEscopoDaVersao — referências únicas", () => {
  const db = () => bancoFalso([]) as never;

  it("aceita credencial e canal da própria organização, e null", async () => {
    expect(
      await validarEscopoDaVersao(db(), ORG, {
        credential_id: CRED_MINHA,
        channel_session_id: CANAL_MEU,
      }),
    ).toEqual({ ok: true });
    expect(
      await validarEscopoDaVersao(db(), ORG, { credential_id: null, channel_session_id: null }),
    ).toEqual({ ok: true });
  });

  it("recusa credencial de outra organização com a mesma resposta de inexistente", async () => {
    const alheia = await validarEscopoDaVersao(db(), ORG, { credential_id: CRED_ALHEIA });
    const inexistente = await validarEscopoDaVersao(db(), ORG, { credential_id: INEXISTENTE });
    expect(alheia).toEqual({ ok: false, campo: "credential_id", ausentes: [CRED_ALHEIA] });
    expect(inexistente.ok).toBe(false);
    if (alheia.ok || inexistente.ok) return;
    expect(mensagemDoEscopo(alheia)).toBe(mensagemDoEscopo(inexistente));
  });

  it("recusa canal de outra organização", async () => {
    expect(await validarEscopoDaVersao(db(), ORG, { channel_session_id: CANAL_ALHEIO })).toEqual({
      ok: false,
      campo: "channel_session_id",
      ausentes: [CANAL_ALHEIO],
    });
  });
});

describe("PATCH /ai/agents/:id/versions/:vid", () => {
  async function patch(corpo: Linha) {
    const { PATCH } = await import("@/app/api/v1/ai/agents/[id]/versions/[vid]/route");
    return PATCH(
      new NextRequest("http://localhost/api/v1/ai/agents/x/versions/y", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(corpo),
      }),
      { params: Promise.resolve({ id: AGENTE, vid: VERSAO }) },
    );
  }

  it("grava credencial e canal da própria organização", async () => {
    const r = await patch({ credential_id: CRED_MINHA, channel_session_id: CANAL_MEU });
    expect(r.status).toBe(200);
    expect(escritas).toEqual([
      {
        tabela: "ai_agent_versions",
        op: "update",
        valor: { credential_id: CRED_MINHA, channel_session_id: CANAL_MEU },
      },
    ]);
  });

  it("recusa credencial de outra organização sem gravar nada", async () => {
    const r = await patch({ credential_id: CRED_ALHEIA });
    expect(r.status).toBe(422);
    expect((await r.json()).error.code).toBe("validation_failed");
    expect(escritas).toEqual([]);
  });

  it("recusa canal de outra organização sem gravar nada", async () => {
    const r = await patch({ channel_session_id: CANAL_ALHEIO });
    expect(r.status).toBe(422);
    expect(escritas).toEqual([]);
  });
});

describe("createMcpAgentAction (tela /ai/agents/new)", () => {
  const corpo = (canal: string) => ({
    name: "Recepção",
    version: {
      system_prompt: "Atenda bem.",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      credential_id: null,
      channel_session_id: canal,
    },
  });

  it("recusa canal de outra organização antes de criar o agente", async () => {
    const { createMcpAgentAction } = await import("@/app/app/ai/agents/[id]/_actions");
    const r = await createMcpAgentAction(corpo(CANAL_ALHEIO));
    expect(r).toEqual({
      ok: false,
      error: "validation_failed",
      message: mensagemDoEscopo({ ok: false, campo: "channel_session_id", ausentes: [] }),
    });
    expect(escritas).toEqual([]);
  });

  it("cria com canal da própria organização", async () => {
    const { createMcpAgentAction } = await import("@/app/app/ai/agents/[id]/_actions");
    const r = await createMcpAgentAction(corpo(CANAL_MEU));
    expect(r.ok).toBe(true);
    expect(escritas.map((e) => `${e.tabela}:${e.op}`)).toEqual([
      "ai_agents:insert",
      "ai_agent_versions:insert",
    ]);
  });
});

describe("POST /ai/agents/:id/reconcile (recuperação de agente legado)", () => {
  async function reconciliar(credencial: string) {
    const { POST } = await import("@/app/api/v1/ai/agents/[id]/reconcile/route");
    return POST(
      new NextRequest("http://localhost/api/v1/ai/agents/x/reconcile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channel_id: CANAL_MEU,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          credential_id: credencial,
        }),
      }),
      { params: Promise.resolve({ id: AGENTE_LEGADO }) },
    );
  }

  it("recusa credencial de outra organização sem rascunhar versão", async () => {
    const r = await reconciliar(CRED_ALHEIA);
    expect(r.status).toBe(422);
    expect(publishFirstVersion).not.toHaveBeenCalled();
  });

  it("segue com credencial da própria organização", async () => {
    const r = await reconciliar(CRED_MINHA);
    expect(r.status).toBe(200);
    expect(publishFirstVersion).toHaveBeenCalledOnce();
  });
});
