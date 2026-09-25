import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  role: "manager",
  message: null as Record<string, unknown> | null,
  calls: [] as Array<{ table: string; update: Record<string, unknown> }>,
  audit: vi.fn(async () => undefined),
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async (role: string) => state.role === role
    ? { ok: true, user: { id: "usuario-1", idioma: "pt-BR" }, org: { orgId: "org-1" } }
    : { ok: false, response: new Response(null, { status: 403 }) },
}));
vi.mock("@/lib/audit", () => ({ audit: state.audit }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      const q = {
        select: () => q, eq: () => q, order: () => q, limit: () => q,
        update: (update: Record<string, unknown>) => {
          state.calls.push({ table, update });
          return q;
        },
        maybeSingle: async () => ({
          data: table === "messages"
            ? state.calls.some((call) => call.table === "messages")
              ? { id: state.message?.id, metadata: state.calls.find((call) => call.table === "messages")?.update.metadata }
              : state.message
            : null,
          error: null,
        }),
      };
      return q;
    },
  }),
}));

import { DELETE, POST } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const ctx = { params: Promise.resolve({ id }) };
const url = `http://localhost/api/v1/messages/${id}/hide`;

beforeEach(() => {
  state.role = "manager";
  state.calls.length = 0;
  state.audit.mockClear();
  state.message = {
    id, organization_id: "org-1", conversation_id: "conversa-1",
    direction: "inbound", body: "conteúdo particular", type: "text",
    metadata: { source: "canal" }, revoked_at: null,
  };
});

describe("ocultar mensagem recebida no CRM", () => {
  it("preserva o conteúdo e marca a mensagem como oculta", async () => {
    const res = await POST(new NextRequest(url, { method: "POST" }), ctx);
    expect(res.status).toBe(200);
    expect(state.calls[0]).toEqual({ table: "messages", update: {
      metadata: expect.objectContaining({ source: "canal", crm_hidden_by: "usuario-1", crm_hidden_at: expect.any(String) }),
    } });
    expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "message.hidden_in_crm", resourceId: id }));
  });

  it("restaura a visibilidade sem perder os metadados originais", async () => {
    state.message = { ...state.message, metadata: { source: "canal", crm_hidden_at: "ontem", crm_hidden_by: "usuario-1" } };
    const res = await DELETE(new NextRequest(url, { method: "DELETE" }), ctx);
    expect(res.status).toBe(200);
    expect(state.calls[0]).toEqual({ table: "messages", update: { metadata: { source: "canal" } } });
    expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "message.restored_in_crm" }));
  });

  it("não permite ocultar mensagem enviada", async () => {
    state.message = { ...state.message, direction: "outbound" };
    const res = await POST(new NextRequest(url, { method: "POST" }), ctx);
    expect(res.status).toBe(403);
    expect(state.calls).toEqual([]);
  });
});
