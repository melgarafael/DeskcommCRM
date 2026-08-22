import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { fail } from "@/lib/api/wrappers";
import type { AuthUser } from "@/lib/auth/types";

/**
 * GET /api/v1/billing/subscription — admin-only (spec 13 §4). Self-host sem
 * nenhuma assinatura vinculada devolve `{ subscribed: false }`, não erro.
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";

function mockAuthzOk() {
  const user: AuthUser = {
    id: USER_ID,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "admin" }],
  };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG_ID, name: "Org", role: "admin" },
  });
}

function mockAuthzDenied() {
  vi.mocked(requireRole).mockResolvedValue({
    ok: false,
    response: fail("forbidden_role", "denied", 403),
  });
}

describe("GET /api/v1/billing/subscription", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("nega quem não é admin do tenant", async () => {
    mockAuthzDenied();
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("devolve subscribed:false quando o tenant não tem assinatura (self-host)", async () => {
    mockAuthzOk();
    vi.mocked(createAdminClient).mockReturnValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const { GET } = await import("./route");
    const res = await GET();
    const json = (await res.json()) as { data: { subscribed: boolean } };

    expect(res.status).toBe(200);
    expect(json.data).toEqual({ subscribed: false });
  });

  it("devolve o plano quando o tenant tem assinatura", async () => {
    mockAuthzOk();
    vi.mocked(createAdminClient).mockReturnValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                id: "sub-1",
                status: "active",
                current_period_end: "2026-09-01T00:00:00Z",
                trial_ends_at: null,
                canceled_at: null,
                plan: { id: "plan-1", code: "pro", name: "Pro", price_cents: 9900 },
              },
              error: null,
            }),
          }),
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const { GET } = await import("./route");
    const res = await GET();
    const json = (await res.json()) as { data: { subscribed: boolean; status: string } };

    expect(json.data.subscribed).toBe(true);
    expect(json.data.status).toBe("active");
  });
});
