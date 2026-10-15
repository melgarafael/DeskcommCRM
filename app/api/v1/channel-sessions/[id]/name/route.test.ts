import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { PATCH } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";

function request(display_name: string) {
  return new NextRequest(`http://localhost/api/v1/channel-sessions/${CANAL}/name`, {
    method: "PATCH",
    body: JSON.stringify({ display_name }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "33333333-3333-4333-8333-333333333333" },
    org: { orgId: ORG, role: "admin" },
  } as Awaited<ReturnType<typeof requireRole>>);
});

describe("PATCH …/channel-sessions/[id]/name", () => {
  it("grava o nome somente dentro da organização ativa e audita a troca", async () => {
    const calls: Array<[string, unknown]> = [];
    // Filtros da GRAVAÇÃO à parte: o `.eq` da leitura não pode responder pelo update.
    const filtrosDoUpdate: Array<[string, unknown]> = [];
    let mode: "read" | "update" = "read";
    const builder: Record<string, unknown> = {
      select: () => builder,
      update: (value: unknown) => {
        mode = "update";
        calls.push(["update", value]);
        return builder;
      },
      eq: (column: string, value: unknown) => {
        calls.push([column, value]);
        if (mode === "update") filtrosDoUpdate.push([column, value]);
        return builder;
      },
      is: () => builder,
      maybeSingle: async () =>
        mode === "read"
          ? { data: { display_name: "Antigo" }, error: null }
          : { data: { id: CANAL, display_name: "WA | 6592" }, error: null },
    };
    vi.mocked(createAdminClient).mockReturnValue({ from: () => builder } as never);

    const response = await PATCH(request("  WA | 6592  "), {
      params: Promise.resolve({ id: CANAL }),
    });

    expect(response.status).toBe(200);
    expect(calls).toContainEqual(["organization_id", ORG]);
    expect(filtrosDoUpdate).toContainEqual(["organization_id", ORG]);
    expect(calls).toContainEqual(["update", { display_name: "WA | 6592" }]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "channel.renamed",
        organizationId: ORG,
        resourceId: CANAL,
      }),
    );
  });

  it("recusa nome vazio antes de tocar no banco", async () => {
    const response = await PATCH(request("   "), { params: Promise.resolve({ id: CANAL }) });
    expect(response.status).toBe(422);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});
