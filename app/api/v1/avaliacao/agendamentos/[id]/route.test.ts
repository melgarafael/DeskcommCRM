/**
 * PATCH /api/v1/avaliacao/agendamentos/[id] — não pode mandar campos de UI
 * (`consultant_auto`, `client_name`, `client_phone`) para o PostgREST.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import type { AuthUser } from "@/lib/auth/types";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const AG_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const UNIT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function autorizado(): void {
  const user = {
    id: USER_ID,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR",
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "agent" }],
  } as AuthUser;
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG_ID, name: "Org", role: "agent" },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createAdminClient).mockReturnValue({} as never);
  vi.mocked(moduloLigado).mockResolvedValue(true);
});

describe("PATCH /api/v1/avaliacao/agendamentos/[id]", () => {
  it("não envia consultant_auto/client_name/client_phone ao update", async () => {
    autorizado();
    const updates: unknown[] = [];
    const builder: Record<string, unknown> = {
      update: (row: unknown) => {
        updates.push(row);
        return builder;
      },
      eq: () => builder,
      select: () => builder,
      maybeSingle: () =>
        Promise.resolve({
          data: { id: AG_ID, unit_id: UNIT, status: "agendado" },
          error: null,
        }),
    };
    vi.mocked(createClient).mockResolvedValue({ from: () => builder } as never);

    const { PATCH } = await import("./route");
    const res = await PATCH(
      new NextRequest(`http://localhost/api/v1/avaliacao/agendamentos/${AG_ID}`, {
        method: "PATCH",
        body: JSON.stringify({
          unit_id: UNIT,
          scheduled_at: "2026-11-12T12:00:00.000Z",
          client_name: "Maria",
          client_phone: "11999998888",
          consultant_auto: true,
          notes: "obs",
        }),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ id: AG_ID }) },
    );

    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
    const patch = updates[0] as Record<string, unknown>;
    expect(patch).not.toHaveProperty("consultant_auto");
    expect(patch).not.toHaveProperty("client_name");
    expect(patch).not.toHaveProperty("client_phone");
    expect(patch.notes).toBe("obs");
    expect(patch.unit_id).toBe(UNIT);
    expect(patch).toHaveProperty("updated_at");
  });

  it("recusa mudança de status pela rota de edição", async () => {
    autorizado();
    vi.mocked(createClient).mockResolvedValue({ from: () => ({}) } as never);

    const { PATCH } = await import("./route");
    const res = await PATCH(
      new NextRequest(`http://localhost/api/v1/avaliacao/agendamentos/${AG_ID}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "cancelado" }),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ id: AG_ID }) },
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.message).toMatch(/ações/i);
  });
});
