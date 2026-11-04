import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { PATCH } from "./route";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
const org = "aaaaaaaa-0000-4000-8000-000000000001",
  user = "aaaaaaaa-0000-4000-8000-000000000002";
beforeEach(() => vi.clearAllMocks());
describe("configuração da passagem: org vem da sessão, nunca do corpo", () => {
  it("nega sem papel manager e não escreve", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        { error: { code: "forbidden", message: "Forbidden" } },
        { status: 403 },
      ),
    });
    const r = await PATCH(
      new NextRequest("https://crm.example/api/v1/settings/handoff-delivery", {
        method: "PATCH",
        body: "{}",
      }),
    );
    expect(r.status).toBe(403);
    expect(createClient).not.toHaveBeenCalled();
  });
  it("corpo não pode escolher outra empresa", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      org: { orgId: org, role: "manager" },
      user: { id: user },
    } as Awaited<ReturnType<typeof requireRole>>);
    const r = await PATCH(
      new NextRequest("https://crm.example/api/v1/settings/handoff-delivery", {
        method: "PATCH",
        body: JSON.stringify({ enabled: false, organization_id: user }),
      }),
    );
    expect(r.status).toBe(400);
    expect(createClient).not.toHaveBeenCalled();
  });
});
