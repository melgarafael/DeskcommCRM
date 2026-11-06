import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/v1/admin/inbox/conversations/route";

const state = vi.hoisted(() => ({
  allow: true,
  selected: "",
  filters: [] as unknown[][],
  rows: [] as Record<string, unknown>[],
  error: null as { message: string } | null,
  client: vi.fn(),
  audit: vi.fn(async () => {}),
}));
vi.mock("@/lib/auth/requirePlatformAdmin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/requirePlatformAdmin")>()),
  requirePlatformAdmin: async () => {
    if (!state.allow) throw new Error("forbidden");
    return { user: { id: "11111111-1111-4111-8111-111111111111" } };
  },
}));
vi.mock("@/lib/audit", () => ({ audit: state.audit }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    state.client();
    const chain = {
      select: (value: string) => {
        state.selected = value;
        return chain;
      },
      order: (...args: unknown[]) => {
        state.filters.push(["order", ...args]);
        return chain;
      },
      limit: (value: number) => {
        state.filters.push(["limit", value]);
        return chain;
      },
      eq: (...args: unknown[]) => {
        state.filters.push(["eq", ...args]);
        return chain;
      },
      ilike: (...args: unknown[]) => {
        state.filters.push(["ilike", ...args]);
        return chain;
      },
      or: (...args: unknown[]) => {
        state.filters.push(["or", ...args]);
        return chain;
      },
      is: (...args: unknown[]) => {
        state.filters.push(["is", ...args]);
        return chain;
      },
      then: (resolve: (value: unknown) => unknown) => {
        // Transport fixture with two relationships: the direct FK must be selected.
        const ambiguous = !state.selected.includes(
          "organizations!conversations_organization_id_fkey!inner",
        );
        return Promise.resolve(
          resolve({
            data: ambiguous || state.error ? null : state.rows,
            error:
              state.error ??
              (ambiguous ? { message: "PGRST201: ambiguous organizations relationship" } : null),
          }),
        );
      },
    };
    return {
      from: (table: string) => {
        expect(table).toBe("conversations");
        return chain;
      },
    };
  },
}));
const TENANT = "22222222-2222-4222-8222-222222222222";
const ROW = {
  id: "33333333-3333-4333-8333-333333333333",
  organization_id: TENANT,
  last_inbound_at: "2026-01-01T12:00:00Z",
  organizations: { display_name: "Empresa fictícia", slug: "fixture" },
  contacts: null,
};
const request = (query = "") =>
  new NextRequest(`http://localhost/api/v1/admin/inbox/conversations${query}`);
beforeEach(() => {
  state.allow = true;
  state.selected = "";
  state.filters = [];
  state.rows = [ROW];
  state.error = null;
  state.client.mockClear();
  state.audit.mockClear();
});
describe("Inbox administrativo — relação explícita com organização", () => {
  it("carrega sem PGRST201 preservando o nome organizations e o formato de resposta", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual([ROW]);
    expect(state.selected).toContain("organizations!conversations_organization_id_fkey!inner");
    expect(state.audit).toHaveBeenCalledWith(
      expect.objectContaining({ actingAsPlatformAdmin: true, bypassedRls: true }),
    );
  });
  it("não cria client privilegiado para quem não é administrador de plataforma", async () => {
    state.allow = false;
    expect((await GET(request())).status).toBe(403);
    expect(state.client).not.toHaveBeenCalled();
    expect(state.audit).not.toHaveBeenCalled();
  });
  it("mantém o filtro de empresa, status, busca e limite", async () => {
    expect((await GET(request(`?tenant_id=${TENANT}&status=open&q=fixture&limit=5`))).status).toBe(
      200,
    );
    expect(state.filters).toEqual(
      expect.arrayContaining([
        ["eq", "organization_id", TENANT],
        ["eq", "status", "open"],
        ["ilike", "last_message_preview", "%fixture%"],
        ["limit", 6],
      ]),
    );
  });
  it("recusa filtro de empresa inválido antes da consulta", async () => {
    expect((await GET(request("?tenant_id=invalid"))).status).toBe(400);
    expect(state.client).not.toHaveBeenCalled();
  });
  it("mantém paginação e cursor ao haver mais resultados", async () => {
    state.rows = [ROW, { ...ROW, id: "44444444-4444-4444-8444-444444444444" }];
    const response = await GET(request("?limit=1"));
    const body = await response.json();
    expect(body.data).toHaveLength(1);
    expect(body.meta.has_more).toBe(true);
    expect(JSON.parse(Buffer.from(body.meta.cursor, "base64url").toString())).toEqual({
      last_inbound_at: ROW.last_inbound_at,
      id: ROW.id,
    });
  });
  it("preserva o corte do cursor recebido", async () => {
    const cursor = Buffer.from(
      JSON.stringify({ id: ROW.id, last_inbound_at: ROW.last_inbound_at }),
    ).toString("base64url");
    await GET(request(`?cursor=${cursor}`));
    expect(state.filters).toContainEqual([
      "or",
      `last_inbound_at.lt.${ROW.last_inbound_at},and(last_inbound_at.eq.${ROW.last_inbound_at},id.lt.${ROW.id})`,
    ]);
  });
  it("falha real de banco continua sendo erro, sem declarar sucesso vazio", async () => {
    state.error = { message: "fixture unavailable" };
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("internal_error");
    expect(state.audit).not.toHaveBeenCalled();
  });
});
