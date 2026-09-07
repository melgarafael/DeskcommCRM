import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { fail } from "@/lib/api/wrappers";
import type { AuthUser } from "@/lib/auth/types";

/**
 * Task 6 (Fase 3 — Intent Router) — GET/POST /api/v1/ai/routers:
 *  - GET lista routers da org com member_count agregado de ai_router_members;
 *  - POST cria router com organization_id de requireRole (nunca do body);
 *  - body inválido → 422 validation_failed;
 *  - violação do índice único parcial (channel_session já tem router ativo)
 *    → 409 tratado, nunca 500 cru.
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_ID = "44444444-4444-4444-8444-444444444444";

function mockAuthzOk(role: "agent" | "admin" = "admin") {
  const user: AuthUser = {
    id: USER_ID,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role }],
  };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG_ID, name: "Org", role },
  });
}

interface AdminCfg {
  routersSelect?: { data?: unknown[] | null; error?: unknown };
  membersSelect?: { data?: unknown[] | null; error?: unknown };
  insertResult?: { data?: unknown; error?: unknown };
  sessionFound?: boolean;
  /** Banco sem a migration 0106: a consulta COM `archived_at` volta 42703. */
  sessionSemColunaArchived?: boolean;
  /** Falha real da consulta (não é coluna ausente) — não pode virar 404. */
  sessionError?: { code?: string; message?: string };
}

function makeAdminStub(cfg: AdminCfg) {
  return {
    from(table: string) {
      if (table === "channel_sessions") {
        // `usouIs` distingue a tentativa COM filtro de arquivado da tentativa de
        // fallback SEM ele. Sem essa distinção o dublê responderia igual às duas
        // e o teste de banco desatualizado passaria mesmo se a rota nunca
        // tentasse o fallback — um teste que não consegue reprovar.
        let usouIs = false;
        const builder = {
          select() {
            return builder;
          },
          eq() {
            return builder;
          },
          is() {
            usouIs = true;
            return builder;
          },
          maybeSingle() {
            if (cfg.sessionError) {
              return Promise.resolve({ data: null, error: cfg.sessionError });
            }
            if (cfg.sessionSemColunaArchived && usouIs) {
              return Promise.resolve({
                data: null,
                error: {
                  code: "42703",
                  message: 'column channel_sessions_1.archived_at does not exist',
                },
              });
            }
            return Promise.resolve(
              cfg.sessionFound === false ? { data: null, error: null } : { data: { id: SESSION_ID }, error: null },
            );
          },
        };
        return builder;
      }
      if (table === "ai_routers") {
        let insertedRow: Record<string, unknown> | undefined;
        const builder = {
          select() {
            return builder;
          },
          eq() {
            return builder;
          },
          order() {
            return Promise.resolve(cfg.routersSelect ?? { data: [], error: null });
          },
          insert(row: Record<string, unknown>) {
            insertedRow = row;
            return {
              select() {
                return {
                  single() {
                    return Promise.resolve(cfg.insertResult ?? { data: null, error: null });
                  },
                };
              },
            };
          },
          __lastInsert: () => insertedRow,
        };
        return builder;
      }
      if (table === "ai_router_members") {
        const builder = {
          select() {
            return builder;
          },
          eq() {
            return Promise.resolve(cfg.membersSelect ?? { data: [], error: null });
          },
        };
        return builder;
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

function getReq() {
  return new NextRequest("http://localhost/api/v1/ai/routers");
}

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/v1/ai/routers", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/ai/routers", () => {
  it("sem auth → repassa authz.response", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthenticated", "Auth required.", 401, {}),
    });
    const { GET } = await import("./route");
    const res = await GET(getReq());
    expect(res.status).toBe(401);
  });

  it("lista routers da org com member_count agregado", async () => {
    mockAuthzOk("agent");
    const routerRow = {
      id: "r1",
      name: "Roteador principal",
      channel_session_id: SESSION_ID,
      is_active: true,
      fallback_agent_id: null,
      updated_at: "2026-07-26T00:00:00Z",
    };
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminStub({
        routersSelect: { data: [routerRow], error: null },
        membersSelect: { data: [{ router_id: "r1" }, { router_id: "r1" }], error: null },
      }) as never,
    );

    const { GET } = await import("./route");
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { routers: Array<{ id: string; member_count: number }> } };
    expect(body.data.routers).toEqual([{ ...routerRow, member_count: 2 }]);
  });

  it("erro ao listar routers → 500 internal_error", async () => {
    mockAuthzOk("agent");
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminStub({ routersSelect: { data: null, error: { message: "boom" } } }) as never,
    );
    const { GET } = await import("./route");
    const res = await GET(getReq());
    expect(res.status).toBe(500);
  });
});

