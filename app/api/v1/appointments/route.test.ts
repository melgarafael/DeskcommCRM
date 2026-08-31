import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { GET, POST } from "./route";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const LEAD_ID = "55555555-5555-4555-8555-555555555555";
const TYPE_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "22222222-2222-4222-8222-222222222222";

function reqOk() {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID } as never,
    org: { orgId: ORG_ID, name: "Org", role: "agent" },
  });
}

beforeEach(() => vi.clearAllMocks());

describe("POST /api/v1/appointments", () => {
  it("cria o agendamento, o vínculo em crm_lead_links e a atividade", async () => {
    reqOk();
    const inserts: { table: string; row: unknown }[] = [];
    vi.mocked(createAdminClient).mockReturnValue({
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ single: () => Promise.resolve({ data: { duration_minutes: 30, responsible_user_id: USER_ID }, error: null }) }),
          }),
        }),
        insert: (row: unknown) => {
          inserts.push({ table, row });
          return {
            select: () => ({ single: () => Promise.resolve({ data: { id: "novo-agendamento" }, error: null }) }),
          };
        },
      }),
    } as never);

    const res = await POST(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          lead_id: LEAD_ID,
          appointment_type_id: TYPE_ID,
          scheduled_at: "2026-09-01T09:00:00.000Z",
        }),
      }) as never,
    );

    expect(res.status).toBe(201);
    expect(inserts.some((i) => i.table === "appointments")).toBe(true);
    const linkInsert = inserts.find((i) => i.table === "crm_lead_links");
    expect(linkInsert).toBeDefined();
    expect(linkInsert?.row).toMatchObject({
      organization_id: ORG_ID,
      lead_id: LEAD_ID,
      target_kind: "appointment",
      link_kind: "reference",
    });
  });

  it("loga aviso (sem derrubar a resposta) quando o insert de crm_lead_links falha", async () => {
    reqOk();
    vi.mocked(createAdminClient).mockReturnValue({
      from: (table: string) => {
        if (table === "appointment_types") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({ single: () => Promise.resolve({ data: { duration_minutes: 30, responsible_user_id: USER_ID }, error: null }) }),
              }),
            }),
          };
        }
        if (table === "appointments") {
          return {
            insert: () => ({
              select: () => ({ single: () => Promise.resolve({ data: { id: "novo-agendamento" }, error: null }) }),
            }),
          };
        }
        // crm_lead_links: insert falha (sem .select().single() no fluxo real).
        return {
          insert: () => Promise.resolve({ error: { message: "constraint violation" } }),
        };
      },
    } as never);

    const res = await POST(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          lead_id: LEAD_ID,
          appointment_type_id: TYPE_ID,
          scheduled_at: "2026-09-01T09:00:00.000Z",
        }),
      }) as never,
    );

    expect(res.status).toBe(201);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining("crm_lead_links"),
      expect.objectContaining({ error: "constraint violation" }),
    );
  });

  it("loga aviso quando emitLeadActivity falha, sem derrubar a resposta", async () => {
    reqOk();
    vi.mocked(emitLeadActivity).mockResolvedValueOnce({ ok: false, error: "falha simulada" });
    vi.mocked(createAdminClient).mockReturnValue({
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ single: () => Promise.resolve({ data: { duration_minutes: 30, responsible_user_id: USER_ID }, error: null }) }),
          }),
        }),
        insert: () => ({
          select: () => ({ single: () => Promise.resolve({ data: { id: "novo-agendamento" }, error: null }) }),
        }),
      }),
    } as never);

    const res = await POST(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          lead_id: LEAD_ID,
          appointment_type_id: TYPE_ID,
          scheduled_at: "2026-09-01T09:00:00.000Z",
        }),
      }) as never,
    );

    expect(res.status).toBe(201);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining("emitLeadActivity"),
      expect.objectContaining({ error: "falha simulada" }),
    );
  });

  it("409 quando o banco recusa por sobreposição de horário (exclusion constraint, código 23P01)", async () => {
    reqOk();
    vi.mocked(createAdminClient).mockReturnValue({
      from: (table: string) =>
        table === "appointment_types"
          ? {
              select: () => ({
                eq: () => ({
                  eq: () => ({ single: () => Promise.resolve({ data: { duration_minutes: 30, responsible_user_id: USER_ID }, error: null }) }),
                }),
              }),
            }
          : {
              insert: () => ({
                select: () => ({
                  single: () =>
                    Promise.resolve({
                      data: null,
                      error: { code: "23P01", message: "conflicting key value violates exclusion constraint" },
                    }),
                }),
              }),
            },
    } as never);

    const res = await POST(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          lead_id: LEAD_ID,
          appointment_type_id: TYPE_ID,
          scheduled_at: "2026-09-01T09:00:00.000Z",
        }),
      }) as never,
    );
    expect(res.status).toBe(409);
  });

  it("422 sem lead_id", async () => {
    reqOk();
    const res = await POST(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({ appointment_type_id: TYPE_ID, scheduled_at: "2026-09-01T09:00:00.000Z" }),
      }) as never,
    );
    expect(res.status).toBe(422);
  });
});
