/**
 * Wave 5 (spec 15 §7/§9) — rotas de casos humanos.
 *
 * GET /api/v1/ai/cases: filtro por status + org-scope + role gate ≥agent.
 * POST /api/v1/ai/cases/:id/reply: matriz de transição (need_lead_info,
 * escalate), 409 em caso terminal, 404 org-scoped (isolamento).
 *
 * As transições do repositório + enqueueJob + performHumanHandoff rodam sobre
 * pg.Pool (mundo do engine) — aqui mockados como spies; a leitura do caso
 * dentro da rota também roda no pool mockado (stub de `.query()`). O fluxo
 * REAL contra Postgres (job_queue CHECK, RLS, o handler case_reply_turn
 * consumindo o job) fica para o E2E da Wave 6 — não fabricado aqui.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
// As transições devolvem `true` quando realmente mudaram o caso e `false` quando
// a corrida foi perdida (outro atendente respondeu antes) — o default aqui é o
// caminho feliz; os testes de corrida sobrescrevem para `false`.
vi.mock("@/lib/agent-engine/agent/human-cases", () => ({
  resolveCaseFromHuman: vi.fn(async () => true),
  markAwaitingLead: vi.fn(async () => true),
  escalateCase: vi.fn(async () => true),
  buildCaseSummary: vi.fn((row: { title: string }) => `resumo: ${row.title}`),
}));
vi.mock("@/lib/agent-engine/agent/human-handoff", () => ({
  performHumanHandoff: vi.fn(async () => undefined),
}));
vi.mock("@/lib/agent-engine/queue/queue", () => ({
  enqueueJob: vi.fn(async () => ({ job: { id: "job-1" }, deduped: false })),
}));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const CASE_ID = "33333333-3333-4333-8333-333333333333";
const CONV_ID = "44444444-4444-4444-8444-444444444444";
const CONTACT_ID = "55555555-5555-4555-8555-555555555555";

const CASE_BOUNDARY = {
  organization_id: ORG_ID,
  contact_id: CONTACT_ID,
  conversation_id: CONV_ID,
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
  status: "open",
  demanda_fechada_em: null,
};

function session(effectiveRole: Role) {
  const user: AuthUser = {
    id: USER_ID,
    email: "u@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: effectiveRole }],
  };
  vi.mocked(requireRole).mockImplementation(async (min: Role) => {
    if (ROLE_RANK[effectiveRole] >= ROLE_RANK[min]) {
      return { ok: true, user, org: { orgId: ORG_ID, name: "Org", role: effectiveRole } };
    }
    return { ok: false, response: fail("forbidden_role", `Requer role >= ${min}.`, 403, {}) };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// GET /api/v1/ai/cases
// ---------------------------------------------------------------------------

describe("GET /api/v1/ai/cases", () => {
  function makeAdminStub(rows: Array<Record<string, unknown>>) {
    const calls: { eqCalls: Array<[string, unknown]>; inCalls: Array<[string, unknown]> } = {
      eqCalls: [],
      inCalls: [],
    };
    const chain = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        calls.eqCalls.push([col, val]);
        return chain;
      },
      in: (col: string, val: unknown) => {
        calls.inCalls.push([col, val]);
        return chain;
      },
      order: () => Promise.resolve({ data: rows, error: null }),
      then: (onF: (v: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(onF),
    };
    return { from: () => chain, __calls: calls };
  }

  it("viewer é barrado (403 forbidden_role), sem chegar a consultar o banco", async () => {
    session("viewer");
    const admin = makeAdminStub([]);
    vi.mocked(createAdminClient).mockReturnValue(
      admin as unknown as ReturnType<typeof createAdminClient>,
    );
    const { GET } = await import("@/app/api/v1/ai/cases/route");
    const res = await GET(new NextRequest("http://localhost/api/v1/ai/cases?status=open"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden_role");
  });

  it("status=open filtra por organization_id + status abertos", async () => {
    session("agent");
    const rows = [
      {
        id: CASE_ID,
        context_snapshot: { service_boundary: CASE_BOUNDARY },
        title: "Desconto especial",
        summary: "Cliente quer 20%",
        blocker: "Alçada",
        status: "awaiting_human",
        opened_at: "2026-07-23T10:00:00Z",
        conversation_id: CONV_ID,
        conversations: { contacts: { name: "Fulano", phone_number: "+55119" } },
      },
    ];
    const admin = makeAdminStub(rows);
    vi.mocked(createAdminClient).mockReturnValue(
      admin as unknown as ReturnType<typeof createAdminClient>,
    );
    const { GET } = await import("@/app/api/v1/ai/cases/route");
    const res = await GET(new NextRequest("http://localhost/api/v1/ai/cases?status=open"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { cases: Array<{ id: string; contact_name: string | null }>; open_count: number };
    };
    expect(body.data.cases).toHaveLength(1);
    expect(body.data.cases[0]?.contact_name).toBe("Fulano");
    expect(
      admin.__calls.eqCalls.some(([col, val]) => col === "organization_id" && val === ORG_ID),
    ).toBe(true);
    expect(
      admin.__calls.inCalls.some(
        ([col, val]) => col === "status" && Array.isArray(val) && val.includes("awaiting_human"),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/ai/cases/:id
// ---------------------------------------------------------------------------

describe("GET /api/v1/ai/cases/:id", () => {
  /** Duas tabelas na mesma chamada: o caso (maybeSingle) e a timeline (order). */
  function makeDetailStub(caseRow: unknown, events: unknown[]) {
    const eqCalls: Array<[string, unknown]> = [];
    function chainFor(table: string) {
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          eqCalls.push([`${table}.${col}`, val]);
          return chain;
        },
        maybeSingle: () => Promise.resolve({ data: caseRow, error: null }),
        order: () => Promise.resolve({ data: events, error: null }),
      };
      return chain;
    }
    return { from: (table: string) => chainFor(table), __eqCalls: eqCalls };
  }

  it("devolve o caso + timeline, org-scoped pelo authz", async () => {
    session("agent");
    const admin = makeDetailStub(
      {
        id: CASE_ID,
        title: "Liberar acesso",
        summary: "Cliente pagou e não recebeu acesso",
        blocker: "Só o suporte libera",
        status: "awaiting_human",
        source: "agent",
        opened_at: "2026-07-23T10:00:00Z",
        closed_at: null,
        conversation_id: CONV_ID,
        conversations: { contacts: { name: "Maria", phone_number: "+5511" } },
      },
      [
        {
          id: "e1",
          kind: "opened",
          actor_kind: "agent",
          actor_user_id: null,
          human_action: null,
          body: null,
          created_at: "2026-07-23T10:00:00Z",
        },
      ],
    );
    vi.mocked(createAdminClient).mockReturnValue(
      admin as unknown as ReturnType<typeof createAdminClient>,
    );

    const { GET } = await import("@/app/api/v1/ai/cases/[id]/route");
    const res = await GET(new NextRequest(`http://localhost/api/v1/ai/cases/${CASE_ID}`), {
      params: Promise.resolve({ id: CASE_ID }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; contact_name: string | null; events: Array<{ kind: string }> };
    };
    expect(body.data.id).toBe(CASE_ID);
    expect(body.data.contact_name).toBe("Maria");
    expect(body.data.events).toHaveLength(1);
    expect(body.data.events[0]?.kind).toBe("opened");
    // As DUAS tabelas são filtradas pela org do authz — timeline de outra org
    // nunca vaza junto do caso.
    expect(admin.__eqCalls).toContainEqual(["agent_cases.organization_id", ORG_ID]);
    expect(admin.__eqCalls).toContainEqual(["agent_case_events.organization_id", ORG_ID]);
  });

  it("caso de outra org → 404 not_found", async () => {
    session("agent");
    const admin = makeDetailStub(null, []);
    vi.mocked(createAdminClient).mockReturnValue(
      admin as unknown as ReturnType<typeof createAdminClient>,
    );

    const { GET } = await import("@/app/api/v1/ai/cases/[id]/route");
    const res = await GET(new NextRequest(`http://localhost/api/v1/ai/cases/${CASE_ID}`), {
      params: Promise.resolve({ id: CASE_ID }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/ai/cases/:id/reply
// ---------------------------------------------------------------------------

describe("POST /api/v1/ai/cases/:id/reply", () => {
  /**
   * O pool devolve a linha do caso na leitura e um client de transação em
   * `connect()`. O client registra os `begin`/`commit`/`rollback` para os testes
   * poderem afirmar que transição e enqueue caíram no MESMO commit.
   */
  function makePoolStub(caseRow: Record<string, unknown> | undefined) {
    const client = {
      query: vi.fn(async (sql: string) => ({
        rows:
          sql.includes("select conversation_id from agent_cases") && caseRow
            ? [{ conversation_id: caseRow.conversation_id }]
            : [],
      })),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(async (sql: string) => ({
        rows: sql.includes("from conversations c left join demandas")
          ? [CASE_BOUNDARY]
          : caseRow
            ? [caseRow]
            : [],
      })),
      connect: vi.fn(async () => client),
      __client: client,
    };
    return pool;
  }

  function txCommands(client: { query: ReturnType<typeof vi.fn> }): string[] {
    return client.query.mock.calls.map(([sql]) => String(sql));
  }

  function caseRowFixture(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      status: "awaiting_human",
      context_snapshot: { service_boundary: CASE_BOUNDARY },
      title: "Desconto especial",
      summary: "Cliente quer 20%",
      blocker: "Alçada",
      conversation_id: CONV_ID,
      contact_id: CONTACT_ID,
      ...overrides,
    };
  }

  function replyReq(body: Record<string, unknown>) {
    return new NextRequest(`http://localhost/api/v1/ai/cases/${CASE_ID}/reply`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  it("need_lead_info: transiciona awaiting_human->awaiting_lead, enfileira case_reply_turn, audita", async () => {
    session("agent");
    const pool = makePoolStub(caseRowFixture());
    vi.mocked(getRequestPool).mockReturnValue(pool as unknown as ReturnType<typeof getRequestPool>);
    const { markAwaitingLead } = await import("@/lib/agent-engine/agent/human-cases");
    const { enqueueJob } = await import("@/lib/agent-engine/queue/queue");

    const { POST } = await import("@/app/api/v1/ai/cases/[id]/reply/route");
    const res = await POST(replyReq({ action: "need_lead_info", body: "Qual o CPF do cliente?" }), {
      params: Promise.resolve({ id: CASE_ID }),
    });

    expect(res.status).toBe(200);
    const resBody = (await res.json()) as { data: { status: string } };
    expect(resBody.data.status).toBe("awaiting_lead");

    // Transição e enqueue recebem o MESMO client da transação — é o que garante
    // que os dois efeitos entrem no mesmo commit.
    expect(vi.mocked(markAwaitingLead)).toHaveBeenCalledWith(
      pool.__client,
      ORG_ID,
      CASE_ID,
      USER_ID,
      "Qual o CPF do cliente?",
    );
    expect(vi.mocked(enqueueJob)).toHaveBeenCalledWith(
      pool.__client,
      ORG_ID,
      expect.objectContaining({
        kind: "case_reply_turn",
        leadId: CONTACT_ID,
        payload: expect.objectContaining({ case_id: CASE_ID, action: "need_lead_info" }),
      }),
    );
    expect(txCommands(pool.__client)).toEqual(["begin", "commit"]);
    expect(
      vi
        .mocked(audit)
        .mock.calls.some(
          ([e]) => e.action === "ai.case_replied" && e.metadata?.case_action === "need_lead_info",
        ),
    ).toBe(true);
  });

  it("escalate: chama escalateCase + performHumanHandoff com ids resolvidos do caso", async () => {
    session("agent");
    const pool = makePoolStub(caseRowFixture());
    vi.mocked(getRequestPool).mockReturnValue(pool as unknown as ReturnType<typeof getRequestPool>);
    const { escalateCase, buildCaseSummary } = await import("@/lib/agent-engine/agent/human-cases");
    const { performHumanHandoff } = await import("@/lib/agent-engine/agent/human-handoff");

    const { POST } = await import("@/app/api/v1/ai/cases/[id]/reply/route");
    const res = await POST(
      replyReq({ action: "escalate", body: "Fora do playbook, precisa de humano" }),
      {
        params: Promise.resolve({ id: CASE_ID }),
      },
    );

    expect(res.status).toBe(200);
    const resBody = (await res.json()) as { data: { status: string } };
    expect(resBody.data.status).toBe("escalated");

    expect(vi.mocked(escalateCase)).toHaveBeenCalledWith(
      pool,
      ORG_ID,
      CASE_ID,
      USER_ID,
      "Fora do playbook, precisa de humano",
    );
    expect(vi.mocked(buildCaseSummary)).toHaveBeenCalled();
    expect(vi.mocked(performHumanHandoff)).toHaveBeenCalledWith(
      pool,
      { tenantId: ORG_ID, leadId: CONTACT_ID, conversationId: CONV_ID },
      expect.objectContaining({ reason: "Fora do playbook, precisa de humano" }),
    );
    // O handoff (idempotente) vem ANTES de fechar o caso: se ele falhar, o caso
    // segue awaiting_human e a retentativa se cura. Na ordem inversa sobraria um
    // caso `escalated` que nunca chegou a um humano.
    const handoffOrder = vi.mocked(performHumanHandoff).mock.invocationCallOrder[0] ?? 0;
    const escalateOrder = vi.mocked(escalateCase).mock.invocationCallOrder[0] ?? 0;
    expect(handoffOrder).toBeLessThan(escalateOrder);
  });

  it("escalate de caso antigo registra resposta e aviso, sem handoff no atendimento novo", async () => {
    session("agent");
    const pool = makePoolStub(
      caseRowFixture({
        context_snapshot: { service_boundary: { ...CASE_BOUNDARY, service_revision: 0 } },
      }),
    );
    vi.mocked(getRequestPool).mockReturnValue(pool as unknown as ReturnType<typeof getRequestPool>);
    const { POST } = await import("@/app/api/v1/ai/cases/[id]/reply/route");
    const { performHumanHandoff } = await import("@/lib/agent-engine/agent/human-handoff");
    const { resolveCaseFromHuman } = await import("@/lib/agent-engine/agent/human-cases");
    const response = await POST(replyReq({ action: "escalate", body: "Resposta humana antiga" }), {
      params: Promise.resolve({ id: CASE_ID }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).data.delivery).toBe("service_stale");
    expect(performHumanHandoff).not.toHaveBeenCalled();
    expect(resolveCaseFromHuman).toHaveBeenCalled();
    expect(
      pool.__client.query.mock.calls.some(([sql]) => sql.includes("insert into agent_inbox_items")),
    ).toBe(true);
    expect(txCommands(pool.__client)).toContain("commit");
  });
  it("aviso de caso stale falha: rollback preserva retry e audit só ocorre após commit", async () => {
    session("agent");
    const pool = makePoolStub(
      caseRowFixture({
        context_snapshot: { service_boundary: { ...CASE_BOUNDARY, service_revision: 0 } },
      }),
    );
    vi.mocked(getRequestPool).mockReturnValue(pool as unknown as ReturnType<typeof getRequestPool>);
    const original = pool.__client.query.getMockImplementation()!;
    let failNotice = true;
    pool.__client.query.mockImplementation(async (sql: string) => {
      if (sql.includes("insert into agent_inbox_items") && failNotice)
        throw new Error("notice unavailable");
      return original(sql);
    });
    const { POST } = await import("@/app/api/v1/ai/cases/[id]/reply/route");
    const { audit } = await import("@/lib/audit");
    const request = () =>
      POST(replyReq({ action: "escalate", body: "Resposta preservada" }), {
        params: Promise.resolve({ id: CASE_ID }),
      });
    await expect(request()).rejects.toThrow("notice unavailable");
    expect(txCommands(pool.__client)).toContain("rollback");
    expect(txCommands(pool.__client)).not.toContain("commit");
    expect(audit).not.toHaveBeenCalled();
    failNotice = false;
    expect((await request()).status).toBe(200);
    expect(txCommands(pool.__client)).toContain("commit");
    expect(audit).toHaveBeenCalledOnce();
  });
  it("need_lead_info: enqueue falhando dá rollback — o caso NÃO sai de awaiting_human", async () => {
    session("agent");
    const pool = makePoolStub(caseRowFixture());
    vi.mocked(getRequestPool).mockReturnValue(pool as unknown as ReturnType<typeof getRequestPool>);
    const { enqueueJob } = await import("@/lib/agent-engine/queue/queue");
    vi.mocked(enqueueJob).mockRejectedValueOnce(new Error("job_queue indisponível"));

    const { POST } = await import("@/app/api/v1/ai/cases/[id]/reply/route");
    await expect(
      POST(replyReq({ action: "need_lead_info", body: "Qual o CPF?" }), {
        params: Promise.resolve({ id: CASE_ID }),
      }),
    ).rejects.toThrow("job_queue indisponível");

    // Sem o rollback, a transição ficaria commitada sem job: o lead nunca seria
    // avisado e a rota passaria a responder 409 para sempre.
    expect(txCommands(pool.__client)).toEqual(["begin", "rollback"]);
    expect(pool.__client.release).toHaveBeenCalled();
  });

  it("corrida perdida (transição não casou) → 409 e nada é enfileirado", async () => {
    session("agent");
    const pool = makePoolStub(caseRowFixture());
    vi.mocked(getRequestPool).mockReturnValue(pool as unknown as ReturnType<typeof getRequestPool>);
    const { resolveCaseFromHuman } = await import("@/lib/agent-engine/agent/human-cases");
    const { enqueueJob } = await import("@/lib/agent-engine/queue/queue");
    // Outro atendente respondeu entre a leitura e o update.
    vi.mocked(resolveCaseFromHuman).mockResolvedValueOnce(false);

    const { POST } = await import("@/app/api/v1/ai/cases/[id]/reply/route");
    const res = await POST(replyReq({ action: "resolved", body: "Liberei o acesso" }), {
      params: Promise.resolve({ id: CASE_ID }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_state");
    expect(vi.mocked(enqueueJob)).not.toHaveBeenCalled();
    expect(txCommands(pool.__client)).toEqual(["begin", "rollback"]);
  });

  it("caso terminal (resolved) → 409 invalid_state, sem transição/enqueue/handoff", async () => {
    session("agent");
    const pool = makePoolStub(caseRowFixture({ status: "resolved" }));
    vi.mocked(getRequestPool).mockReturnValue(pool as unknown as ReturnType<typeof getRequestPool>);
    const { resolveCaseFromHuman } = await import("@/lib/agent-engine/agent/human-cases");
    const { enqueueJob } = await import("@/lib/agent-engine/queue/queue");

    const { POST } = await import("@/app/api/v1/ai/cases/[id]/reply/route");
    const res = await POST(replyReq({ action: "resolved", body: "Já resolvido antes" }), {
      params: Promise.resolve({ id: CASE_ID }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_state");
    expect(vi.mocked(resolveCaseFromHuman)).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueJob)).not.toHaveBeenCalled();
  });

  it("caso de outra org → 404 (org resolvida via authz, nunca do body/path)", async () => {
    session("agent");
    // A leitura do caso é org-scoped: para uma org sem esse caso, o SELECT
    // (WHERE organization_id = $1 AND id = $2) não retorna linha — mesmo
    // efeito de o caso pertencer a OTHER_ORG_ID.
    const pool = makePoolStub(undefined);
    vi.mocked(getRequestPool).mockReturnValue(pool as unknown as ReturnType<typeof getRequestPool>);

    const { POST } = await import("@/app/api/v1/ai/cases/[id]/reply/route");
    const res = await POST(replyReq({ action: "resolved", body: "tentando de outra org" }), {
      params: Promise.resolve({ id: CASE_ID }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
    // Prova que a query foi org-scoped pelo org do authz (ORG_ID), não OTHER_ORG_ID.
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), [ORG_ID, CASE_ID]);
  });
});

// Este teste isola o handler; autoridade de suporte é exercitada na suíte própria.
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/impersonate/support")>()),
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => "f2200000-0000-4000-8000-000000000099"),
}));
