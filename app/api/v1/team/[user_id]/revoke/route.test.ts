import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit";
import { registrarTrocaDeComando } from "@/lib/inbox/atividade-de-comando";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: vi.fn(async () => null),
}));
vi.mock("@/lib/audit", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  audit: vi.fn(async () => undefined),
}));
vi.mock("@/lib/inbox/atividade-de-comando", () => ({
  registrarTrocaDeComando: vi.fn(async () => undefined),
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const ADMIN = "22222222-2222-4222-8222-222222222222";
const ALVO = "33333333-3333-4333-8333-333333333333";

let ultimoUpdate: Record<string, unknown> | null = null;

interface MockBancoOpts {
  membro: unknown;
  conversasAbertas?: Array<{ id: string; contact_id: string | null }>;
  adminCount?: number;
}

function mockBanco(opts: MockBancoOpts) {
  ultimoUpdate = null;
  const update = vi.fn((valores: Record<string, unknown>) => {
    ultimoUpdate = valores;
    return { eq: vi.fn(async () => ({ error: null })) };
  });

  vi.mocked(createClient).mockResolvedValue({
    from: (table: string) => {
      if (table === "conversations") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                in: async () => ({ data: opts.conversasAbertas ?? [], error: null }),
              }),
            }),
          }),
        };
      }
      return {
        select: (_cols: string, headOpts?: { count?: string; head?: boolean }) => {
          if (headOpts?.head) {
            return {
              eq: () => ({
                eq: () => ({
                  is: async () => ({ count: opts.adminCount ?? 2, error: null }),
                }),
              }),
            };
          }
          return {
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: opts.membro, error: null }),
              }),
            }),
          };
        },
        update,
      };
    },
  } as never);
}

function pedido() {
  return new NextRequest("http://localhost/api/v1/team/x/revoke", { method: "POST" });
}
const ctx = { params: Promise.resolve({ user_id: ALVO }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: ADMIN, idioma: "pt-BR" },
    org: { orgId: ORG, role: "admin" },
  } as never);
});

describe("revogar membro", () => {
  it("revoga o membro e carimba revoked_at", async () => {
    mockBanco({ membro: { id: "m1", user_id: ALVO, role: "agent", revoked_at: null } });
    const { POST } = await import("./route");

    const res = await POST(pedido(), ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.user_id).toBe(ALVO);
    expect(ultimoUpdate).toHaveProperty("revoked_at");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "member.revoked",
        actorUserId: ADMIN,
        resourceId: "m1",
      }),
    );
  });

  it("libera e audita conversas abertas atribuídas a quem sai (#1562)", async () => {
    mockBanco({
      membro: { id: "m1", user_id: ALVO, role: "agent", revoked_at: null },
      conversasAbertas: [
        { id: "c1", contact_id: "ct1" },
        { id: "c2", contact_id: "ct2" },
      ],
    });
    const { POST } = await import("./route");

    const res = await POST(pedido(), ctx);
    expect(res.status).toBe(200);

    // Linha do tempo emitida para cada conversa liberada
    expect(registrarTrocaDeComando).toHaveBeenCalledTimes(2);
    expect(registrarTrocaDeComando).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "c1",
        contactId: "ct1",
        tipo: "conversation_released",
      }),
    );
    expect(registrarTrocaDeComando).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "c2",
        contactId: "ct2",
        tipo: "conversation_released",
      }),
    );

    // Auditoria de liberação de conversa para cada uma
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "conversation.released",
        resourceId: "c1",
        metadata: { reason: "member_revoked", target_user_id: ALVO },
      }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "conversation.released",
        resourceId: "c2",
        metadata: { reason: "member_revoked", target_user_id: ALVO },
      }),
    );

    // Auditoria de membro revogado registra quantas conversas foram soltas
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "member.revoked",
        metadata: expect.objectContaining({
          target_user_id: ALVO,
          released_conversations_count: 2,
        }),
      }),
    );
  });

  it("idempotência: membro já revogado devolve sucesso imediato sem tocar em nada", async () => {
    mockBanco({ membro: { id: "m1", user_id: ALVO, role: "agent", revoked_at: "2026-09-10T12:00:00Z" } });
    const { POST } = await import("./route");

    const res = await POST(pedido(), ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.already_revoked).toBe(true);
    expect(ultimoUpdate).toBeNull();
    expect(registrarTrocaDeComando).not.toHaveBeenCalled();
  });

  it("não permite revogar a si mesmo", async () => {
    const { POST } = await import("./route");
    const selfCtx = { params: Promise.resolve({ user_id: ADMIN }) };

    const res = await POST(pedido(), selfCtx);
    expect(res.status).toBe(409);
  });

  it("não permite revogar o último admin", async () => {
    mockBanco({
      membro: { id: "m1", user_id: ALVO, role: "admin", revoked_at: null },
      adminCount: 1,
    });
    const { POST } = await import("./route");

    const res = await POST(pedido(), ctx);
    expect(res.status).toBe(409);
  });
});
