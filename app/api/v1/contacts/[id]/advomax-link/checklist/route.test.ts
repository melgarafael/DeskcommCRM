import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { PATCH } from "./route";

const mocks = vi.hoisted(() => ({ supportWrite: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.supportWrite }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: { ADVOMAX_API_URL: "https://gestao.example", ADVOMAX_CRM_INTEGRATION_KEY: "server-secret" } }));

const CONTACT = "22222222-2222-4222-8222-222222222222";
const ctx = { params: Promise.resolve({ id: CONTACT }) };

describe("checklist documental jurídico", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.supportWrite.mockResolvedValue(null);
    vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: "u1", email: "ana@example.com" }, org: { orgId: "11111111-1111-4111-8111-111111111111" } } as never);
  });

  it("rejeita atualização malformada antes de acessar o banco", async () => {
    const request = new NextRequest(`http://localhost/api/v1/contacts/${CONTACT}/advomax-link/checklist`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ processo_codigo: 9, tipo_acao_codigo: 3, item_id: "não-é-uuid", completed: true }),
    });
    const response = await PATCH(request, ctx);
    expect(response.status).toBe(422);
    expect(createClient).not.toHaveBeenCalled();
  });
});
