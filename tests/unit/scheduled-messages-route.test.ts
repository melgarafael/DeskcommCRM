import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const { requireRole, requireSupportWrite, insert, audit, state } = vi.hoisted(() => ({
  requireRole: vi.fn(),
  requireSupportWrite: vi.fn(),
  insert: vi.fn(),
  audit: vi.fn(),
  state: {
    provider: "meta_cloud",
    lastInboundAt: new Date().toISOString(),
    existing: null as Record<string, unknown> | null,
  },
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite }));
vi.mock("@/lib/audit", () => ({ audit }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({
          data: {
            id: CONVERSA,
            status: "open",
            last_inbound_at: state.lastInboundAt,
            channel_sessions: { provider: state.provider },
          },
          error: null,
        }),
      };
      return query;
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: state.existing, error: null }),
        insert: (row: unknown) => {
          insert(row);
          return query;
        },
        single: async () => ({ data: { id: ID, status: "pending" }, error: null }),
      };
      return query;
    },
  }),
}));

import { POST } from "@/app/api/v1/conversations/[id]/scheduled-messages/route";

const ORG = "00000000-0000-4000-8000-000000000001";
const CONVERSA = "00000000-0000-4000-8000-000000000002";
const ATENDENTE = "00000000-0000-4000-8000-000000000003";
const ID = "00000000-0000-4000-8000-000000000004";

function request(scheduledAt: Date): NextRequest {
  return new Request("http://localhost/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: ID,
      body: "Mensagem futura",
      scheduled_at: scheduledAt.toISOString(),
    }),
  }) as NextRequest;
}

const ctx = { params: Promise.resolve({ id: CONVERSA }) };

beforeEach(() => {
  vi.clearAllMocks();
  state.provider = "meta_cloud";
  state.lastInboundAt = new Date().toISOString();
  state.existing = null;
  requireSupportWrite.mockResolvedValue(null);
  requireRole.mockResolvedValue({ ok: true, org: { orgId: ORG }, user: { id: ATENDENTE } });
  audit.mockResolvedValue(undefined);
});

describe("agendar uma resposta no Inbox", () => {
  it("recusa texto livre que só seria enviado após a janela oficial fechar", async () => {
    const res = await POST(request(new Date(Date.now() + 25 * 60 * 60_000)), ctx);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("window_will_close");
    expect(insert).not.toHaveBeenCalled();
  });

  it("aceita horário futuro no canal que permite texto livre", async () => {
    state.provider = "waha";
    const res = await POST(request(new Date(Date.now() + 25 * 60 * 60_000)), ctx);
    expect(res.status).toBe(201);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: ID,
        organization_id: ORG,
        conversation_id: CONVERSA,
        created_by_user_id: ATENDENTE,
      }),
    );
  });

  it("repetir o mesmo pedido devolve o agendamento existente sem criar outro", async () => {
    const scheduledAt = new Date(Date.now() + 5 * 60_000);
    state.existing = { id: ID, body: "Mensagem futura", scheduled_at: scheduledAt.toISOString() };
    const res = await POST(request(scheduledAt), ctx);
    expect(res.status).toBe(200);
    expect(insert).not.toHaveBeenCalled();
  });
});
