import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/v1/ai/routers/:id é a rota que o editor rebusca depois de salvar.
 * Se ela não devolve `flow_pointer_id`, o baseline do editor vira "nenhuma
 * intenção tem roteiro": o Salvar fica ligado depois de vincular, e escolher
 * "Nenhum" deixa o draft igual ao baseline — o desvínculo nunca é gravado e a
 * intenção segue disparando o roteiro.
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const ROUTER_ID = "55555555-5555-4555-8555-555555555555";

describe("GET /api/v1/ai/routers/:id", () => {
  it("devolve flow_pointer_id de cada membro", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: {
        id: "11111111-1111-4111-8111-111111111111",
        email: "a@example.com",
        full_name: null,
        avatar_url: null,
        is_platform_admin: false,
        idioma: "pt-BR" as const,
        organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "agent" }],
      },
      org: { orgId: ORG_ID, name: "Org", role: "agent" },
    } as Awaited<ReturnType<typeof requireRole>>);

    const selects: Record<string, string> = {};
    const chain = (table: string, result: unknown) => {
      const q = {
        select(cols: string) {
          selects[table] = cols;
          return q;
        },
        eq() {
          return q;
        },
        maybeSingle: () => Promise.resolve({ data: result, error: null }),
        order: () => Promise.resolve({ data: result, error: null }),
      };
      return q;
    };
    vi.mocked(createAdminClient).mockReturnValue({
      from: (table: string) =>
        table === "ai_routers"
          ? chain(table, { id: ROUTER_ID, name: "R" })
          : chain(table, [{ id: "m1", flow_pointer_id: "77777777-7777-4777-8777-777777777777" }]),
    } as unknown as ReturnType<typeof createAdminClient>);

    const { GET } = await import("./route");
    const res = await GET(new NextRequest(`http://x/api/v1/ai/routers/${ROUTER_ID}`), {
      params: Promise.resolve({ id: ROUTER_ID }),
    });

    expect(res.status).toBe(200);
    expect(selects.ai_router_members).toContain("flow_pointer_id");
  });
});
