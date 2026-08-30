import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { PATCH, DELETE } from "./route";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const TYPE_ID = "33333333-3333-4333-8333-333333333333";

function reqOk() {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u1" } as never,
    org: { orgId: ORG_ID, name: "Org", role: "manager" },
  });
}

beforeEach(() => vi.clearAllMocks());

describe("DELETE /api/v1/appointment-types/[id]", () => {
  it("recusa (409) se houver agendamento futuro para este tipo", async () => {
    reqOk();
    const chain = {
      select: () => chain,
      eq: () => chain,
      gte: () => Promise.resolve({ count: 1, error: null }),
    };
    vi.mocked(createAdminClient).mockReturnValue({ from: () => chain } as never);

    const res = await DELETE(new Request("http://x") as never, {
      params: Promise.resolve({ id: TYPE_ID }),
    } as never);
    expect(res.status).toBe(409);
  });

  it("apaga quando não há agendamento futuro", async () => {
    reqOk();
    let deletado = false;
    const chain = {
      select: () => chain,
      eq: () => chain,
      gte: () => Promise.resolve({ count: 0, error: null }),
      delete: () => ({
        eq: () => ({
          eq: () => {
            deletado = true;
            return Promise.resolve({ error: null });
          },
        }),
      }),
    };
    vi.mocked(createAdminClient).mockReturnValue({ from: () => chain } as never);

    const res = await DELETE(new Request("http://x") as never, {
      params: Promise.resolve({ id: TYPE_ID }),
    } as never);
    expect(res.status).toBe(200);
    expect(deletado).toBe(true);
  });
});