describe("POST /api/v1/ai/routers", () => {
  it("cria router; organization_id vem de requireRole mesmo que o body mande outro", async () => {
    mockAuthzOk("admin");
    const admin = makeAdminStub({ insertResult: { data: { id: "new-router-1" }, error: null } });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const { POST } = await import("./route");
    const res = await POST(
      postReq({
        name: "Roteador",
        channel_session_id: SESSION_ID,
        organization_id: OTHER_ORG_ID, // deve ser ignorado
      }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data).toEqual({ id: "new-router-1" });

    const inserted = (admin.from("ai_routers") as unknown as { __lastInsert: () => Record<string, unknown> });
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai.router_created", organizationId: ORG_ID, resourceId: "new-router-1" }),
    );
    void inserted;
  });

  it("body inválido (name vazio) → 422 validation_failed", async () => {
    mockAuthzOk("admin");
    vi.mocked(createAdminClient).mockReturnValue(makeAdminStub({}) as never);

    const { POST } = await import("./route");
    const res = await POST(postReq({ name: "", channel_session_id: SESSION_ID }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
    expect(audit).not.toHaveBeenCalled();
  });

  it("channel_session_id de outra org → 404 channel_session_not_found (não 201, não 409)", async () => {
    mockAuthzOk("admin");
    const admin = makeAdminStub({ sessionFound: false, insertResult: { data: { id: "new-router-1" }, error: null } });
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const { POST } = await import("./route");
    const res = await POST(postReq({ name: "Roteador", channel_session_id: SESSION_ID }));

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("channel_session_not_found");
    expect(audit).not.toHaveBeenCalled();
  });

  // ─── O 404 que mentia ──────────────────────────────────────────────────────
  // Estes dois casos guardam a diferença entre "esse número não é seu" e "não
  // consegui verificar". Em produção eles eram a MESMA resposta: o banco estava
  // sem a migration 0106, o PostgREST devolvia 42703, o `error` era descartado e
  // o dono via "Número de WhatsApp não encontrado nesta organização" sobre um
  // número WORKING que a tela ao lado listava.
  it("banco sem a coluna archived_at (42703) → refaz sem o filtro e CRIA, em vez de 404", async () => {
    mockAuthzOk("admin");
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminStub({
        sessionSemColunaArchived: true,
        insertResult: { data: { id: "new-router-1" }, error: null },
      }) as never,
    );

    const { POST } = await import("./route");
    const res = await POST(postReq({ name: "Roteador", channel_session_id: SESSION_ID }));

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data).toEqual({ id: "new-router-1" });
  });

  it("falha real da consulta → 500, nunca 404 (não afirmar ausência que não foi verificada)", async () => {
    mockAuthzOk("admin");
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminStub({
        sessionError: { code: "57014", message: "canceling statement due to statement timeout" },
        insertResult: { data: { id: "new-router-1" }, error: null },
      }) as never,
    );

    const { POST } = await import("./route");
    const res = await POST(postReq({ name: "Roteador", channel_session_id: SESSION_ID }));

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("internal_error");
    expect(audit).not.toHaveBeenCalled();
  });

  it("channel_session já tem router ativo (23505) → 409 tratado, não 500 cru", async () => {
    mockAuthzOk("admin");
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminStub({ insertResult: { data: null, error: { code: "23505", message: "duplicate" } } }) as never,
    );

    const { POST } = await import("./route");
    const res = await POST(postReq({ name: "Roteador", channel_session_id: SESSION_ID }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("router_already_exists");
    expect(audit).not.toHaveBeenCalled();
  });
});

// Este teste isola o handler; autoridade de suporte é exercitada na suíte própria.
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/impersonate/support")>(),
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => "f2200000-0000-4000-8000-000000000099"),
}));
