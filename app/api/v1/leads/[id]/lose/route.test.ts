import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/leads/activity-write-failure", () => ({
  registraFalhaDeAtividade: vi.fn(async () => undefined),
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const LEAD_ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID },
    org: { orgId: ORG_ID },
  } as never);
  vi.mocked(createClient).mockResolvedValue({ from: vi.fn() } as never);
});

function request(body: string): NextRequest {
  return new NextRequest(`http://localhost/api/v1/leads/${LEAD_ID}/lose`, {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/v1/leads/[id]/lose", () => {
  it("retorna lost_reason_required para body sem motivo", async () => {
    const { POST } = await import("./route");

    const response = await POST(request("{}"), { params: Promise.resolve({ id: LEAD_ID }) });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "lost_reason_required" },
    });
  });

  it("mantém body malformado como erro de JSON", async () => {
    const { POST } = await import("./route");

    const response = await POST(request("{"), { params: Promise.resolve({ id: LEAD_ID }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "body_malformed" },
    });
  });
});
