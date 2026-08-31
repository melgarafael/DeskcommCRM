import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: vi.fn().mockResolvedValue({ ok: true }) }));

import { PATCH } from "./route";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const APPT_ID = "66666666-6666-4666-8666-666666666666";
const LEAD_ID = "55555555-5555-4555-8555-555555555555";

function reqOk() {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u1" } as never,
    org: { orgId: ORG_ID, name: "Org", role: "agent" },
  });
}

function stubUpdate(updated: Record<string, unknown>) {
  const chain = {
    update: (patch: Record<string, unknown>) => ({
      eq: () => ({
        eq: () => ({
          select: () => ({
            single: () => Promise.resolve({ data: { ...updated, ...patch }, error: null }),
          }),
        }),
      }),
    }),
  };
  vi.mocked(createAdminClient).mockReturnValue({ from: () => chain } as never);
}

beforeEach(() => vi.clearAllMocks());

describe("PATCH /api/v1/appointments/[id]", () => {
  it("muda status para completed", async () => {
    reqOk();
    stubUpdate({ id: APPT_ID, lead_id: LEAD_ID, status: "scheduled" });
    const res = await PATCH(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ status: "completed" }) }) as never,
      { params: Promise.resolve({ id: APPT_ID }) } as never,
    );
    expect(res.status).toBe(200);
  });

  it("reagendar (muda scheduled_at) zera reminder_sent_at", async () => {
    reqOk();
    let patchRecebido: Record<string, unknown> = {};
    const chain = {
      update: (patch: Record<string, unknown>) => {
        patchRecebido = patch;
        return {
          eq: () => ({
            eq: () => ({
              select: () => ({
                single: () => Promise.resolve({ data: { id: APPT_ID, lead_id: LEAD_ID, ...patch }, error: null }),
              }),
            }),
          }),
        };
      },
    };
    vi.mocked(createAdminClient).mockReturnValue({ from: () => chain } as never);

    await PATCH(
      new Request("http://x", {
        method: "PATCH",
        body: JSON.stringify({ scheduled_at: "2026-09-02T09:00:00.000Z" }),
      }) as never,
      { params: Promise.resolve({ id: APPT_ID }) } as never,
    );
    expect(patchRecebido).toMatchObject({
      scheduled_at: "2026-09-02T09:00:00.000Z",
      reminder_sent_at: null,
    });
  });

  it("422 status fora do vocabulário", async () => {
    reqOk();
    const res = await PATCH(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ status: "invalido" }) }) as never,
      { params: Promise.resolve({ id: APPT_ID }) } as never,
    );
    expect(res.status).toBe(422);
  });

  it("400 quando body não tem nenhum campo", async () => {
    reqOk();
    const res = await PATCH(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({}) }) as never,
      { params: Promise.resolve({ id: APPT_ID }) } as never,
    );
    expect(res.status).toBe(400);
  });

  it("409 quando UPDATE colide com exclusion constraint (23P01)", async () => {
    reqOk();
    const chain = {
      update: () => ({
        eq: () => ({
          eq: () => ({
            select: () => ({
              single: () => Promise.resolve({ data: null, error: { code: "23P01", message: "conflict" } }),
            }),
          }),
        }),
      }),
    };
    vi.mocked(createAdminClient).mockReturnValue({ from: () => chain } as never);

    const res = await PATCH(
      new Request("http://x", {
        method: "PATCH",
        body: JSON.stringify({ scheduled_at: "2026-09-02T09:00:00.000Z" }),
      }) as never,
      { params: Promise.resolve({ id: APPT_ID }) } as never,
    );
    expect(res.status).toBe(409);
  });

  it("propaga 401/403 de requireRole sem chamar o admin client", async () => {
    const forbidden = new Response(JSON.stringify({ error: { code: "forbidden" } }), { status: 403 });
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: forbidden } as never);
    const res = await PATCH(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ status: "completed" }) }) as never,
      { params: Promise.resolve({ id: APPT_ID }) } as never,
    );
    expect(res.status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});
