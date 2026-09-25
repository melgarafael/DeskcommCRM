import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  message: null as Record<string, unknown> | null,
  calls: [] as Array<{ table: string; update?: Record<string, unknown> }>,
  edit: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
  audit: vi.fn(async () => undefined),
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({ ok: true, user: { id: "usuario-1", idioma: "pt-BR" }, org: { orgId: "org-1" } }),
}));
vi.mock("@/lib/audit", () => ({ audit: state.audit }));
vi.mock("@/lib/channels", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  transportaMensagem: () => true,
  resolveSessionRef: () => "numero-1",
  getAdapter: () => ({
    isConfigured: () => true,
    resolveRecipient: () => "chat-1",
    editMessage: state.edit,
    revokeMessage: state.remove,
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      const q = {
        select: () => q, eq: () => q, is: () => q, order: () => q, limit: () => q,
        update: (update: Record<string, unknown>) => { state.calls.push({ table, update }); return q; },
        maybeSingle: async () => ({ data: table === "messages"
          ? state.calls.some((c) => c.table === "messages" && c.update)
            ? { id: state.message?.id, body: state.message?.body, edited_at: "agora", revoked_at: null }
            : state.message
          : table === "conversations"
            ? { id: "conversa-1", contact_id: "contato-1", is_group: false, channel_session_id: "sessao-1" }
            : table === "channel_sessions"
              ? { provider: "canal-teste", archived_at: null }
              : { phone_number: "5511999999999", wa_identity: null, wa_lid: null }, error: null }),
      };
      return q;
    },
  }),
}));

import { DELETE, PATCH } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const ctx = { params: Promise.resolve({ id }) };
const url = `http://localhost/api/v1/messages/${id}`;

beforeEach(() => {
  state.calls.length = 0;
  state.edit.mockClear();
  state.remove.mockClear();
  state.audit.mockClear();
  state.message = {
    id, organization_id: "org-1", conversation_id: "conversa-1", channel_session_id: "sessao-1",
    external_id: "ABC", direction: "outbound", type: "text", status: "sent",
    body: "antes", sent_via: "user", sent_by_user_id: "usuario-1",
    sent_at: new Date().toISOString(), revoked_at: null,
  };
});

describe("alterar mensagem enviada", () => {
  it("rejeita mensagem recebida antes de chamar o canal", async () => {
    state.message = { ...state.message, direction: "inbound" };
    const res = await DELETE(new NextRequest(url, { method: "DELETE" }), ctx);
    expect(res.status).toBe(403);
    expect(state.remove).not.toHaveBeenCalled();
  });

  it("edita só mensagem própria pelo adaptador do canal, e audita", async () => {
    const res = await PATCH(new NextRequest(url, {
      method: "PATCH", body: JSON.stringify({ text: "depois" }),
    }), ctx);
    expect(res.status).toBe(200);
    expect(state.edit).toHaveBeenCalledWith({
      organizationId: "org-1", sessionRef: "numero-1", recipient: "chat-1", externalId: "ABC", text: "depois",
    });
    expect(state.calls).toContainEqual({ table: "messages", update: expect.objectContaining({ body: "depois" }) });
    expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "message.edited", resourceId: id }));
  });

  it("não marca como apagada quando o canal recusa", async () => {
    state.remove.mockRejectedValueOnce(new Error("recusado_403"));
    const res = await DELETE(new NextRequest(url, { method: "DELETE" }), ctx);
    expect(res.status).toBe(502);
    expect(state.calls).toEqual([]);
    expect(state.audit).not.toHaveBeenCalled();
  });
});
