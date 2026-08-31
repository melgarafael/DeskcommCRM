import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { GET, PUT } from "./route";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const OUTRO_USER_ID = "44444444-4444-4444-8444-444444444444";

function reqOk(role: "agent" | "manager" = "agent") {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID } as never,
    org: { orgId: ORG_ID, name: "Org", role },
  });
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/v1/attendant-schedule", () => {
  it("rejeita ?user_id= malformado com 422 (não 500)", async () => {
    reqOk("agent");
    const res = await GET(
      new Request("http://x?user_id=not-a-uuid", { method: "GET" }) as never,
    );
    expect(res.status).toBe(422);
  });
});

describe("PUT /api/v1/attendant-schedule", () => {
  it("agent NÃO pode editar horário de OUTRA pessoa (403)", async () => {
    reqOk("agent");
    const res = await PUT(
      new Request("http://x", {
        method: "PUT",
        body: JSON.stringify({ user_id: OUTRO_USER_ID, blocks: [] }),
      }) as never,
    );
    expect(res.status).toBe(403);
  });

  it("agent PODE editar o próprio horário", async () => {
    reqOk("agent");
    const deleted: unknown[] = [];
    const inserted: unknown[] = [];
    const chain = {
      delete: () => ({
        eq: () => ({
          eq: () => {
            deleted.push(true);
            return Promise.resolve({ error: null });
          },
        }),
      }),
      insert: (rows: unknown[]) => {
        inserted.push(...rows);
        return Promise.resolve({ error: null });
      },
    };
    vi.mocked(createAdminClient).mockReturnValue({ from: () => chain } as never);

    const res = await PUT(
      new Request("http://x", {
        method: "PUT",
        body: JSON.stringify({
          user_id: USER_ID,
          blocks: [{ day_of_week: 1, starts_at: "09:00", ends_at: "12:00" }],
        }),
      }) as never,
    );
    expect(res.status).toBe(200);
    expect(deleted).toHaveLength(1);
    expect(inserted).toHaveLength(1);
  });

  it("manager PODE editar horário de outra pessoa", async () => {
    reqOk("manager");
    const chain = {
      delete: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
      insert: () => Promise.resolve({ error: null }),
    };
    vi.mocked(createAdminClient).mockReturnValue({ from: () => chain } as never);

    const res = await PUT(
      new Request("http://x", {
        method: "PUT",
        body: JSON.stringify({ user_id: OUTRO_USER_ID, blocks: [] }),
      }) as never,
    );
    expect(res.status).toBe(200);
  });

  it("rejeita bloco com ends_at <= starts_at", async () => {
    reqOk("agent");
    const res = await PUT(
      new Request("http://x", {
        method: "PUT",
        body: JSON.stringify({
          user_id: USER_ID,
          blocks: [{ day_of_week: 1, starts_at: "12:00", ends_at: "09:00" }],
        }),
      }) as never,
    );
    expect(res.status).toBe(422);
  });
});
