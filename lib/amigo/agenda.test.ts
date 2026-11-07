import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { HandlerCtx } from "@/lib/api/handlers/types";

const deps = vi.hoisted(() => ({ execute: vi.fn(), audit: vi.fn() }));
vi.mock("./service", () => ({ executeAmigo: deps.execute }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));

import { agendaAuthority, createAmigoAppointment, changeAmigoAppointment } from "./agenda";
import {
  marcarAgendamentoHandler,
  alterarAgendamentoHandler,
  cancelarAgendamentoHandler,
} from "@/app/api/v1/agenda/agendamentos/_handler";
import {
  horariosLivresDaOrg,
  listaAgendamentos,
  listaTiposDeAtendimento,
} from "@/lib/agenda/consulta";

const ctx: HandlerCtx = {
  organization_id: "org",
  actor: { type: "user", id: "staff", role: "manager" },
  requestId: "req",
  idempotencyKey: "durable-key",
};
const connection = {
  id: "connection",
  active: true,
  timezone: "America/Fortaleza",
  default_place_id: 3,
};
const local = {
  id: "appointment",
  authority: "local",
  revision: 2,
  status: "confirmed",
  time_zone: "America/Fortaleza",
  owner_user_id: "staff",
  event_type_id: null,
};
const external = {
  ...local,
  authority: "amigo",
  contact_id: "contact",
  external_connection_id: "original",
};

function database(
  options: {
    active?: boolean;
    missing?: boolean;
    error?: string;
    membershipRole?: string | null;
    appointment?: Record<string, unknown>;
    type?: Record<string, unknown>;
  } = {},
) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const rpc = vi.fn(async (name: string) =>
    name === "fn_calendar_agenda_provider"
      ? {
          data: options.active === false || options.missing ? null : connection,
          error: options.error ? { code: options.error } : null,
        }
      : name === "fn_calendar_amigo_target"
        ? { data: { attendance_id: 9, patient_id: 4 }, error: null }
        : { data: { ...local, status: "cancelled" }, error: null },
  );
  const from = (table: string) => {
    const result = () => {
      if (table === "amigo_connections")
        return {
          data: options.active === false || options.missing ? null : connection,
          error: options.missing
            ? { code: "42P01" }
            : options.error
              ? { code: options.error }
              : null,
        };
      if (table === "calendar_event_types")
        return {
          data: options.type ?? {
            id: "type",
            external_provider: "amigo",
            external_id: "7",
            external_connection_id: connection.id,
            is_active: true,
          },
          error: null,
        };
      if (table === "amigo_appointment_links")
        return { data: { attendance_id: 9, patient_id: 4 }, error: null };
      if (table === "calendar_appointments")
        return { data: options.appointment ?? external, error: null };
      if (table === "user_organizations")
        return {
          data: options.membershipRole ? { role: options.membershipRole } : null,
          error: null,
        };
      return { data: null, error: null };
    };
    const q: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "order", "limit", "gte", "lt", "or", "is", "not"])
      q[method] = (...args: unknown[]) => {
        calls.push({ table, method, args });
        return q;
      };
    q.maybeSingle = async () => result();
    q.then = (resolve: (v: unknown) => unknown) =>
      resolve({
        data: table === "calendar_appointments" ? [options.appointment ?? external] : [],
        error: null,
      });
    return q;
  };
  return { db: { from, rpc } as unknown as SupabaseClient, calls, rpc };
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.execute.mockResolvedValue({
    state: "confirmed",
    local_appointment_id: "appointment",
    data: { id: 9 },
  });
});

