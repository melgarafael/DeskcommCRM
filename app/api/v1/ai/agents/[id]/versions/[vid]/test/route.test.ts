/**
 * Runtime real do "Testar agente" (issue #71).
 *
 * O preview usa o mesmo core e as mesmas dependências de um turno normal. Este
 * teste fixa o contrato de falha desse caminho: o run guarda um checkpoint
 * útil e a pessoa recebe orientação legível, sem detalhes internos do provider.
 *
 * #4020 — e a orientação tem de ser a CERTA: o mesmo `catch` respondia
 * "confira modelo, credencial e materiais" para um timeout de banco, e duas
 * instalações recriaram credencial e reindexaram a base por causa disso. Os
 * casos daqui fixam os dois lados (banco fala de banco; provedor/modelo segue
 * com a frase de hoje) e, principalmente, o que NÃO pode ser acusado.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import { testAgentVersion } from "@/lib/agent-engine/agent/sandbox";
import { requestTurnDeps } from "@/lib/agent-engine/agent/request-deps";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { logger } from "@/lib/logger";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
// #2052: a rota deixou de chamar `requireRole` direto e passou pelo
// `resolveAuthDual` (sessão OU Bearer), que chama `createClient()` do servidor
// no ramo de sessão — escopo de request do Next, que este teste isolado não
// tem. O que este arquivo prova é o `/test`, não o auth: o caminho aceito/
// recusado por token está em
// `tests/unit/configuracao-do-agente-por-token-aceita-e-recusa.test.ts`.
vi.mock("@/lib/api/auth-dual", () => ({
  resolveAuthDual: vi.fn(async () => ({
    ok: true,
    organizationId: "22222222-2222-4222-8222-222222222222",
    actor: { type: "user", id: "11111111-1111-4111-8111-111111111111" },
    supabase: {},
    idioma: "pt-BR",
    via: "session",
  })),
  tetoDeEscritaDoToken: vi.fn(async () => null),
}));
vi.mock("@/lib/agent-engine/agent/sandbox", () => ({
  // O erro de cada caso é injetado por teste (`mockRejectedValueOnce`); o
  // default é o de hoje, para o caso-base continuar sendo o mesmo.
  testAgentVersion: vi.fn(),
}));
vi.mock("@/lib/agent-engine/agent/request-deps", () => ({ requestTurnDeps: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn() }));

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "33333333-3333-4333-8333-333333333333";
const VERSION = "44444444-4444-4444-8444-444444444444";

function stubAdmin(atualizacoes: Record<string, unknown>[], selects: string[] = []) {
  return {
    from: (table: string) => {
      if (table === "ai_agent_versions") {
        return {
          select: (colunas: string) => {
            selects.push(colunas);
            return {
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: async () => ({
                      data: {
                        id: VERSION,
                        agent_id: AGENT,
                        organization_id: ORG,
                        system_prompt: "oi",
                        provider: "anthropic",
                        model: "claude-sonnet-4-6",
                        channel_session_id: null,
                        max_steps: 3,
                        token_budget: 1000,
                        cost_budget_cents: 100,
                        tool_ids: [],
                        knowledge_source_ids: ["55555555-5555-4555-8555-555555555555"],
                      },
                      error: null,
                    }),
                  }),
                }),
              }),
            };
          },
        };
      }
      // ai_agent_runs
      return {
        insert: () => ({
          select: () => ({ single: async () => ({ data: { id: "run-1" }, error: null }) }),
        }),
        update: (payload: Record<string, unknown>) => {
          atualizacoes.push(payload);
          const chain = {
            eq: () => chain,
            then: (ok: (value: { error: null }) => unknown) =>
              Promise.resolve({ error: null }).then(ok),
          };
          return chain;
        },
      };
    },
  };
}

describe("POST .../versions/:vid/test — core compartilhado", () => {
  const atualizacoes: Record<string, unknown>[] = [];
  const selectsDeVersao: string[] = [];
  const requestPool = { query: vi.fn() };
  const turnDeps = {};

  beforeEach(() => {
    atualizacoes.length = 0;
    selectsDeVersao.length = 0;
    const user: AuthUser = {
      id: USER,
      email: "a@example.com",
      full_name: null,
      avatar_url: null,
      is_platform_admin: false,
      idioma: "pt-BR" as const,
      organizations: [{ organization_id: ORG, organization_name: "Org", role: "admin" }],
    };
    vi.mocked(requireRole).mockImplementation(async (min: Role) =>
      ROLE_RANK["admin"] >= ROLE_RANK[min]
        ? { ok: true, user, org: { orgId: ORG, name: "Org", role: "admin" } }
        : ({ ok: false, response: null } as never),
    );
    vi.mocked(createAdminClient).mockReturnValue(stubAdmin(atualizacoes, selectsDeVersao) as never);
    vi.mocked(getRequestPool).mockReturnValue(requestPool as never);
    vi.mocked(requestTurnDeps).mockReturnValue(turnDeps as never);
    // O caso-base (erro que não se classifica) continua sendo o de antes.
    vi.mocked(testAgentVersion).mockRejectedValue(new Error("AI_GATEWAY_API_KEY ausente"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sample_tags chega ao motor já normalizado (spec 27, fatia 3)", async () => {
    const { POST } = await import("./route");
    const req = new NextRequest("http://localhost/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sample_message: "oi", sample_tags: [" Estetica ", "estetica", "VIP"] }),
    });

    await POST(req, { params: Promise.resolve({ id: AGENT, vid: VERSION }) });

    expect(testAgentVersion).toHaveBeenCalledWith(
      requestPool,
      turnDeps,
      expect.objectContaining({ sampleTags: ["estetica", "vip"] }),
    );
  });

  it("falha do core vira checkpoint e orientação legível", async () => {
    const { POST } = await import("./route");
    const req = new NextRequest("http://localhost/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sample_message: "oi" }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: AGENT, vid: VERSION }) });
    const body = (await res.json()) as { error?: { code?: string; message?: string } };

    expect(testAgentVersion).toHaveBeenCalledWith(
      requestPool,
      turnDeps,
      expect.objectContaining({
        organizationId: ORG,
        agentId: AGENT,
        versionId: VERSION,
        runId: "run-1",
        sampleMessage: "oi",
      }),
    );
    expect(res.status).toBe(422);
    expect(body.error).toMatchObject({
      code: "preview_failed",
      message: "Não foi possível executar o teste. Confira modelo, credencial e materiais do agente.",
    });
    expect(body.error?.message).not.toContain("AI_GATEWAY_API_KEY");
    // ⚠️ `failed`, não `"error"`. Este teste cobrava `"error"` — e passava,
    // porque o mock do Supabase não tem o CHECK que o Postgres tem. No banco de
    // verdade o update era rejeitado com 23514 e o erro descartado, então o
    // teste verde e a produção quebrada conviviam. O vocabulário da coluna está
    // agora sob `tests/unit/teste-do-agente-usa-status-que-a-coluna-aceita.test.ts`,
    // que lê o CHECK do `baseline.sql` em vez de confiar num mock.
    expect(atualizacoes).toContainEqual(expect.objectContaining({
      status: "failed",
      error_code: "preview_failed",
    }));
  });

  // ─── #4020: a falha é CLASSIFICADA, e a tela diz a causa certa ─────────────
  //
  // A régua dos casos abaixo: banco fala de banco; provedor e modelo seguem com
  // a frase de hoje; o que não se prova não é acusado de nada. As duas frases
  // são diferentes no texto E no código estável, para a tela e o suporte não
  // precisarem adivinhar qual das duas causas aconteceu.

  const FRASE_GENERICA =
    "Não foi possível executar o teste. Confira modelo, credencial e materiais do agente.";

  async function chamarTeste(): Promise<{
    status: number;
    error?: { code?: string; message?: string };
  }> {
    const { POST } = await import("./route");
    const req = new NextRequest("http://localhost/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sample_message: "oi" }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: AGENT, vid: VERSION }) });
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    return { status: res.status, error: body.error };
  }

  function espiarLog() {
    return vi.spyOn(logger, "error").mockImplementation(() => undefined);
  }

  it("banco que não responde fala de banco — e diz que credencial não é a causa", async () => {
    // O erro que a issue mediu em produção: `query_timeout` do `pg` chega SEM
    // `code` (ver `lib/agent-engine/db/pool.test.ts`) — só a mensagem.
    const log = espiarLog();
    vi.mocked(testAgentVersion).mockRejectedValueOnce(new Error("Query read timeout"));

    const { status, error } = await chamarTeste();

    expect(status).toBe(502);
    // O status NÃO pode ser um dos que `lib/api/client.ts` repete sozinho
    // (RETRYABLE_STATUSES): a rota não é idempotente, e cada repetição criaria
    // um run e rodaria o turno inteiro do agente de novo.
    expect([429, 503]).not.toContain(status);
    expect(error?.code).toBe("preview_banco_indisponivel");
    expect(error?.message).toContain("banco de dados não respondeu");
    expect(error?.message).toContain("não têm relação com esta falha");
    expect(error?.message).not.toBe(FRASE_GENERICA);
    // O erro cru NÃO se perde: log com o marcador de sempre e a linha do run.
    expect(log).toHaveBeenCalledWith(
      "[ai.test] o teste do agente falhou",
      expect.objectContaining({ error: "Query read timeout" }),
    );
    expect(atualizacoes).toContainEqual(expect.objectContaining({
      status: "failed",
      error_code: "preview_banco_indisponivel",
      error_message: "Query read timeout",
    }));
  });

  it("statement timeout (SQLSTATE 57014) cai no mesmo desfecho de banco", async () => {
    vi.mocked(testAgentVersion).mockRejectedValueOnce(
      Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }),
    );

    const { status, error } = await chamarTeste();

    expect(status).toBe(502);
    expect(error?.code).toBe("preview_banco_indisponivel");
    expect(atualizacoes).toContainEqual(expect.objectContaining({
      error_code: "preview_banco_indisponivel",
    }));
  });

  // LADO OPOSTO (a): erro do PROVEDOR não vira problema de banco. 401/403/404
  // do provedor são resposta dele, não silêncio do banco — e continuam dizendo
  // o que diziam, porque a orientação (conferir modelo e credencial) está certa.
  it("401 do provedor não vira banco: segue com a frase de modelo e credencial", async () => {
    const log = espiarLog();
    const doProvedor = Object.assign(new Error("401 Unauthorized: invalid api key"), {
      statusCode: 401,
    });
    vi.mocked(testAgentVersion).mockRejectedValueOnce(doProvedor);

    const { status, error } = await chamarTeste();

    expect(status).toBe(422);
    expect(error).toMatchObject({ code: "preview_failed", message: FRASE_GENERICA });
    expect(error?.message).not.toContain("banco");
    expect(log).toHaveBeenCalledWith(
      "[ai.test] o teste do agente falhou",
      expect.objectContaining({ error: "401 Unauthorized: invalid api key" }),
    );
    expect(atualizacoes).toContainEqual(expect.objectContaining({ error_code: "preview_failed" }));
  });

  // LADO OPOSTO (b): modelo inexistente/sem permissão continua com a mensagem
  // certa — é exatamente o caso em que "confira modelo e credencial" ajuda.
  it("modelo não habilitado continua com a mensagem de modelo e credencial", async () => {
    vi.mocked(testAgentVersion).mockRejectedValueOnce(
      Object.assign(
        new Error("modelo não habilitado para a org (enabled_models): claude-inexistente"),
        { name: "llm_model_not_enabled" },
      ),
    );

    const { status, error } = await chamarTeste();

    expect(status).toBe(422);
    expect(error).toMatchObject({ code: "preview_failed", message: FRASE_GENERICA });
    expect(error?.message).not.toContain("banco");
  });

  // LADO OPOSTO (c): exceção desconhecida NÃO ganha causa inventada. Ela
  // continua com a frase genérica — mesma régua de "indefinido não acusa".
  it("exceção desconhecida mantém a frase genérica", async () => {
    vi.mocked(testAgentVersion).mockRejectedValueOnce(
      new TypeError("Cannot read properties of undefined (reading 'candidates')"),
    );

    const { status, error } = await chamarTeste();

    expect(status).toBe(422);
    expect(error).toMatchObject({ code: "preview_failed", message: FRASE_GENERICA });
    expect(error?.message).not.toContain("banco");
  });

  // LADO OPOSTO (e): a mensagem do driver pode trazer host, usuário e SQL. A
  // tela é de quem está na organização: ela recebe a frase, nunca o cru.
  it("mensagem de driver com host e SQL não chega à tela — só ao log", async () => {
    const log = espiarLog();
    const cru =
      "Query read timeout — postgres://crm:segredo@db.interno:5432/crm — select * from ai_agents";
    vi.mocked(testAgentVersion).mockRejectedValueOnce(new Error(cru));

    const { status, error } = await chamarTeste();

    expect(status).toBe(502);
    expect(error?.message).not.toContain("db.interno");
    expect(error?.message).not.toContain("segredo");
    expect(error?.message).not.toContain("select * from ai_agents");
    expect(log).toHaveBeenCalledWith(
      "[ai.test] o teste do agente falhou",
      expect.objectContaining({ error: cru }),
    );
  });

  // #2237 — a config que o Testar usa (prompt, modelo, ferramentas e os
  // materiais de `knowledge_source_ids`) o runtime do preview recarrega por
  // versionId (`loadAgentVersionConfig`). O SELECT desta rota era uma SÉTIMA
  // cópia manual da lista de colunas, fora de
  // `tests/unit/agent-version-columns-drift.test.ts`, e envelheceu sem ninguém
  // ler: faltava `knowledge_source_ids`. A rota lê só o que usa — existência e
  // canal —, então não há cópia para envelhecer. Se alguém voltar a pôr a lista
  // de config aqui, este caso reprova antes de ela divergir de novo.
  it("lê da versão só o que usa — a config vem do runtime, não de uma cópia aqui", async () => {
    const { POST } = await import("./route");
    const req = new NextRequest("http://localhost/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sample_message: "oi" }),
    });

    await POST(req, { params: Promise.resolve({ id: AGENT, vid: VERSION }) });

    expect(selectsDeVersao).toHaveLength(1);
    const colunas = (selectsDeVersao[0] ?? "").split(",").map((c) => c.trim()).sort();
    expect(colunas).toEqual(["channel_session_id", "id"]);
    expect(vi.mocked(testAgentVersion)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ versionId: VERSION }),
    );
  });
});

// Este teste isola o handler; autoridade de suporte é exercitada na suíte própria.
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/impersonate/support")>(),
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => "f2200000-0000-4000-8000-000000000099"),
}));
