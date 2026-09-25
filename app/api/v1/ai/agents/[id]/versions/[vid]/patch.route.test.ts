import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireSupportWrite } from "@/lib/impersonate/support";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: vi.fn(async () => null),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "33333333-3333-4333-8333-333333333333";
const VERSION = "44444444-4444-4444-8444-444444444444";
const FLOW = "55555555-5555-4555-8555-555555555555";

const followupExistente = {
  enabled: true,
  flow_pointer_ids: [FLOW],
  send_window: null,
};

function adminStub(atualizacoes: Record<string, unknown>[]) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: VERSION,
                  status: "draft",
                  agent_id: AGENT,
                  organization_id: ORG,
                  followup: followupExistente,
                },
                error: null,
              }),
            }),
          }),
        }),
      }),
      update: (payload: Record<string, unknown>) => {
        atualizacoes.push(payload);
        return {
          eq: () => ({
            eq: () => ({
              select: () => ({
                single: async () => ({ data: { id: VERSION, ...payload }, error: null }),
              }),
            }),
          }),
        };
      },
    }),
  };
}

describe("PATCH .../versions/:vid — atualização parcial", () => {
  const atualizacoes: Record<string, unknown>[] = [];

  beforeEach(() => {
    atualizacoes.length = 0;
    vi.mocked(requireSupportWrite).mockResolvedValue(null);

    const user: AuthUser = {
      id: USER,
      email: "admin@example.com",
      full_name: null,
      avatar_url: null,
      is_platform_admin: false,
      idioma: "pt-BR",
      organizations: [{ organization_id: ORG, organization_name: "Org", role: "admin" }],
    };
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user,
      org: { orgId: ORG, name: "Org", role: "admin" },
    });
    vi.mocked(createAdminClient).mockReturnValue(adminStub(atualizacoes) as never);
  });

  it("muda somente a janela e preserva o restante da configuração", async () => {
    const sendWindow = {
      start: "09:00",
      end: "18:00",
      weekdays: [1, 2, 3, 4, 5],
    };
    const { PATCH } = await import("./route");
    const request = new NextRequest("http://localhost/api/v1/ai/agents/x/versions/y", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ followup: { send_window: sendWindow } }),
    });

    const response = await PATCH(request, {
      params: Promise.resolve({ id: AGENT, vid: VERSION }),
    });

    expect(response.status).toBe(200);
    expect(atualizacoes).toEqual([
      {
        followup: {
          enabled: true,
          flow_pointer_ids: [FLOW],
          send_window: sendWindow,
        },
      },
    ]);
  });
});