describe("agenda authority boundary", () => {
  it("uses org mode for new work and original authority for historical changes", async () => {
    const { db, calls } = database();
    expect((await agendaAuthority(db, "org")).provider).toBe("amigo");
    const before = calls.length;
    expect((await agendaAuthority(db, "org", local)).provider).toBe("local");
    expect(calls).toHaveLength(before);
    expect(await agendaAuthority(db, "org", external)).toMatchObject({
      provider: "amigo",
      connectionId: "original",
    });
    expect(db.rpc).toHaveBeenCalledWith("fn_calendar_agenda_provider", { p_org: "org" });
  });
  it("treats unprovisioned as local but refuses database failures", async () => {
    expect((await agendaAuthority(database({ missing: true }).db, "org")).provider).toBe("local");
    await expect(agendaAuthority(database({ error: "42501" }).db, "org")).rejects.toMatchObject({
      code: "agenda_provider_unavailable",
    });
  });
  it("legacy creation in active mode refuses missing patient/doctor/place before any local write", async () => {
    const { db, rpc } = database();
    await expect(
      marcarAgendamentoHandler(db, ctx, {
        event_type_id: "type",
        starts_at: "2026-11-09T13:00:00Z",
      }),
    ).rejects.toMatchObject({
      code: "agenda_amigo_context_required",
      message: expect.stringContaining("/app/integrations/amigo"),
    });
    expect(rpc.mock.calls.some(([name]) => name === "fn_appointment_change")).toBe(false);
    expect(deps.execute).not.toHaveBeenCalled();
  });
  it("an explicit Amigo request never becomes a local booking after mode is disabled", async () => {
    const { db, rpc } = database({ active: false, type: { id: "type", is_active: true } });
    await expect(
      marcarAgendamentoHandler(db, ctx, {
        event_type_id: "type",
        starts_at: "2026-11-09T13:00:00Z",
        amigo: { patient_id: 4, user_id: 2, place_id: 3 },
      }),
    ).rejects.toMatchObject({ code: "agenda_amigo_context_required" });
    expect(rpc.mock.calls.some(([name]) => name === "fn_appointment_change")).toBe(false);
    expect(deps.execute).not.toHaveBeenCalled();
  });
  it("creates remotely using real context, civil clinic time and a durable key, returning the projection ID", async () => {
    const { db } = database();
    const result = await createAmigoAppointment(
      db,
      ctx,
      {
        event_type_id: "type",
        starts_at: "2026-11-09T13:00:00Z",
        contact_id: "contact",
        amigo: { patient_id: 4, user_id: 2, place_id: 3 },
      },
      connection,
    );
    expect(deps.execute).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org", contactId: "contact" }),
      "attendance_create",
      { event_id: 7, patient_id: 4, user_id: 2, place_id: 3, start_date: "2026-11-09 10:00" },
      "durable-key",
    );
    expect(result).toMatchObject({ id: "appointment", authority: "amigo", attendance_id: 9 });
  });
  it.each(["uncertain", "rejected", "projection_pending"])(
    "never reports success for %s",
    async (state) => {
      deps.execute.mockResolvedValue({
        state,
        uncertain: state !== "rejected",
        operation_id: "op",
      });
      await expect(
        createAmigoAppointment(
          database().db,
          ctx,
          {
            event_type_id: "type",
            starts_at: "2026-11-09T13:00:00Z",
            amigo: { patient_id: 4, user_id: 2, place_id: 3 },
          },
          connection,
        ),
      ).rejects.toMatchObject({ code: "agenda_amigo_unconfirmed" });
    },
  );
  it("does not use an old external type with the current connection", async () => {
    await expect(
      createAmigoAppointment(
        database({
          type: { external_provider: "amigo", external_id: "7", external_connection_id: "old" },
        }).db,
        ctx,
        {
          event_type_id: "type",
          starts_at: "2026-11-09T13:00:00Z",
          amigo: { patient_id: 4, user_id: 2, place_id: 3 },
        },
        connection,
      ),
    ).rejects.toMatchObject({ code: "agenda_amigo_context_required" });
    expect(deps.execute).not.toHaveBeenCalled();
  });
  it("cancels external history through its original connection even after mode is disabled", async () => {
    const { db, rpc } = database({ active: false });
    await cancelarAgendamentoHandler(db, ctx, {
      id: "appointment",
      revision: 2,
      reason: "Paciente pediu",
    });
    expect(deps.execute).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "original", contactId: "contact" }),
      "attendance_cancel",
      { id: 9 },
      "durable-key",
    );
    expect(rpc.mock.calls.some(([name]) => name === "fn_appointment_change")).toBe(false);
    expect(db.rpc).toHaveBeenCalledWith("fn_calendar_amigo_target", {
      p_org: "org",
      p_id: "appointment",
      p_connection: "original",
    });
  });
  it("confirms externally; completion, local edits and combined mutations are explicit refusals", async () => {
    const { db, rpc } = database();
    await alterarAgendamentoHandler(db, ctx, {
      id: "appointment",
      revision: 2,
      status: "confirmed",
    });
    expect(deps.execute).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "original" }),
      "attendance_status",
      { attendance_id: 9, patient_id: 4, status: "confirmed" },
      "durable-key",
    );
    for (const input of [
      { status: "completed" },
      { notes: "internal" },
      { status: "confirmed", starts_at: "2026-11-10T13:00:00Z" },
    ]) {
      await expect(
        changeAmigoAppointment(db, ctx, external, input, "change"),
      ).rejects.toMatchObject({ code: "agenda_amigo_unsupported_change" });
    }
    expect(rpc.mock.calls.some(([name]) => name === "fn_appointment_change")).toBe(false);
  });
  it("resolves missing human role from active org membership; missing membership fails closed", async () => {
    const human = { ...ctx, actor: { type: "user" as const, id: "staff" } };
    await cancelarAgendamentoHandler(database({ membershipRole: "agent" }).db, human, {
      id: "appointment",
      revision: 2,
      reason: "Paciente pediu",
    });
    expect(deps.execute).toHaveBeenCalledWith(
      expect.objectContaining({ role: "agent" }),
      "attendance_cancel",
      { id: 9 },
      "durable-key",
    );
    deps.execute.mockClear();
    await expect(
      cancelarAgendamentoHandler(database().db, human, {
        id: "appointment",
        reason: "Paciente pediu",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(deps.execute).not.toHaveBeenCalled();
  });
  it("reschedules externally preserving attendance ID and rejects stale revision before calling the provider", async () => {
    const { db } = database({ active: false });
    await alterarAgendamentoHandler(db, ctx, {
      id: "appointment",
      revision: 2,
      starts_at: "2026-11-10T13:00:00Z",
    });
    expect(deps.execute).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "original" }),
      "attendance_reschedule",
      { id: 9, date: "2026-11-10 10:00" },
      "durable-key",
    );
    deps.execute.mockClear();
    await expect(
      alterarAgendamentoHandler(db, ctx, { id: "appointment", revision: 1, status: "confirmed" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(deps.execute).not.toHaveBeenCalled();
  });
  it("preserves local historical cancellation while Amigo mode is active", async () => {
    const { db, rpc } = database({ appointment: local });
    await cancelarAgendamentoHandler(db, ctx, {
      id: "appointment",
      revision: 2,
      reason: "Paciente pediu",
    });
    expect(rpc).toHaveBeenCalledWith(
      "fn_appointment_change",
      expect.objectContaining({ p_id: "appointment" }),
    );
    expect(deps.execute).not.toHaveBeenCalled();
  });
  it("free-time lookup in active mode gives actionable context instead of local slots", async () => {
    const { db, calls } = database();
    const result = await horariosLivresDaOrg(db, "org", {
      eventTypeId: "type",
      de: new Date("2026-11-09T13:00:00Z"),
      ate: new Date("2026-11-10T13:00:00Z"),
      agora: new Date(),
    });
    expect(result).toMatchObject({
      ok: false,
      codigo: "amigo_context_required",
      provider: "amigo",
    });
    expect(calls.some((c) => c.table === "attendant_availability")).toBe(false);
  });
  it("lists origin and remote status and exposes provider context with types", async () => {
    const { db } = database({
      appointment: {
        ...external,
        external_status: "scheduled",
        starts_at: "2026-11-09T13:00:00Z",
        ends_at: "2026-11-09T13:30:00Z",
      },
    });
    expect(await listaAgendamentos(db, "org", { contactId: "contact", limite: 20 })).toMatchObject({
      ok: true,
      agendamentos: [
        expect.objectContaining({
          authority: "amigo",
          external_status: "scheduled",
          external_connection_id: "original",
        }),
      ],
    });
    expect(await listaTiposDeAtendimento(db, "org")).toMatchObject({
      ok: true,
      provider: "amigo",
      provider_context: expect.objectContaining({ connection_id: "connection" }),
    });
  });
});
