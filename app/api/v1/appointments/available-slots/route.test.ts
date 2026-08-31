import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { GET } from "./route";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const TYPE_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "22222222-2222-4222-8222-222222222222";

function reqOk() {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u1" } as never,
    org: { orgId: ORG_ID, name: "Org", role: "agent" },
  });
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/v1/appointments/available-slots", () => {
  it("422 sem type_id ou date", async () => {
    reqOk();
    const res = await GET(new Request("http://x/api/v1/appointments/available-slots") as never);
    expect(res.status).toBe(422);
  });

  it("422 com type_id não-UUID ou date malformada (sem lançar 500)", async () => {
    reqOk();
    const res = await GET(
      new Request("http://x/api/v1/appointments/available-slots?type_id=not-a-uuid&date=notadate") as never,
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.code).toBe("validation_failed");
  });

  it("devolve slots calculados a partir do tipo + horário do atendente + fuso da org", async () => {
    reqOk();
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      single: () =>
        Promise.resolve({
          data: { duration_minutes: 30, responsible_user_id: USER_ID },
          error: null,
        }),
      maybeSingle: () => Promise.resolve({ data: { timezone: "Africa/Maputo" }, error: null }),
      order: () => Promise.resolve({ data: [{ starts_at: "09:00:00", ends_at: "10:00:00" }], error: null }),
      lt: () => chain,
      gte: () => Promise.resolve({ data: [], error: null }),
    });
    vi.mocked(createAdminClient).mockReturnValue({ from: () => chain } as never);

    const res = await GET(
      new Request(`http://x/api/v1/appointments/available-slots?type_id=${TYPE_ID}&date=2026-09-01`) as never,
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.length).toBeGreaterThan(0);
  });
});
